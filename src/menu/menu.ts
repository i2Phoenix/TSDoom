// ============================================================
// Menu System — faithful port of m_menu.c
// All positions, patches, and logic match the original DOOM
// ============================================================

import { SCREENWIDTH, SCREENHEIGHT, rgbaBuffer } from '../render/draw';
import { PaletteData } from '../palette';
import { TextureData, Patch } from '../textures';
import { WAD } from '../wad';
import {
  GameState, GameAction,
  gamestate, menuactive, usergame,
  setMenuActive, setGameAction,
  setPendingSaveSlot, setPendingDsgFile,
} from '../game/gamestate';
import { setMouseSensitivity } from '../game/player';
import { rebuildLightTables } from '../render/renderer';
import {
  getResolutionIndex, getMouseSensitivityLevel, getTrueColor, getDynLights, getSsao,
  setResolutionIndex, setMouseSensitivityLevel, setTrueColor, setDynLights, setSsao,
} from '../game/settings';
import { setDynLightsEnabled } from '../render/dynlights';
import { setSsaoEnabled } from '../render/ssao';

// ── Resolution presets ───────────────────────────────────────
// Internal render resolutions — always 8:5 (original DOOM aspect ratio).
// The canvas CSS scales to fill the viewport with correct proportions.
export const RESOLUTIONS = [
  { label: '320x200', w: 320, h: 200 },
  { label: '640x400', w: 640, h: 400 },
  { label: '960x600', w: 960, h: 600 },
  { label: '1280x800', w: 1280, h: 800 },
];

// ── Original DOOM constants from m_menu.c ───────────────────
const SKULLXOFF = -32;
const LINEHEIGHT = 16;

// ── Menu item status (from menuitem_t.status) ───────────────
// 0 = not selectable, 1 = selectable, 2 = arrows (slider), -1 = empty line
type ItemStatus = -1 | 0 | 1 | 2;

// ── Menu item definition ────────────────────────────────────
interface MenuItemDef {
  status: ItemStatus;
  /** WAD lump name for this item's graphic (empty = no graphic drawn) */
  name: string;
  action: (choice: number) => void;
}

// ── Menu definition (mirrors menu_t from m_menu.c) ──────────
interface MenuDef {
  numitems: number;
  prevMenu: MenuDef | null;
  menuitems: MenuItemDef[];
  /** Custom draw routine called before generic item drawing */
  routine: (() => void) | null;
  x: number;
  y: number;
  lastOn: number;
}

// ── Menu System ─────────────────────────────────────────────
export class MenuSystem {
  private wad: WAD;
  private palData: PaletteData;
  private texData: TextureData;

  // Patch cache: lump name -> Patch
  private patchCache: Map<string, Patch> = new Map();

  // HUD font (STCFN033-STCFN095)
  private fontPatches: Map<number, Patch> = new Map();

  // Special graphics
  private titlePic: Patch | null = null;

  // ── State ─────────────────────────────────────────────────
  private itemOn = 0;          // currently selected item
  private whichSkull = 0;      // 0 or 1
  private skullAnimCounter = 0;
  private titleBlink = 0;

  // Message overlay (M_StartMessage)
  private messageString: string | null = null;
  private messageCallback: (() => void) | null = null;
  private messageNeedsInput = false;

  // Current active menu
  private currentMenu!: MenuDef;

  // Menu definitions
  private mainDef!: MenuDef;
  private optionsDef!: MenuDef;
  private loadDef!: MenuDef;
  private saveDef!: MenuDef;

  // Callbacks
  private onChangeResolution: ((w: number, h: number) => void) | null = null;
  private onSaveGame: ((slot: number) => void) | null = null;
  private onLoadGame: ((slot: number) => void) | null = null;
  private onLoadDsg: ((file: File) => void) | null = null;

  // Options state — initialized from settings (defaults or localStorage)
  private resolutionIndex = getResolutionIndex();
  private mouseSensitivity = getMouseSensitivityLevel();

  constructor(wad: WAD, palData: PaletteData, texData: TextureData) {
    this.wad = wad;
    this.palData = palData;
    this.texData = texData;
    this.loadGraphics();
    this.buildMenus();
    this.currentMenu = this.mainDef;

    // Apply loaded settings that need side effects
    setMouseSensitivity(this.mouseSensitivity);
    if (getTrueColor()) {
      this.palData.setTrueColorMode(true);
      rebuildLightTables();
    }
    setDynLightsEnabled(getDynLights());
    setSsaoEnabled(getSsao());
  }

