// ============================================================
// JDoom — Main Entry Point
// Reference: d_main.c (D_DoomLoop, D_Display, D_ProcessEvents)
// ============================================================

import { loadWAD, WAD } from "./wad";
import { initTables } from "./math";
import { PaletteData } from "./palette";
import { TextureData } from "./textures";
import { GameMap } from "./map";
import {
  initRenderer,
  setViewPosition,
  renderFrame,
  setPspritePlayer,
  cycleRenderMode,
  getRenderMode,
  resolveGBuffer,
  drawPSprites,
  renderDepthOverlay,
} from "./render/renderer";
// draw.ts used for SCREENWIDTH/SCREENHEIGHT/rgbaBuffer imports
import { gBuffer } from "./render/gbuffer";
import { runPostProcess, addPostProcessPass } from "./render/postprocess";
import { updateDynLights, clearDynLights, spawnStaticLights, dynamicLightsPass, setDynLightView } from "./render/dynlights";
import { lightSmoothPass } from "./render/lightsmooth";
import { ssaoPass } from "./render/ssao";
import {
  SCREENWIDTH,
  SCREENHEIGHT,
  rgbaBuffer,
  setResolution,
} from "./render/draw";
import { initInput } from "./game/input";
import { Player, PlayerState } from "./game/player";
import { GameLoop } from "./game/loop";
import { StatusBar } from "./hud/statusbar";
import { MenuSystem, RESOLUTIONS } from "./menu/menu";
import { runThinkers, tickLevelTime, clearThinkers } from "./game/thinkers";
import { initSpecials, initSwitchList, setPlayerRef } from "./game/specials";
import {
  initAnimations,
  initThingAnimations,
  updateAnimations,
  updateThingAnimations,
} from "./game/animations";
import { clearRemovedThings } from "./game/pickups";
import { updatePaletteFlash, resetPaletteFlash, applyScreenTint } from "./game/palette_flash";
import {
  initMapObjects,
  updateMonsterDeaths,
  clearDroppedItems,
} from "./game/mobj";
import { setCombatMap, setCombatPlayer } from "./game/combat";
import { updateVfx, clearVfx } from "./game/vfx";
import {
  wipeStartCapture,
  wipeEndCapture,
  isWipeActive,
  wipeTick,
} from "./render/wipe";
import {
  spawnSectorLights,
  saveSectorState,
  restoreSectorState,
} from "./game/lights";
import {
  captureGameState,
  applyGameState,
  saveToSlot,
  loadFromSlot,
  parseDsgFile,
  GameSaveData,
} from "./game/savegame";
import { loadSettings, getResolutionIndex } from "./game/settings";
import {
  GameState,
  GameAction,
  gamestate,
  gameaction,
  menuactive,
  usergame,
  wipegamestate,
  setGameState,
  setGameAction,
  setMenuActive,
  setUserGame,
  setWipeGameState,
  forceWipe,
  pendingSaveSlot,
  pendingDsgFile,
  setPendingDsgFile,
} from "./game/gamestate";

// ---- Module refs ----
let wad: WAD;
let palData: PaletteData;
let texDataRef: TextureData;
let mapRef: GameMap;
let player: Player;
let statusBar: StatusBar;
let loop: GameLoop;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let imageData: ImageData;
let imageBuffer: Uint32Array;
let fpsDiv: HTMLDivElement;
let menu: MenuSystem;
let inputInitialized = false;

// ============================================================
// Canvas
// ============================================================

function createCanvas(): void {
  canvas = document.getElementById("doom") as HTMLCanvasElement;
  ctx = canvas.getContext("2d")!;
  // Canvas internal resolution = render resolution (always 8:5 like original DOOM)
  canvas.width = SCREENWIDTH;
  canvas.height = SCREENHEIGHT;
  imageData = ctx.createImageData(SCREENWIDTH, SCREENHEIGHT);
  imageBuffer = new Uint32Array(imageData.data.buffer);
  // Fit canvas to viewport with correct aspect ratio
  fitCanvasToViewport();
}

/** Scale canvas CSS size to fill viewport while maintaining render aspect ratio */
function fitCanvasToViewport(): void {
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const aspect = SCREENWIDTH / SCREENHEIGHT; // render aspect ratio (8:5 = 1.6)

  let cssW: number, cssH: number;
  if (vpW / vpH > aspect) {
    // Viewport wider than render — pillarbox (fill height, center horizontally)
    cssH = vpH;
    cssW = Math.round(vpH * aspect);
  } else {
    // Viewport taller than render — letterbox (fill width, center vertically)
    cssW = vpW;
    cssH = Math.round(vpW / aspect);
  }
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
}

