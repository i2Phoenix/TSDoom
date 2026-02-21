// ============================================================
// Menu System — faithful port of m_menu.c
// All positions, patches, and logic match the original DOOM
// ============================================================

import { SCREENWIDTH, SCREENHEIGHT, rgbaBuffer, getUIWidth, getUIOffsetX } from '../render/software/draw';
import { PaletteData } from '../palette';
import { TextureData, Patch } from '../textures';
import { WAD } from '../wad';
import { GameState, GameAction } from '../../game/gamestate';
import { GameInstance } from '../../game/game-instance';
import { setMouseSensitivity } from '../../game/player';
import { clearInputState } from '../../game/input-system';
import { SkillLevel, SKILL_NAMES } from '../../game/skill';
import { getRenderer } from '../../game/renderer-global';
import {
  getResolutionIndex, getMouseSensitivityLevel, getTrueColor, getDynLights,
  getSfxVolume, getMusicVolume, getFreelook,
  setResolutionIndex, setMouseSensitivityLevel, setTrueColor, setDynLights,
  setSfxVolume as setSfxVolumeSetting, setMusicVolume as setMusicVolumeSetting,
  setFreelook,
} from '../../game/settings';

import { S_StartSound, S_SetSfxVolume, S_SetMusicVolume, S_ChangeMusic, S_StopMusic } from '../sound/s_sound';
import { Sfx, Music } from '../../game/sounds';
import { renderEndoom, blitEndoomToScreen } from './endoom';

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
  private gi: GameInstance;

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
  private musicPreviewTimer: ReturnType<typeof setTimeout> | null = null;

  // "Read This!" help screen state
  private showingHelp = false;
  private helpPage = 0;  // 0 = HELP1, 1 = HELP2/CREDIT

  // ENDOOM quit screen state
  private showingEndoom = false;
  private endoomPixels: Uint32Array | null = null;

  // Message overlay (M_StartMessage)
  private messageString: string | null = null;
  private messageCallback: ((ch: string) => void) | null = null;
  private messageNeedsInput = false;

  // Current active menu
  private currentMenu!: MenuDef;

  // Menu definitions
  private mainDef!: MenuDef;
  private newgameDef!: MenuDef;
  private optionsDef!: MenuDef;
  private loadDef!: MenuDef;
  private saveDef!: MenuDef;

  // Callbacks
  private onChangeResolution: ((w: number, h: number) => void) | null = null;
  private onSaveGame: ((slot: number) => void) | null = null;
  private onLoadGame: ((slot: number) => void) | null = null;
  private onQuitGame: (() => void) | null = null;


  // Options state — initialized from settings (defaults or localStorage)
  private resolutionIndex = getResolutionIndex();
  private mouseSensitivity = getMouseSensitivityLevel();
  private sfxVolumeLevel = getSfxVolume();      // 0-10 (0%..100%)
  private musicVolumeLevel = getMusicVolume();   // 0-10 (0%..100%)

  constructor(wad: WAD, palData: PaletteData, texData: TextureData, gi: GameInstance) {
    this.wad = wad;
    this.palData = palData;
    this.texData = texData;
    this.gi = gi;
    this.loadGraphics();
    this.buildMenus();
    this.currentMenu = this.mainDef;

    // Apply loaded settings that need side effects
    setMouseSensitivity(this.mouseSensitivity);
    if (getTrueColor()) {
      this.palData.setTrueColorMode(true);
      getRenderer().rebuildLightTables();
    }
    getRenderer().setDynLightsEnabled(getDynLights());
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
      // New game / skill selection
      'M_NEWG', 'M_SKILL', 'M_JKILL', 'M_ROUGH', 'M_HURT', 'M_ULTRA', 'M_NMARE',
      // Options menu
      'M_OPTTTL', 'M_ENDGAM', 'M_MESSG', 'M_DETAIL', 'M_SCRNSZ', 'M_MSENS', 'M_SVOL',
      // Options state patches
      'M_MSGON', 'M_MSGOFF', 'M_GDHIGH', 'M_GDLOW',
      // Thermometer pieces
      'M_THERML', 'M_THERMM', 'M_THERMR', 'M_THERMO',
      // Save/Load slot border pieces
      'M_LSLEFT', 'M_LSCNTR', 'M_LSRGHT',
      // Help screens
      'HELP', 'HELP1', 'HELP2', 'CREDIT',
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
        { status: 1, name: 'M_NGAME',  action: () => this.setupNextMenu(this.newgameDef) },
        { status: 1, name: 'M_OPTION', action: () => this.setupNextMenu(this.optionsDef) },
        { status: 1, name: 'M_LOADG',  action: () => this.setupNextMenu(this.loadDef) },
        { status: 1, name: 'M_SAVEG',  action: () => this.doSaveGameMenu() },
        { status: 1, name: 'M_RDTHIS', action: () => this.showReadThis() },
        { status: 1, name: 'M_QUITG',  action: () => this.showEndoom() },
      ],
      routine: () => this.drawMainMenuCustom(),
      x: 97,
      y: 64,
      lastOn: 0,
    };

    // New Game skill selection: x=48, y=63 (matching original DOOM NewDef)
    this.newgameDef = {
      numitems: 5,
      prevMenu: this.mainDef,
      menuitems: [
        { status: 1, name: 'M_JKILL', action: () => this.chooseSkill(SkillLevel.sk_baby) },
        { status: 1, name: 'M_ROUGH', action: () => this.chooseSkill(SkillLevel.sk_easy) },
        { status: 1, name: 'M_HURT',  action: () => this.chooseSkill(SkillLevel.sk_medium) },
        { status: 1, name: 'M_ULTRA', action: () => this.chooseSkill(SkillLevel.sk_hard) },
        { status: 1, name: 'M_NMARE', action: () => this.chooseSkill(SkillLevel.sk_nightmare) },
      ],
      routine: () => this.drawNewGameCustom(),
      x: 48,
      y: 63,
      lastOn: 2, // default to "Hurt me plenty"
    };

    // Options menu: x=60, y=37
    this.optionsDef = {
      numitems: 7,
      prevMenu: this.mainDef,
      menuitems: [
        { status: 2,  name: '',  action: (choice) => this.sizeDisplay(choice) },          // 0: Resolution
        { status: 2,  name: '',  action: () => this.toggleColorMode() },                   // 1: Color Mode
        { status: 2,  name: '',  action: () => this.toggleDynLights() },                   // 2: Dynamic Lights
        { status: 2,  name: '',  action: () => this.toggleFreelook() },                    // 3: Freelook
        { status: 2,  name: '',  action: (choice) => this.changeSensitivity(choice) },     // 4: Mouse Sensitivity
        { status: 2,  name: '',  action: (choice) => this.changeSfxVolume(choice) },       // 5: SFX Volume
        { status: 2,  name: '',  action: (choice) => this.changeMusicVolume(choice) },     // 6: Music Volume
      ],
      routine: () => this.drawOptionsCustom(),
      x: 60,
      y: 37,
      lastOn: 0,
    };

    // Load Game menu: 6 slots
    this.loadDef = {
      numitems: 6,
      prevMenu: this.mainDef,
      menuitems: [
        { status: 1, name: '', action: () => this.doLoadGame(0) },
        { status: 1, name: '', action: () => this.doLoadGame(1) },
        { status: 1, name: '', action: () => this.doLoadGame(2) },
        { status: 1, name: '', action: () => this.doLoadGame(3) },
        { status: 1, name: '', action: () => this.doLoadGame(4) },
        { status: 1, name: '', action: () => this.doLoadGame(5) },

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
    this.gi.gameaction = GameAction.ga_newgame;
  }

  /** M_ChooseSkill — select skill and start new game.
   *  Nightmare shows a confirmation dialog (matching original DOOM). */
  private chooseSkill(skill: SkillLevel): void {
    if (skill === SkillLevel.sk_nightmare) {
      this.startMessage(
        'Are you sure? This skill level\n'
        + 'isn\'t even remotely fair.\n\n'
        + 'press y or n.',
        (ch: string) => {
          if (ch.toLowerCase() === 'y') {
            this.gi.pendingSkill = skill;
            this.doNewGame();
          }
        }
      );
      return;
    }
    this.gi.pendingSkill = skill;
    this.doNewGame();
  }

  /**
   * M_SaveGame — check if saving is allowed, then show save menu.
   * Original DOOM: checks !usergame and gamestate != GS_LEVEL
   */
  private doSaveGameMenu(): void {
    if (!this.gi.usergame) {
      this.startMessage("you can't save if you aren't playing!\n\npress a key.");
      return;
    }
    if (this.gi.gamestate !== GameState.GS_LEVEL) {
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
    this.gi.pendingSaveSlot = slot;
    this.clearMenus();
    this.gi.gameaction = GameAction.ga_loadgame;
  }

  // ── Read This! help screens (M_ReadThis / M_ReadThis2) ─────

  /** M_ReadThis — show first help page */
  private showReadThis(): void {
    this.showingHelp = true;
    this.helpPage = 0;
  }

  /** Open the help screen from outside (F1 key) */
  openHelpScreen(): void {
    this.gi.menuactive = true;
    this.showingHelp = true;
    this.helpPage = 0;
  }

  // ── ENDOOM quit screen ──────────────────────────────────────

  /** Show the ENDOOM text screen and prepare to quit */
  private showEndoom(): void {
    const lumpIdx = this.wad.checkNumForName('ENDOOM');
    if (lumpIdx === -1) {
      // No ENDOOM lump — just quit immediately
      if (this.onQuitGame) this.onQuitGame();
      return;
    }

    const data = this.wad.getLumpData(lumpIdx);
    const pixels = renderEndoom(data);
    if (!pixels) {
      if (this.onQuitGame) this.onQuitGame();
      return;
    }

    // Play quit sound
    S_StartSound(null, Sfx.swtchn);

    this.endoomPixels = pixels;
    this.showingEndoom = true;
  }

  /** Advance help page or close */
  private advanceHelpPage(): void {
    this.helpPage++;
    if (this.helpPage >= 2) {
      // Done showing help — return to main menu
      this.showingHelp = false;
      this.helpPage = 0;
    }
  }

  /** Draw the current help page fullscreen */
  private drawHelpPage(): void {
    let patchName: string;
    if (this.helpPage === 0) {
      // First page: HELP1 (shareware/registered) or HELP (Ultimate/commercial)
      patchName = this.getPatch('HELP1') ? 'HELP1' : 'HELP';
    } else {
      // Second page: HELP2 (shareware/registered) or CREDIT (Ultimate/commercial)
      patchName = this.getPatch('HELP2') ? 'HELP2' : 'CREDIT';
    }

    const patch = this.getPatch(patchName);
    if (patch) {
      this.drawPatchFullScreen(patch);
    } else if (this.titlePic) {
      this.drawPatchFullScreen(this.titlePic);
    } else {
      rgbaBuffer.fill(0xFF000000);
    }
  }

  // ── Message overlay (M_StartMessage) ──────────────────────

  private startMessage(msg: string, callback?: (ch: string) => void): void {
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
    if (this.gi.menuactive) return;
    this.gi.menuactive = true;
    clearInputState();
    this.currentMenu = this.mainDef;
    this.itemOn = this.currentMenu.lastOn;
    S_StartSound(null, Sfx.swtchn);

    // "New Game" always goes to skill selection
    this.mainDef.menuitems[0] = {
      status: 1,
      name: 'M_NGAME',
      action: () => this.setupNextMenu(this.newgameDef),
    };
  }

  /** M_ClearMenus — close all menus */
  clearMenus(): void {
    this.gi.menuactive = false;
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
    getRenderer().rebuildLightTables();
    setTrueColor(newMode);
  }

  private toggleDynLights(): void {
    const newMode = !getDynLights();
    setDynLights(newMode);
    getRenderer().setDynLightsEnabled(newMode);
  }

  private toggleFreelook(): void {
    const newMode = !getFreelook();
    setFreelook(newMode);
  }

  // ── Options: Mouse Sensitivity ────────────────────────────
  private changeSensitivity(choice: number): void {
    if (choice === 0) {
      this.mouseSensitivity = Math.max(0, this.mouseSensitivity - 1);
    } else {
      this.mouseSensitivity = Math.min(10, this.mouseSensitivity + 1);
    }
    setMouseSensitivity(this.mouseSensitivity);
    setMouseSensitivityLevel(this.mouseSensitivity);
  }

  // ── Options: SFX Volume ────────────────────────────────────
  private changeSfxVolume(choice: number): void {
    if (choice === 0) {
      this.sfxVolumeLevel = Math.max(0, this.sfxVolumeLevel - 1);
    } else {
      this.sfxVolumeLevel = Math.min(10, this.sfxVolumeLevel + 1);
    }
    // Convert 0-10 to 0-15 for sound system (DOOM uses 0-15 internally)
    S_SetSfxVolume(Math.round(this.sfxVolumeLevel * 1.5));
    setSfxVolumeSetting(this.sfxVolumeLevel);
  }

  // ── Options: Music Volume ──────────────────────────────────
  private changeMusicVolume(choice: number): void {
    if (choice === 0) {
      this.musicVolumeLevel = Math.max(0, this.musicVolumeLevel - 1);
    } else {
      this.musicVolumeLevel = Math.min(10, this.musicVolumeLevel + 1);
    }
    // Convert 0-10 to 0-15 for sound system
    S_SetMusicVolume(Math.round(this.musicVolumeLevel * 1.5));
    setMusicVolumeSetting(this.musicVolumeLevel);
    // Play preview music so user can hear the volume
    S_ChangeMusic(Music.introa, true);
    // Stop music 3 seconds after last adjustment
    if (this.musicPreviewTimer) clearTimeout(this.musicPreviewTimer);
    this.musicPreviewTimer = setTimeout(() => {
      S_StopMusic();
      this.musicPreviewTimer = null;
    }, 1000);
  }

  // ── Register callbacks ──────────────────────────────────
  setCallbacks(callbacks: {
    onChangeResolution: (w: number, h: number) => void;
    onSaveGame?: (slot: number) => void;
    onLoadGame?: (slot: number) => void;
    onQuitGame?: () => void;
  }): void {
    this.onChangeResolution = callbacks.onChangeResolution;
    this.onSaveGame = callbacks.onSaveGame ?? null;
    this.onLoadGame = callbacks.onLoadGame ?? null;
    this.onQuitGame = callbacks.onQuitGame ?? null;
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
      const cb = this.messageCallback;
      this.clearMessage();
      if (cb) cb(_key);
      return true;
    }

    // ENDOOM screen: any key triggers quit
    if (this.showingEndoom) {
      if (this.onQuitGame) this.onQuitGame();
      return true;
    }

    // Help screen: any key advances page or exits
    if (this.showingHelp) {
      this.advanceHelpPage();
      return true;
    }

    // If menu is not active, check for menu-opening keys
    if (!this.gi.menuactive) {
      // On title screen, any key opens the menu
      if (this.gi.gamestate === GameState.GS_DEMOSCREEN) {
        if (code !== 'F5' && code !== 'F11' && code !== 'F12') {
          this.startControlPanel();
          return true;
        }
        return false;
      }
      // In-game: ESC opens menu
      if (this.gi.gamestate === GameState.GS_LEVEL) {
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
        S_StartSound(null, Sfx.pstop);
        return true;
      }
      case 'ArrowDown':
      case 'KeyS': {
        do {
          this.itemOn = (this.itemOn + 1) % this.currentMenu.numitems;
        } while (this.currentMenu.menuitems[this.itemOn].status === -1);
        S_StartSound(null, Sfx.pstop);
        return true;
      }
      case 'Space':
      case 'Enter':
      case 'Control':
      case 'ControlLeft': {
        const item = this.currentMenu.menuitems[this.itemOn];
        if (item.status >= 1) {
          this.currentMenu.lastOn = this.itemOn;
          S_StartSound(null, Sfx.pistol);
          item.action(this.itemOn);
        }
        return true;
      }
      case 'ArrowLeft':
      case 'KeyA': {
        const item = this.currentMenu.menuitems[this.itemOn];
        if (item.status === 2) {
          S_StartSound(null, Sfx.stnmov);
          item.action(0);
          return true;
        }
        return false;
      }
      case 'ArrowRight':
      case 'KeyD': {
        const item = this.currentMenu.menuitems[this.itemOn];
        if (item.status === 2) {
          S_StartSound(null, Sfx.stnmov);
          item.action(1);
          return true;
        }
        return false;
      }
      case 'Escape': {
        this.currentMenu.lastOn = this.itemOn;
        S_StartSound(null, Sfx.swtchx);
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

  // ── Gamepad state for edge-triggered menu input ────────────
  private prevGamepadButtons: boolean[] = [];

  // ── Tick (skull animation -- 8 tics between frames) ────────
  tick(): void {
    this.skullAnimCounter++;
    if (this.skullAnimCounter >= 8) {
      this.skullAnimCounter = 0;
      this.whichSkull = 1 - this.whichSkull;
    }
    this.titleBlink++;

    // Poll gamepad for menu navigation
    this.pollGamepad();
  }

  /** Poll gamepad and feed edge-triggered presses to handleKey */
  private pollGamepad(): void {
    const gamepads = navigator.getGamepads();
    const gp = gamepads[0];
    if (!gp) return;

    const curr = gp.buttons.map(b => b.pressed);
    const prev = this.prevGamepadButtons;

    // Helper: true only on press edge (not held)
    const justPressed = (idx: number) => curr[idx] && !prev[idx];

    // Map gamepad buttons to menu key codes
    // D-pad: 12=Up, 13=Down, 14=Left, 15=Right
    if (justPressed(12)) this.handleKey('ArrowUp', '');
    if (justPressed(13)) this.handleKey('ArrowDown', '');
    if (justPressed(14)) this.handleKey('ArrowLeft', '');
    if (justPressed(15)) this.handleKey('ArrowRight', '');

    // A button (0) = confirm
    if (justPressed(0)) this.handleKey('Enter', '');
    // B button (1) = back/escape
    if (justPressed(1)) this.handleKey('Escape', '');
    // Start button (9) = open/close menu
    if (justPressed(9)) this.handleKey('Escape', '');

    this.prevGamepadButtons = curr;
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
    // If showing ENDOOM, draw it fullscreen
    if (this.showingEndoom && this.endoomPixels) {
      blitEndoomToScreen(this.endoomPixels, rgbaBuffer, SCREENWIDTH, SCREENHEIGHT);
      return;
    }

    // If showing help pages, draw them fullscreen
    if (this.showingHelp) {
      this.drawHelpPage();
      return;
    }

    // If showing a message, draw only the message
    if (this.messageString) {
      this.drawMessageBox();
      return;
    }

    // If no game is running, draw TITLEPIC as background
    if (this.gi.gamestate !== GameState.GS_LEVEL || !this.gi.usergame) {
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
    if (this.gi.gamestate !== GameState.GS_LEVEL || !this.gi.usergame) {
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
        const x = Math.round((getUIWidth() - width) / 2);
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

  // ── New Game (skill select) custom draw ──────────────────
  // Matches M_DrawNewGame: M_NEWG at (96,14), M_SKILL at (54,38)
  // Skill items (M_JKILL etc.) drawn automatically by the menu loop
  private drawNewGameCustom(): void {
    const scale = this.getScale();

    // Title "NEW GAME"
    const ngPatch = this.getPatch('M_NEWG');
    if (ngPatch) {
      this.drawPatchScaled(ngPatch,
        Math.round(96 * scale),
        Math.round(14 * scale),
        scale);
    }

    // Subtitle "Choose Skill Level:"
    const skillPatch = this.getPatch('M_SKILL');
    if (skillPatch) {
      this.drawPatchScaled(skillPatch,
        Math.round(54 * scale),
        Math.round(38 * scale),
        scale);
    }
  }

  // ── Options custom draw (M_DrawOptions) ─────────────────
  private drawOptionsCustom(): void {
    const scale = this.getScale();
    const x = this.optionsDef.x;
    const y0 = this.optionsDef.y;
    const valX = x + 160;

    // Title
    const optTitle = this.getPatch('M_OPTTTL');
    if (optTitle) {
      this.drawPatchScaled(optTitle,
        Math.round(108 * scale),
        Math.round(15 * scale),
        scale);
    }

    // Item 0: RESOLUTION
    this.drawText('RESOLUTION', Math.round(x * scale), Math.round(y0 * scale), scale);
    const res = RESOLUTIONS[this.resolutionIndex];
    if (res) {
      this.drawText(res.label, Math.round(valX * scale), Math.round(y0 * scale), scale);
    }

    // Item 1: COLOR MODE
    const y1 = y0 + LINEHEIGHT;
    this.drawText('COLOR MODE', Math.round(x * scale), Math.round(y1 * scale), scale);
    this.drawText(
      this.palData.trueColorMode ? 'TRUECOLOR' : 'CLASSIC',
      Math.round(valX * scale), Math.round(y1 * scale), scale
    );

    // Item 2: DYN LIGHTS
    const y2 = y0 + LINEHEIGHT * 2;
    this.drawText('DYN LIGHTS', Math.round(x * scale), Math.round(y2 * scale), scale);
    this.drawText(
      getDynLights() ? 'ON' : 'OFF',
      Math.round(valX * scale), Math.round(y2 * scale), scale
    );

    // Item 3: FREELOOK
    const y3 = y0 + LINEHEIGHT * 3;
    this.drawText('FREELOOK', Math.round(x * scale), Math.round(y3 * scale), scale);
    this.drawText(
      getFreelook() ? 'ON' : 'OFF',
      Math.round(valX * scale), Math.round(y3 * scale), scale
    );

    // Item 4: MOUSE SENSITIVITY
    const y4 = y0 + LINEHEIGHT * 4;
    this.drawText('MOUSE SENSITIVITY', Math.round(x * scale), Math.round(y4 * scale), scale);
    this.drawText(
      `${this.mouseSensitivity * 10}%`,
      Math.round(valX * scale), Math.round(y4 * scale), scale
    );

    // Item 5: SFX VOLUME
    const y5 = y0 + LINEHEIGHT * 5;
    this.drawText('SFX VOLUME', Math.round(x * scale), Math.round(y5 * scale), scale);
    this.drawText(
      `${this.sfxVolumeLevel * 10}%`,
      Math.round(valX * scale), Math.round(y5 * scale), scale
    );

    // Item 6: MUSIC VOLUME
    const y6 = y0 + LINEHEIGHT * 6;
    this.drawText('MUSIC VOLUME', Math.round(x * scale), Math.round(y6 * scale), scale);
    this.drawText(
      `${this.musicVolumeLevel * 10}%`,
      Math.round(valX * scale), Math.round(y6 * scale), scale
    );
  }

  // ── Save/Load slot border (M_DrawSaveLoadBorder) ───────
  private drawSaveLoadBorder(x: number, y: number): void {
    const scale = this.getScale();
    const left = this.getPatch('M_LSLEFT');
    if (left) {
      this.drawPatchScaled(left, Math.round((x - 8) * scale), Math.round((y + 7) * scale), scale);
    }

    let xx = x;
    const center = this.getPatch('M_LSCNTR');
    if (center) {
      for (let i = 0; i < 24; i++) {
        this.drawPatchScaled(center, Math.round(xx * scale), Math.round((y + 7) * scale), scale);
        xx += 8;
      }
    }

    const right = this.getPatch('M_LSRGHT');
    if (right) {
      this.drawPatchScaled(right, Math.round(xx * scale), Math.round((y + 7) * scale), scale);
    }
  }

  // ── Load/Save custom draw ──────────────────────────────
  private drawLoadSaveCustom(isSave: boolean): void {
    const scale = this.getScale();
    const titlePatch = this.getPatch(isSave ? 'M_SAVEG' : 'M_LOADG');
    if (titlePatch) {
      this.drawPatchScaled(titlePatch, Math.round(72 * scale), Math.round(28 * scale), scale);
    }

    const numSlots = 6;
    const menu = isSave ? this.saveDef : this.loadDef;
    for (let i = 0; i < numSlots; i++) {
      const y = menu.y + LINEHEIGHT * i;
      // Draw slot background border (M_DrawSaveLoadBorder)
      this.drawSaveLoadBorder(menu.x, y);
      const info = this.getSlotDescription(i);
      const text = info || `EMPTY SLOT ${i + 1}`;
      this.drawText(text, Math.round(menu.x * scale), Math.round(y * scale), scale);
    }
  }

  private getSlotDescription(slot: number): string | null {
    try {
      const key = `tsdoom_save_${slot}`;
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
    return getUIWidth() / 320;
  }

  /** Draw a patch scaled to fill the UI area (centered in widescreen) */
  private drawPatchFullScreen(patch: Patch): void {
    const pal = this.palData.rgbaLookup;
    const offsetX = getUIOffsetX();
    const uiWidth = getUIWidth();
    const scaleX = uiWidth / patch.width;
    const scaleY = SCREENHEIGHT / patch.height;

    // Clear full screen (widescreen side bars)
    rgbaBuffer.fill(0xFF000000);

    for (let sx = 0; sx < uiWidth; sx++) {
      const origCx = Math.min(Math.floor(sx / scaleX), patch.width - 1);
      const col = patch.columns[origCx];

      for (const post of col) {
        for (let dy = 0; dy < post.length; dy++) {
          const origY = post.topDelta + dy;
          const startSY = Math.floor(origY * scaleY);
          const endSY = Math.floor((origY + 1) * scaleY);
          for (let sy = startSY; sy < endSY; sy++) {
            if (sy >= 0 && sy < SCREENHEIGHT) {
              rgbaBuffer[sy * SCREENWIDTH + (offsetX + sx)] = pal[post.data[dy]];
            }
          }
        }
      }
    }
  }

  /** Draw a patch with nearest-neighbor scaling. */
  private drawPatchScaled(patch: Patch, x: number, y: number, scale: number): void {
    const pal = this.palData.rgbaLookup;
    const drawX = x + getUIOffsetX() - Math.round(patch.leftOffset * scale);
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
    const x = Math.round((getUIWidth() - width) / 2);
    const y = Math.round(origY * scale);
    this.drawText(text, x, y, scale);
  }
}