  /** Apply saved resolution via callback (call after setCallbacks) */
  applySavedResolution(): void {
    const res = RESOLUTIONS[this.resolutionIndex];
    if (res) {
      this.onChangeResolution?.(res.w, res.h);
    }
  }

  // ── Load all needed WAD graphics ──────────────────────────
  private loadGraphics(): void {
    // TITLEPIC
    const titleIdx = this.wad.checkNumForName('TITLEPIC');
    if (titleIdx !== -1) {
      this.titlePic = this.texData.parsePatchLump(titleIdx);
    }

    // Pre-cache all menu patches we'll need
    const patchNames = [
      // Skull cursor
      'M_SKULL1', 'M_SKULL2',
      // Main menu
      'M_DOOM', 'M_NGAME', 'M_OPTION', 'M_LOADG', 'M_SAVEG', 'M_RDTHIS', 'M_QUITG',
      // Options menu
      'M_OPTTTL', 'M_ENDGAM', 'M_MESSG', 'M_DETAIL', 'M_SCRNSZ', 'M_MSENS', 'M_SVOL',
      // Options state patches
      'M_MSGON', 'M_MSGOFF', 'M_GDHIGH', 'M_GDLOW',
      // Thermometer pieces
      'M_THERML', 'M_THERMM', 'M_THERMR', 'M_THERMO',
    ];

    for (const name of patchNames) {
      const idx = this.wad.checkNumForName(name);
      if (idx !== -1) {
        this.patchCache.set(name, this.texData.parsePatchLump(idx));
      }
    }

    // HUD font (STCFN033-STCFN095, ASCII 33-95)
    for (let i = 33; i <= 95; i++) {
      const name = `STCFN${i.toString().padStart(3, '0')}`;
      const idx = this.wad.checkNumForName(name);
      if (idx !== -1) {
        this.fontPatches.set(i, this.texData.parsePatchLump(idx));
      }
    }
  }

  private getPatch(name: string): Patch | null {
    return this.patchCache.get(name) || null;
  }

  // ── Build menu definitions (mirrors m_menu.c structs) ─────
  private buildMenus(): void {
    // Main menu: x=97, y=64 (from MainDef)
    this.mainDef = {
      numitems: 6,
      prevMenu: null,
      menuitems: [
        { status: 1, name: 'M_NGAME',  action: () => this.doNewGame() },
        { status: 1, name: 'M_OPTION', action: () => this.setupNextMenu(this.optionsDef) },
        { status: 1, name: 'M_LOADG',  action: () => this.setupNextMenu(this.loadDef) },
        { status: 1, name: 'M_SAVEG',  action: () => this.doSaveGameMenu() },
        { status: 1, name: 'M_RDTHIS', action: () => {} },  // not implemented
        { status: 1, name: 'M_QUITG',  action: () => {} },  // browser -- no-op
      ],
      routine: () => this.drawMainMenuCustom(),
      x: 97,
      y: 64,
      lastOn: 0,
    };

    // Options menu: x=60, y=37
    this.optionsDef = {
      numitems: 7,
      prevMenu: this.mainDef,
      menuitems: [
        { status: 2,  name: '',  action: (choice) => this.sizeDisplay(choice) },  // Resolution
        { status: -1, name: '',  action: () => {} },  // thermo line
        { status: 2,  name: '',  action: (choice) => this.changeSensitivity(choice) },  // Mouse Sensitivity
        { status: -1, name: '',  action: () => {} },  // thermo line
        { status: 1,  name: '',  action: () => this.toggleColorMode() },  // Color Mode
        { status: 1,  name: '',  action: () => this.toggleDynLights() },  // Dynamic Lights
        { status: 1,  name: '',  action: () => this.toggleSsao() },       // SSAO
      ],
      routine: () => this.drawOptionsCustom(),
      x: 60,
      y: 37,
      lastOn: 0,
    };

    // Load Game menu: 6 slots + "Load .DSG" option
    this.loadDef = {
      numitems: 7,
      prevMenu: this.mainDef,
      menuitems: [
        { status: 1, name: '', action: () => this.doLoadGame(0) },
        { status: 1, name: '', action: () => this.doLoadGame(1) },
        { status: 1, name: '', action: () => this.doLoadGame(2) },
        { status: 1, name: '', action: () => this.doLoadGame(3) },
        { status: 1, name: '', action: () => this.doLoadGame(4) },
        { status: 1, name: '', action: () => this.doLoadGame(5) },
        { status: 1, name: '', action: () => this.triggerDsgFileInput() },
      ],
      routine: () => this.drawLoadSaveCustom(false),
      x: 80,
      y: 54,
      lastOn: 0,
    };

    // Save Game menu: 6 slots
    this.saveDef = {
      numitems: 6,
      prevMenu: this.mainDef,
      menuitems: [
        { status: 1, name: '', action: () => this.doSaveGame(0) },
        { status: 1, name: '', action: () => this.doSaveGame(1) },
        { status: 1, name: '', action: () => this.doSaveGame(2) },
        { status: 1, name: '', action: () => this.doSaveGame(3) },
        { status: 1, name: '', action: () => this.doSaveGame(4) },
        { status: 1, name: '', action: () => this.doSaveGame(5) },
      ],
      routine: () => this.drawLoadSaveCustom(true),
      x: 80,
      y: 54,
      lastOn: 0,
    };
  }