function changeResolution(w: number, h: number): void {
  setResolution(w, h);
  canvas.width = SCREENWIDTH;
  canvas.height = SCREENHEIGHT;
  imageData = ctx.createImageData(SCREENWIDTH, SCREENHEIGHT);
  imageBuffer = new Uint32Array(imageData.data.buffer);
  fitCanvasToViewport();
  if (usergame) {
    initRenderer(mapRef, texDataRef, palData, wad);
  }
}

// ============================================================
// Map initialization (shared by new game / load game / respawn)
// ============================================================

function initMapFresh(mapName: string): void {
  mapRef = new GameMap(wad, texDataRef, mapName);
  initRenderer(mapRef, texDataRef, palData, wad);

  if (!player) {
    player = new Player(mapRef);
  } else {
    (player as any).map = mapRef;
  }

  setPlayerRef(player);
  setPspritePlayer(player);
  setCombatPlayer(player);

  clearThinkers();
  clearRemovedThings();
  clearDroppedItems();
  clearVfx();
  initSpecials(mapRef);
  initSwitchList(texDataRef);
  saveSectorState(mapRef);
  spawnSectorLights(mapRef);

  initAnimations(
    (name: string) => texDataRef.flatNumForName(name),
    (name: string) => texDataRef.textureNumForName(name),
    texDataRef.flatList.length,
    texDataRef.textures.length
  );
  initThingAnimations(mapRef.things);

  initMapObjects(mapRef);
  setCombatMap(mapRef);
  resetPaletteFlash(palData);
  clearDynLights();
  spawnStaticLights(mapRef.things, (x, y) => mapRef.pointInSubsector(x, y));
}

function ensureInput(): void {
  if (!inputInitialized) {
    initInput(canvas);
    inputInitialized = true;
  }
}

function ensureStatusBar(): void {
  if (!statusBar) {
    statusBar = new StatusBar(wad, palData, texDataRef);
  }
}

// ============================================================
// G_Ticker — process deferred game actions (like DOOM's g_game.c)
// ============================================================

function G_Ticker(): void {
  // Process gameaction
  while (gameaction !== GameAction.ga_nothing) {
    switch (gameaction) {
      case GameAction.ga_newgame:
        G_DoNewGame();
        break;
      case GameAction.ga_loadgame:
        G_DoLoadGame();
        break;
      case GameAction.ga_savegame:
        G_DoSaveGame();
        break;
      default:
        setGameAction(GameAction.ga_nothing);
        break;
    }
  }
}

/** G_DoNewGame — start a fresh game */
function G_DoNewGame(): void {
  setGameAction(GameAction.ga_nothing);

  initMapFresh("E1M1");
  player.spawn();
  ensureInput();
  ensureStatusBar();

  setGameState(GameState.GS_LEVEL);
  setUserGame(true);
  forceWipe(); // force wipe transition even if already GS_LEVEL

  console.log("[main] New game started");
}

/** G_DoLoadGame — load from slot or .dsg file */
function G_DoLoadGame(): void {
  setGameAction(GameAction.ga_nothing);

  let data: GameSaveData | null = null;

  if (pendingDsgFile) {
    // Synchronous read not possible for File; defer via callback
    // This path is handled separately in loadDsgFileAsync
    return;
  }

  data = loadFromSlot(pendingSaveSlot);
  if (!data) {
    if (player) player.message = "No save in this slot.";
    return;
  }

  applyLoadedData(data);
}

/** G_DoSaveGame — save current state */
function G_DoSaveGame(): void {
  setGameAction(GameAction.ga_nothing);

  if (!usergame || !player || !mapRef) {
    console.warn("[main] Cannot save — not in game");
    return;
  }

  const slot = pendingSaveSlot;
  const slotLabel = slot === -1 ? "Quick" : `Slot ${slot}`;
  const description = `${mapRef.name} ${slotLabel}`;
  const data = captureGameState(player, mapRef, description);
  const ok = saveToSlot(slot, data);

  if (ok) {
    player.message = slot === -1 ? "Quicksave." : `Game saved to slot ${slot}.`;
  } else {
    player.message = "Save failed!";
  }
}