  // ── Menu actions (like M_NewGame, M_SaveGame, M_LoadSelect) ──

  /** M_NewGame — request new game via deferred action */
  private doNewGame(): void {
    this.clearMenus();
    setGameAction(GameAction.ga_newgame);
  }

  /**
   * M_SaveGame — check if saving is allowed, then show save menu.
   * Original DOOM: checks !usergame and gamestate != GS_LEVEL
   */
  private doSaveGameMenu(): void {
    if (!usergame) {
      this.startMessage("you can't save if you aren't playing!\n\npress a key.");
      return;
    }
    if (gamestate !== GameState.GS_LEVEL) {
      return;
    }
    this.setupNextMenu(this.saveDef);
  }

  /** M_DoSave — save to a specific slot */
  private doSaveGame(slot: number): void {
    this.onSaveGame?.(slot);
    this.clearMenus();
  }

  /** M_LoadSelect — load from a specific slot via deferred action */
  private doLoadGame(slot: number): void {
    setPendingSaveSlot(slot);
    this.clearMenus();
    setGameAction(GameAction.ga_loadgame);
  }

  // ── Message overlay (M_StartMessage) ──────────────────────

  private startMessage(msg: string, callback?: () => void): void {
    this.messageString = msg;
    this.messageCallback = callback ?? null;
    this.messageNeedsInput = true;
  }

  private clearMessage(): void {
    this.messageString = null;
    this.messageCallback = null;
    this.messageNeedsInput = false;
  }

  // ── Menu open/close (M_StartControlPanel / M_ClearMenus) ──

  /** M_StartControlPanel — open the menu */
  startControlPanel(): void {
    if (menuactive) return;
    setMenuActive(true);
    this.currentMenu = this.mainDef;
    this.itemOn = this.currentMenu.lastOn;

    // If in game, replace "New Game" with "Resume"
    if (usergame && gamestate === GameState.GS_LEVEL) {
      this.mainDef.menuitems[0] = {
        status: 1,
        name: 'M_NGAME',
        action: () => this.clearMenus(),
      };
    } else {
      this.mainDef.menuitems[0] = {
        status: 1,
        name: 'M_NGAME',
        action: () => this.doNewGame(),
      };
    }
  }

  /** M_ClearMenus — close all menus */
  clearMenus(): void {
    setMenuActive(false);
    this.clearMessage();
  }

  private setupNextMenu(menudef: MenuDef): void {
    this.currentMenu = menudef;
    this.itemOn = menudef.lastOn;
  }

  // ── Options: Screen Size ──────────────────────────────────
  private sizeDisplay(choice: number): void {
    if (choice === 0) {
      this.resolutionIndex = Math.max(0, this.resolutionIndex - 1);
    } else {
      this.resolutionIndex = Math.min(RESOLUTIONS.length - 1, this.resolutionIndex + 1);
    }
    this.applyResolution();
    setResolutionIndex(this.resolutionIndex);
  }

  // ── Options: Color Mode ────────────────────────────────────
  private toggleColorMode(): void {
    const newMode = !this.palData.trueColorMode;
    this.palData.setTrueColorMode(newMode);
    rebuildLightTables();
    setTrueColor(newMode);
  }

  private toggleDynLights(): void {
    const newMode = !getDynLights();
    setDynLights(newMode);
    setDynLightsEnabled(newMode);
  }

  private toggleSsao(): void {
    const newMode = !getSsao();
    setSsao(newMode);
    setSsaoEnabled(newMode);
  }

  // ── Options: Mouse Sensitivity ────────────────────────────
  private changeSensitivity(choice: number): void {
    if (choice === 0) {
      this.mouseSensitivity = Math.max(0, this.mouseSensitivity - 1);
    } else {
      this.mouseSensitivity = Math.min(9, this.mouseSensitivity + 1);
    }
    setMouseSensitivity(this.mouseSensitivity);
    setMouseSensitivityLevel(this.mouseSensitivity);
  }

  // ── Register callbacks ──────────────────────────────────
  setCallbacks(callbacks: {
    onChangeResolution: (w: number, h: number) => void;
    onSaveGame?: (slot: number) => void;
    onLoadGame?: (slot: number) => void;
    onLoadDsg?: (file: File) => void;
  }): void {
    this.onChangeResolution = callbacks.onChangeResolution;
    this.onSaveGame = callbacks.onSaveGame ?? null;
    this.onLoadGame = callbacks.onLoadGame ?? null;
    this.onLoadDsg = callbacks.onLoadDsg ?? null;
  }

  setCurrentResolution(w: number, h: number): void {
    const idx = RESOLUTIONS.findIndex(r => r.w === w && r.h === h);
    if (idx !== -1) {
      this.resolutionIndex = idx;
    }
  }

  private applyResolution(): void {
    const res = RESOLUTIONS[this.resolutionIndex];
    this.onChangeResolution?.(res.w, res.h);
  }

  // ── Handle key input (M_Responder) ────────────────────────
  // Returns true if the key was consumed by the menu.
  // Called from main.ts in the input routing.

  handleKey(code: string, _key: string): boolean {
    // Message overlay consumes all keys
    if (this.messageString) {
      this.clearMessage();
      return true;
    }

    // If menu is not active, check for menu-opening keys
    if (!menuactive) {
      // On title screen, any key opens the menu
      if (gamestate === GameState.GS_DEMOSCREEN) {
        if (code !== 'F5' && code !== 'F11' && code !== 'F12') {
          this.startControlPanel();
          return true;
        }
        return false;
      }
      // In-game: ESC opens menu
      if (gamestate === GameState.GS_LEVEL) {
        if (code === 'Escape') {
          this.startControlPanel();
          return true;
        }
      }
      return false;
    }

    // Menu is active — handle navigation
    switch (code) {
      case 'ArrowUp':
      case 'KeyW': {
        do {
          this.itemOn = (this.itemOn - 1 + this.currentMenu.numitems) % this.currentMenu.numitems;
        } while (this.currentMenu.menuitems[this.itemOn].status === -1);
        return true;
      }
      case 'ArrowDown':
      case 'KeyS': {
        do {
          this.itemOn = (this.itemOn + 1) % this.currentMenu.numitems;
        } while (this.currentMenu.menuitems[this.itemOn].status === -1);
        return true;
      }
      case 'Enter':
      case 'Space': {
        const item = this.currentMenu.menuitems[this.itemOn];
        if (item.status >= 1) {
          this.currentMenu.lastOn = this.itemOn;
          item.action(this.itemOn);
        }
        return true;
      }
      case 'ArrowLeft':
      case 'KeyA': {
        const item = this.currentMenu.menuitems[this.itemOn];
        if (item.status === 2) {
          item.action(0);
          return true;
        }
        return false;
      }
      case 'ArrowRight':
      case 'KeyD': {
        const item = this.currentMenu.menuitems[this.itemOn];
        if (item.status === 2) {
          item.action(1);
          return true;
        }
        return false;
      }
      case 'Escape': {
        this.currentMenu.lastOn = this.itemOn;
        if (this.currentMenu.prevMenu) {
          this.setupNextMenu(this.currentMenu.prevMenu);
          return true;
        }
        // Main menu — close menu
        this.clearMenus();
        return true;
      }
    }

    return false;
  }

  // ── Tick (skull animation -- 8 tics between frames) ────────
  tick(): void {
    this.skullAnimCounter++;
    if (this.skullAnimCounter >= 8) {
      this.skullAnimCounter = 0;
      this.whichSkull = 1 - this.whichSkull;
    }
    this.titleBlink++;
  }