/** Apply loaded save data (shared by slot load and .dsg load) */
function applyLoadedData(data: GameSaveData): void {
  initMapFresh(data.mapName);
  ensureInput();
  ensureStatusBar();

  applyGameState(data, player, mapRef);

  setGameState(GameState.GS_LEVEL);
  setUserGame(true);
  forceWipe(); // force wipe transition even if already GS_LEVEL
  player.message = "Game loaded.";
  console.log(`[main] Game loaded: ${data.mapName} (${data.description})`);
}

/** Async .dsg file loading (File API requires async read) */
function loadDsgFileAsync(file: File): void {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const buffer = reader.result as ArrayBuffer;
      const data = parseDsgFile(buffer);
      applyLoadedData(data);
      console.log(`[main] Loaded .dsg file: ${file.name}`);
    } catch (e) {
      console.error("[main] Failed to parse .dsg:", e);
      if (player) player.message = "Failed to load .dsg file!";
    }
  };
  reader.readAsArrayBuffer(file);
}

// ============================================================
// F6 quicksave / F9 quickload helpers
// ============================================================

import { setPendingSaveSlot } from "./game/gamestate";

function quickSave(): void {
  if (!usergame || gamestate !== GameState.GS_LEVEL) return;
  setPendingSaveSlot(-1);
  setGameAction(GameAction.ga_savegame);
}

function quickLoad(): void {
  setPendingSaveSlot(-1);
  setGameAction(GameAction.ga_loadgame);
}

// ============================================================
// Main
// ============================================================

async function main() {
  const loadingEl = document.getElementById("loading")!;

  // Load saved settings (or use defaults)
  loadSettings();
  const savedRes = RESOLUTIONS[getResolutionIndex()] ?? RESOLUTIONS[3];
  setResolution(savedRes.w, savedRes.h);

  loadingEl.innerHTML = "";
  loadingEl.style.cssText = `
    position: fixed; inset: 0; display: flex; align-items: center;
    justify-content: center; background: #000; color: #b00;
    font-family: monospace; font-size: 24px; z-index: 10;
  `;
  loadingEl.textContent = "Loading DOOM1.WAD...";

  try {
    wad = await loadWAD("/DOOM.WAD");

    loadingEl.textContent = "Initializing math tables...";
    initTables();

    loadingEl.textContent = "Loading palette...";
    palData = new PaletteData(wad);

    loadingEl.textContent = "Loading textures...";
    texDataRef = new TextureData(wad);

    loadingEl.textContent = "Initializing...";
    createCanvas();

    // Register post-process passes (order matters)
    addPostProcessPass(ssaoPass);          // darken corners/crevices first
    addPostProcessPass(lightSmoothPass);   // smooth light boundaries
    addPostProcessPass(dynamicLightsPass); // then add dynamic lights on top

    // Create menu system
    menu = new MenuSystem(wad, palData, texDataRef);
    menu.setCurrentResolution(SCREENWIDTH, SCREENHEIGHT);
    menu.setCallbacks({
      onChangeResolution: (w, h) => {
        changeResolution(w, h);
        menu.setCurrentResolution(w, h);
      },
      onSaveGame: (slot: number) => {
        setPendingSaveSlot(slot);
        setGameAction(GameAction.ga_savegame);
      },
      onLoadGame: (slot: number) => {
        setPendingSaveSlot(slot);
        setGameAction(GameAction.ga_loadgame);
      },
      onLoadDsg: (file: File) => {
        menu.clearMenus();
        loadDsgFileAsync(file);
      },
    });

    // Hide loading screen
    loadingEl.style.display = "none";

    // Refit canvas on window resize
    window.addEventListener("resize", () => fitCanvasToViewport());

    // FPS overlay
    fpsDiv = document.createElement("div");
    fpsDiv.style.cssText =
      "position:fixed;top:8px;left:8px;color:#0f0;font:bold 14px monospace;z-index:100;text-shadow:1px 1px #000;pointer-events:none;";
    document.body.appendChild(fpsDiv);

    // ── Input routing (D_ProcessEvents → M_Responder / G_Responder) ──
    document.addEventListener(
      "keydown",
      (e) => {
        // Menu gets first crack at all input (like DOOM's M_Responder)
        const menuHandled = menu.handleKey(e.code, e.key);
        if (menuHandled) {
          e.preventDefault();
          e.stopPropagation();
          // If menu opened, exit pointer lock
          if (menuactive && document.pointerLockElement) {
            document.exitPointerLock();
          }
          return;
        }

        // Game input (only when playing and no menu)
        if (gamestate === GameState.GS_LEVEL && usergame && !menuactive) {
          // F5 — cycle render mode
          if (e.code === "F5") {
            e.preventDefault();
            cycleRenderMode();
            if (player) {
              player.message = `Render: ${
                { normal: "Normal", depth: "Depth Buffer" }[getRenderMode()]
              }`;
            }
          }

          // F6 — quicksave
          if (e.code === "F6") {
            e.preventDefault();
            quickSave();
          }

          // F9 — quickload
          if (e.code === "F9") {
            e.preventDefault();
            quickLoad();
          }
        }
      },
      true
    );

    // ── Game Loop (D_DoomLoop) ──────────────────────────────
    loop = new GameLoop(
      // ── Tick (35 Hz) — G_Ticker + P_Ticker ──
      () => {
        // M_Ticker — skull animation
        menu.tick();

        // G_Ticker — process deferred actions (ga_newgame, ga_loadgame, ga_savegame)
        G_Ticker();

        // P_Ticker — game logic (only in GS_LEVEL)
        if (gamestate === GameState.GS_LEVEL && usergame) {
          // Respawn check (player pressed Use while dead)
          // Full level reset — reload map from scratch (restores all sector
          // heights, doors, lifts, pickups, monsters to initial state)
          if (player.playerstate === PlayerState.REBORN && !isWipeActive()) {
            initMapFresh(mapRef.name);
            player.spawn();

            forceWipe(); // trigger wipe transition
          }

          if (!isWipeActive()) {
            player.tick();
            runThinkers();
            tickLevelTime();
            updateAnimations();
            updateThingAnimations();
            updateMonsterDeaths();
            updateVfx();
            updateDynLights();
            statusBar.tickMessage(player);
          } else {
            wipeTick();
          }
        }
      },

      // ── Draw (every frame) — D_Display ──
      () => {
        // Wipe trigger: if gamestate changed since last draw, start wipe
        if (gamestate !== wipegamestate && !isWipeActive()) {
          wipeStartCapture();

          // Render the new state for the wipe end frame (full pipeline)
          if (gamestate === GameState.GS_LEVEL && usergame) {
            setViewPosition(player.x, player.y, player.viewz, player.angle);
            renderFrame();
            resolveGBuffer();
            drawPSprites();
            statusBar.draw(player);
            applyScreenTint();
            setDynLightView(player.x, player.y, player.viewz);
            runPostProcess(rgbaBuffer, gBuffer, SCREENWIDTH, SCREENHEIGHT);
          } else {
            menu.drawTitleScreen();
          }

          wipeEndCapture();
          setWipeGameState(gamestate);
        }

        if (isWipeActive()) {
          // Wipe in progress — menu can be drawn on top (like DOOM)
          if (menuactive) menu.draw();
        } else {
          // Normal rendering based on gamestate
          switch (gamestate) {
            case GameState.GS_LEVEL:
              if (usergame) {
                setViewPosition(player.x, player.y, player.viewz, player.angle);
                updatePaletteFlash(player, palData);
                renderFrame();
                resolveGBuffer();
                if (getRenderMode() === 'depth') {
                  renderDepthOverlay();
                }
                drawPSprites();
                statusBar.draw(player);
                applyScreenTint();
                setDynLightView(player.x, player.y, player.viewz);
                runPostProcess(rgbaBuffer, gBuffer, SCREENWIDTH, SCREENHEIGHT);
              }
              break;

            case GameState.GS_DEMOSCREEN:
              menu.drawTitleScreen();
              break;
          }

          // M_Drawer — menu overlay on top of everything
          if (menuactive) {
            menu.draw();
          }
        }

        // Copy to canvas
        imageBuffer.set(rgbaBuffer);
        ctx.putImageData(imageData, 0, 0);

        // FPS
        fpsDiv.textContent = `${loop.fps} FPS`;
      }
    );

    loop.start();
    console.log("JDoom started!");
  } catch (err) {
    loadingEl.textContent = `Error: ${err}`;
    loadingEl.style.color = "#f00";
    console.error(err);
  }
}

main();