  // ── Draw title screen (called by main.ts for GS_DEMOSCREEN) ──
  drawTitleScreen(): void {
    if (this.titlePic) {
      this.drawPatchFullScreen(this.titlePic);
    } else {
      rgbaBuffer.fill(0xFF000000);
    }

    if (Math.floor(this.titleBlink / 17) % 2 === 0) {
      this.drawTextCentered('Press any key', 170);
    }
  }

  // ── Draw menu overlay (M_Drawer -- called only when menuactive) ──
  draw(): void {
    // If showing a message, draw only the message
    if (this.messageString) {
      this.drawMessageBox();
      return;
    }

    // If no game is running, draw TITLEPIC as background
    if (gamestate !== GameState.GS_LEVEL || !usergame) {
      if (this.titlePic) {
        this.drawPatchFullScreen(this.titlePic);
      } else {
        rgbaBuffer.fill(0xFF000000);
      }
    }
    // When gamestate === GS_LEVEL, main.ts already rendered the 3D scene behind us

    // Call custom draw routine (e.g. draw title patch, thermos)
    if (this.currentMenu.routine) {
      this.currentMenu.routine();
    }

    // Draw menu items -- each item's patch at (x, y + i*LINEHEIGHT)
    const scale = this.getScale();
    let y = this.currentMenu.y;
    for (let i = 0; i < this.currentMenu.numitems; i++) {
      const item = this.currentMenu.menuitems[i];
      if (item.name) {
        const patch = this.getPatch(item.name);
        if (patch) {
          this.drawPatchScaled(patch,
            Math.round(this.currentMenu.x * scale),
            Math.round(y * scale),
            scale);
        }
      }
      y += LINEHEIGHT;
    }

    // Draw skull cursor
    const skullName = this.whichSkull === 0 ? 'M_SKULL1' : 'M_SKULL2';
    const skull = this.getPatch(skullName);
    if (skull) {
      const skullX = Math.round((this.currentMenu.x + SKULLXOFF) * scale);
      const skullY = Math.round((this.currentMenu.y - 5 + this.itemOn * LINEHEIGHT) * scale);
      this.drawPatchScaled(skull, skullX, skullY, scale);
    }
  }

  // ── Message box draw ──────────────────────────────────────
  private drawMessageBox(): void {
    if (!this.messageString) return;

    // Draw TITLEPIC or game scene behind (main.ts handles game render)
    if (gamestate !== GameState.GS_LEVEL || !usergame) {
      if (this.titlePic) {
        this.drawPatchFullScreen(this.titlePic);
      } else {
        rgbaBuffer.fill(0xFF000000);
      }
    }

    // Draw message text centered
    const lines = this.messageString.split('\n');
    const scale = this.getScale();
    const lineH = Math.round(10 * scale);
    const startY = Math.round((100 - lines.length * 5) * scale);

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      if (text.length > 0) {
        const width = this.measureText(text, scale);
        const x = Math.round((SCREENWIDTH - width) / 2);
        this.drawText(text, x, startY + i * lineH, scale);
      }
    }
  }

  // ── Main Menu custom draw (M_DrawMainMenu) ──────────────
  private drawMainMenuCustom(): void {
    const scale = this.getScale();
    const mDoom = this.getPatch('M_DOOM');
    if (mDoom) {
      this.drawPatchScaled(mDoom,
        Math.round(94 * scale),
        Math.round(2 * scale),
        scale);
    }
  }

  // ── Options custom draw (M_DrawOptions) ─────────────────
  private drawOptionsCustom(): void {
    const scale = this.getScale();

    // Title
    const optTitle = this.getPatch('M_OPTTTL');
    if (optTitle) {
      this.drawPatchScaled(optTitle,
        Math.round(108 * scale),
        Math.round(15 * scale),
        scale);
    }

    // "RESOLUTION" label (item 0) — drawn as text since no WAD patch exists
    this.drawText(
      'RESOLUTION',
      Math.round(this.optionsDef.x * scale),
      Math.round(this.optionsDef.y * scale),
      scale
    );

    // Resolution thermometer (below item 0)
    this.drawThermo(
      this.optionsDef.x,
      this.optionsDef.y + LINEHEIGHT * 1,
      RESOLUTIONS.length,
      this.resolutionIndex
    );

    // Resolution value label
    const res = RESOLUTIONS[this.resolutionIndex];
    if (res) {
      this.drawText(
        res.label,
        Math.round((this.optionsDef.x + 170) * scale),
        Math.round(this.optionsDef.y * scale),
        scale
      );
    }

    // "MOUSE SENSITIVITY" label (item 2)
    this.drawText(
      'MOUSE SENSITIVITY',
      Math.round(this.optionsDef.x * scale),
      Math.round((this.optionsDef.y + LINEHEIGHT * 2) * scale),
      scale
    );

    // Mouse Sensitivity thermometer (below item 2)
    this.drawThermo(
      this.optionsDef.x,
      this.optionsDef.y + LINEHEIGHT * 3,
      10,
      this.mouseSensitivity
    );

    // "COLOR MODE" label + value (item 4)
    const colorY = this.optionsDef.y + LINEHEIGHT * 4;
    this.drawText(
      'COLOR MODE',
      Math.round(this.optionsDef.x * scale),
      Math.round(colorY * scale),
      scale
    );
    const modeLabel = this.palData.trueColorMode ? 'TRUECOLOR' : 'CLASSIC';
    this.drawText(
      modeLabel,
      Math.round((this.optionsDef.x + 160) * scale),
      Math.round(colorY * scale),
      scale
    );

    // "DYN LIGHTS" label + value (item 5)
    const dlY = this.optionsDef.y + LINEHEIGHT * 5;
    this.drawText(
      'DYN LIGHTS',
      Math.round(this.optionsDef.x * scale),
      Math.round(dlY * scale),
      scale
    );
    this.drawText(
      getDynLights() ? 'ON' : 'OFF',
      Math.round((this.optionsDef.x + 160) * scale),
      Math.round(dlY * scale),
      scale
    );

    // "SSAO" label + value (item 6)
    const ssaoY = this.optionsDef.y + LINEHEIGHT * 6;
    this.drawText(
      'SSAO',
      Math.round(this.optionsDef.x * scale),
      Math.round(ssaoY * scale),
      scale
    );
    this.drawText(
      getSsao() ? 'ON' : 'OFF',
      Math.round((this.optionsDef.x + 160) * scale),
      Math.round(ssaoY * scale),
      scale
    );
  }

  // ── Load/Save custom draw ──────────────────────────────
  private drawLoadSaveCustom(isSave: boolean): void {
    const scale = this.getScale();
    const titlePatch = this.getPatch(isSave ? 'M_SAVEG' : 'M_LOADG');
    if (titlePatch) {
      this.drawPatchScaled(titlePatch, Math.round(72 * scale), Math.round(28 * scale), scale);
    }

    const numSlots = isSave ? 6 : 7;
    const menu = isSave ? this.saveDef : this.loadDef;
    for (let i = 0; i < numSlots; i++) {
      const y = menu.y + LINEHEIGHT * i;
      let text: string;
      if (!isSave && i === 6) {
        text = 'LOAD .DSG FILE';
      } else {
        const info = this.getSlotDescription(i);
        text = info || `EMPTY SLOT ${i + 1}`;
      }
      this.drawText(text, Math.round(menu.x * scale), Math.round(y * scale), scale);
    }
  }

  private getSlotDescription(slot: number): string | null {
    try {
      const key = `jdoom_save_${slot}`;
      const json = localStorage.getItem(key);
      if (!json) return null;
      const data = JSON.parse(json);
      if (data.description) return data.description;
      if (data.mapName) return data.mapName;
      return null;
    } catch {
      return null;
    }
  }

  /** Open a file picker for .dsg files */
  private triggerDsgFileInput(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.dsg';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        this.onLoadDsg?.(file);
      }
    };
    input.click();
  }

  // ── Thermometer (M_DrawThermo from m_menu.c) ────────────
  private drawThermo(x: number, y: number, thermWidth: number, thermDot: number): void {
    const scale = this.getScale();
    let xx = x;

    const therml = this.getPatch('M_THERML');
    if (therml) {
      this.drawPatchScaled(therml, Math.round(xx * scale), Math.round(y * scale), scale);
    }
    xx += 8;

    const thermm = this.getPatch('M_THERMM');
    if (thermm) {
      for (let i = 0; i < thermWidth; i++) {
        this.drawPatchScaled(thermm, Math.round(xx * scale), Math.round(y * scale), scale);
        xx += 8;
      }
    }

    const thermr = this.getPatch('M_THERMR');
    if (thermr) {
      this.drawPatchScaled(thermr, Math.round(xx * scale), Math.round(y * scale), scale);
    }

    const thermo = this.getPatch('M_THERMO');
    if (thermo) {
      const dotX = (x + 8) + thermDot * 8;
      this.drawPatchScaled(thermo, Math.round(dotX * scale), Math.round(y * scale), scale);
    }
  }

  // ══════════════════════════════════════════════════════════
  //   Drawing utilities
  // ══════════════════════════════════════════════════════════

  private getScale(): number {
    return SCREENWIDTH / 320;
  }

  /** Draw a patch scaled to fill the entire screen (TITLEPIC) */
  private drawPatchFullScreen(patch: Patch): void {
    const pal = this.palData.rgbaLookup;
    const scaleX = SCREENWIDTH / patch.width;
    const scaleY = SCREENHEIGHT / patch.height;

    for (let sx = 0; sx < SCREENWIDTH; sx++) {
      const origCx = Math.min(Math.floor(sx / scaleX), patch.width - 1);
      const col = patch.columns[origCx];

      for (const post of col) {
        for (let dy = 0; dy < post.length; dy++) {
          const origY = post.topDelta + dy;
          const startSY = Math.floor(origY * scaleY);
          const endSY = Math.floor((origY + 1) * scaleY);
          for (let sy = startSY; sy < endSY; sy++) {
            if (sy >= 0 && sy < SCREENHEIGHT) {
              rgbaBuffer[sy * SCREENWIDTH + sx] = pal[post.data[dy]];
            }
          }
        }
      }
    }
  }

  /** Draw a patch with nearest-neighbor scaling. */
  private drawPatchScaled(patch: Patch, x: number, y: number, scale: number): void {
    const pal = this.palData.rgbaLookup;
    const drawX = x - Math.round(patch.leftOffset * scale);
    const drawY = y - Math.round(patch.topOffset * scale);
    const scaledW = Math.round(patch.width * scale);

    for (let sx = 0; sx < scaledW; sx++) {
      const screenX = drawX + sx;
      if (screenX < 0 || screenX >= SCREENWIDTH) continue;

      const origCx = Math.min(Math.floor(sx / scale), patch.width - 1);
      const col = patch.columns[origCx];

      for (const post of col) {
        for (let dy = 0; dy < post.length; dy++) {
          const origY = post.topDelta + dy;
          const startSY = Math.round(origY * scale);
          const endSY = Math.round((origY + 1) * scale);
          for (let sy = startSY; sy < endSY; sy++) {
            const screenY = drawY + sy;
            if (screenY < 0 || screenY >= SCREENHEIGHT) continue;
            rgbaBuffer[screenY * SCREENWIDTH + screenX] = pal[post.data[dy]];
          }
        }
      }
    }
  }

  /** Draw text using DOOM HUD font */
  private drawText(text: string, x: number, y: number, scale: number): void {
    let cx = x;
    const upper = text.toUpperCase();

    for (let i = 0; i < upper.length; i++) {
      const charCode = upper.charCodeAt(i);

      if (charCode === 32) {
        cx += Math.round(4 * scale);
        continue;
      }

      const patch = this.fontPatches.get(charCode);
      if (!patch) {
        cx += Math.round(4 * scale);
        continue;
      }

      this.drawPatchScaled(patch, cx, y, scale);
      cx += Math.round(patch.width * scale);
    }
  }

  /** Measure text width in pixels */
  private measureText(text: string, scale: number): number {
    let width = 0;
    const upper = text.toUpperCase();

    for (let i = 0; i < upper.length; i++) {
      const charCode = upper.charCodeAt(i);
      if (charCode === 32) {
        width += Math.round(4 * scale);
        continue;
      }
      const patch = this.fontPatches.get(charCode);
      width += patch ? Math.round(patch.width * scale) : Math.round(4 * scale);
    }
    return width;
  }

  /** Draw text centered horizontally */
  private drawTextCentered(text: string, origY: number): void {
    const scale = this.getScale();
    const width = this.measureText(text, scale);
    const x = Math.round((SCREENWIDTH - width) / 2);
    const y = Math.round(origY * scale);
    this.drawText(text, x, y, scale);
  }
}
