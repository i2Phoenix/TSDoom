// ============================================================
// TSDoom — Main Entry Point
// Reference: d_main.c (D_DoomLoop, D_Display, D_ProcessEvents)
// ============================================================

import { loadWAD, WAD } from "./wad";
import { initTables } from "../game/math";
import { PaletteData } from "./palette";
import { TextureData } from "./textures";
import { GameMap } from "./map";
import { SoftwareRenderer } from "./render/software/software-renderer";
import { setRenderer, getRenderer } from "../game/renderer-global";
// draw.ts used for SCREENWIDTH/SCREENHEIGHT/rgbaBuffer imports
import { gBuffer } from "./render/software/gbuffer";
import { runPostProcess } from "./render/software/postprocess";
import {
  SCREENWIDTH,
  SCREENHEIGHT,
  rgbaBuffer,
  setResolution,
} from "./render/software/draw";
import { initBrowserInput } from "./input-browser";
import { toggleProfiler, profilerFrameStart, profilerFrameEnd, profilerTickStart, profilerTickEnd, profilerBegin, profilerEnd, drawProfilerOverlay, isProfilerVisible } from "../game/profiler";
import { Player, PlayerState } from "../game/player";
import { GameLoop } from "./game/loop";
import { createBrowserClock } from "../game/clock";
import { StatusBar } from "./hud/statusbar";
import { MenuSystem, RESOLUTIONS } from "./menu/menu";
import { runThinkers, tickLevelTime, clearThinkers } from "../game/thinkers";
import { initSpecials, initSwitchList } from "../game/specials";
import { initWorld } from "../game/world";
import {
  initAnimations,
  initScrollLines,
  initThingAnimations,
  updateAnimations,
  updateThingAnimations,
} from "../game/animations";
import { clearRemovedThings } from "../game/pickups";
import { updatePaletteFlash, resetPaletteFlash, applyScreenTint } from "./game/palette_flash";
import {
  initMapObjects,
  updateMonsterDeaths,
  updateMobjFloorZ,
  tickMonsterRespawn,
  clearDroppedItems,
} from "../game/mobj";

import { initAICallbacks, updatePlayerMobj, initEnemyAI } from "../game/enemy";
import { updateVfx, clearVfx } from "../game/vfx";
import { feedCheatKey, resetCheatBuffer } from "../game/cheats";
import { updateProjectiles, clearProjectiles } from "../game/projectiles";
import { setGameSkill } from "../game/skill";
import { S_Init, S_Start, S_UpdateSounds, S_SetListener, S_ResumeSound, S_ChangeMusic } from "./sound/s_sound";
import { Music } from "../game/sounds";
import { I_ResumeAudioContext } from "./sound/i_sound";
import { initClientEffects } from "./effects-client";
import {
  wipeStartCapture,
  wipeEndCapture,
  isWipeActive,
  wipeTick,
} from "./render/software/wipe";
import {
  spawnSectorLights,
  saveSectorState,
  restoreSectorState,
} from "../game/lights";
import {
  captureGameState,
  applyGameState,
  saveToSlot,
  loadFromSlot,
  GameSaveData,
} from "../game/savegame";
import { loadSettings, getResolutionIndex, getSfxVolume, getMusicVolume } from "../game/settings";
import {
  GameState,
  GameAction,
  gamestate,
  gameaction,
  menuactive,
  usergame,
  wipegamestate,
  secretExit,
  setGameState,
  setGameAction,
  setMenuActive,
  setUserGame,
  setWipeGameState,
  forceWipe,
  pendingSaveSlot,
  pendingWarpMap,
  pendingSkill,
} from "../game/gamestate";
import { getNextMap, parseMapName } from "../game/mapflow";
import { Intermission, WBStartStruct, resetLevelStats, totalKills, totalItems, totalSecrets, playerKills, playerItems, playerSecrets, addTotalItem, addTotalSecret } from "./game/intermission";
import { levelTime } from "../game/thinkers";
import { Finale, FinaleConfig, getFinaleConfig } from "./game/finale";

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
let profilerDiv: HTMLDivElement;
let imageBuffer: Uint32Array;
let fpsDiv: HTMLDivElement;
let menu: MenuSystem;
let inputInitialized = false;
let intermission: Intermission | null = null;
let finale: Finale | null = null;
let pendingNextMap: string = '';

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
    (getRenderer() as SoftwareRenderer).init(mapRef, texDataRef, palData, wad);
  }
}

// ============================================================
// Map initialization (shared by new game / load game / respawn)
// ============================================================

function initMapFresh(mapName: string): void {
  mapRef = new GameMap(wad, texDataRef, mapName);
  (getRenderer() as SoftwareRenderer).init(mapRef, texDataRef, palData, wad);

  if (!player) {
    player = new Player(mapRef);
  } else {
    (player as any).map = mapRef;
  }

  initWorld(mapRef, player);
  (getRenderer() as SoftwareRenderer).setWeaponPlayer(player);

  clearThinkers();
  clearRemovedThings();
  clearDroppedItems();
  clearVfx();
  clearProjectiles();
  initSpecials();
  initSwitchList(
    (name) => texDataRef.textureNumForName(name),
    (idx) => texDataRef.textures[idx]?.height ?? 0,
  );
  saveSectorState(mapRef);
  spawnSectorLights(mapRef);

  initAnimations(
    (name: string) => texDataRef.flatNumForName(name),
    (name: string) => texDataRef.textureNumForName(name),
    texDataRef.flatList.length,
    texDataRef.textures.length
  );
  initThingAnimations(mapRef.things);
  initScrollLines(mapRef.linedefs, mapRef.sidedefs);

  initMapObjects();
  initEnemyAI();
  initAICallbacks();
  resetPaletteFlash(palData);
  getRenderer().clearLights();
  getRenderer().spawnStaticLights(mapRef.things, (x, y) => mapRef.pointInSubsector(x, y));

  // Count items and secrets for intermission stats
  countMapItems(mapRef);
  countMapSecrets(mapRef);

  // Sound: stop all sounds and re-init for new level
  S_Start();

  // Start level music
  const mus = musicForMap(mapName);
  if (mus !== Music.None) {
    S_ChangeMusic(mus, true);
  }
}

/** Count pickup items on the map for intermission totalItems */
function countMapItems(map: GameMap): void {
  // In original DOOM, COUNTITEM flag is on things like health bonuses,
  // armor bonuses, soul spheres, mega spheres, invulnerability, etc.
  // We approximate by counting all pickup thing types
  const COUNTABLE_ITEMS: Set<number> = new Set([
    // Health bonuses/pickups
    2014, 2011, 2012, 2013,
    // Armor bonuses/pickups
    2015, 2018, 2019,
    // Ammo
    2007, 2048, 2008, 2049, 2010, 2046, 2047, 17,
    // Backpack
    8,
    // Weapons
    2001, 82, 2002, 2003, 2004, 2006, 2005,
    // Powerups
    2023, 2022, 2024, 2025, 2026, 2045,
    // Keys (not counted in original DOOM, but some modern ports do)
  ]);
  for (const thing of map.things) {
    if (COUNTABLE_ITEMS.has(thing.type)) {
      addTotalItem();
    }
  }
}

/** Count secret sectors for intermission totalSecrets */
function countMapSecrets(map: GameMap): void {
  for (const sector of map.sectors) {
    if ((sector.special & 0xFF) === 9) { // sector special 9 = secret
      addTotalSecret();
    }
  }
}

/** Map level name (e.g. "E1M1", "MAP01") to Music enum.
 *  DOOM 1 maps: e1m1..e3m9 → Music.e1m1..Music.e3m9
 *  DOOM 2 maps: MAP01..MAP32 → uses doom2 music table from S_Start in s_sound.c */
function musicForMap(mapName: string): Music {
  const upper = mapName.toUpperCase();

  // DOOM 1 style: ExMy
  const exmy = upper.match(/^E(\d)M(\d)$/);
  if (exmy) {
    const ep = parseInt(exmy[1]);
    const map = parseInt(exmy[2]);
    if (ep >= 1 && ep <= 3 && map >= 1 && map <= 9) {
      // Music enum: e1m1=1, e1m2=2, ..., e1m9=9, e2m1=10, ...
      return (Music.e1m1 + (ep - 1) * 9 + (map - 1)) as Music;
    }
  }

  // DOOM 2 style: MAPxx — music rotation from original s_sound.c S_Start
  const mapxx = upper.match(/^MAP(\d{2})$/);
  if (mapxx) {
    const num = parseInt(mapxx[1]);
    // DOOM 2 music table (from s_sound.c S_StartSong)
    // Maps 1-32 use music starting from Music.runnin (which = Music.introa + 1)
    const doom2Music: Music[] = [
      Music.runnin, Music.stalks, Music.countd, Music.betwee,
      Music.doom,   Music.the_da, Music.shawn,  Music.ddtblu,
      Music.in_cit, Music.dead,   Music.stlks2, Music.theda2,
      Music.doom2,  Music.ddtbl2, Music.runni2, Music.dead2,
      Music.stlks3, Music.romero, Music.shawn2, Music.messag,
      Music.count2, Music.ddtbl3, Music.ampie,  Music.theda3,
      Music.adrian, Music.messg2, Music.romer2, Music.tense,
      Music.shawn3, Music.openin, Music.evil,   Music.ultima,
    ];
    if (num >= 1 && num <= doom2Music.length) {
      return doom2Music[num - 1];
    }
  }

  return Music.None;
}

function ensureInput(): void {
  if (!inputInitialized) {
    initBrowserInput(canvas, () => menuactive);
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
      case GameAction.ga_warp:
        G_DoWarp();
        break;
      case GameAction.ga_completed:
        G_DoCompleted();
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

  // Apply selected skill level
  setGameSkill(pendingSkill);

  resetLevelStats();
  initMapFresh("E1M1");
  player.spawn();
  ensureInput();
  ensureStatusBar();

  setGameState(GameState.GS_LEVEL);
  setUserGame(true);
  forceWipe(); // force wipe transition even if already GS_LEVEL

  console.log(`[main] New game started (skill ${pendingSkill})`);
}

/** G_DoWarp — warp to a new level (IDCLEV cheat) */
function G_DoWarp(): void {
  setGameAction(GameAction.ga_nothing);
  const mapName = pendingWarpMap;
  if (!mapName) return;

  resetLevelStats();
  initMapFresh(mapName);
  player.spawn();
  resetCheatBuffer();
  ensureInput();
  ensureStatusBar();

  setGameState(GameState.GS_LEVEL);
  setUserGame(true);
  forceWipe();

  console.log(`[main] Warped to ${mapName} (IDCLEV)`);
}

/** G_DoCompleted — transition to the intermission screen after a level exit */
function G_DoCompleted(): void {
  setGameAction(GameAction.ga_nothing);

  if (!mapRef) return;

  // Finish the player's current level (clears powerups, keys, flash)
  player.finishLevel();

  // Determine next map
  const currentName = mapRef.name;
  const nextMap = getNextMap(currentName, secretExit);
  pendingNextMap = nextMap;

  console.log(`[main] Level completed: ${currentName} → ${nextMap}${secretExit ? ' (secret)' : ''}`);

  // Build intermission data struct (from wi_stuff.c WI_Start)
  const cur = parseMapName(currentName);
  const nxt = parseMapName(nextMap);
  const wbs: WBStartStruct = {
    epsd: cur.isCommercial ? 0 : cur.episode - 1,
    last: cur.isCommercial ? cur.map - 1 : cur.map - 1,
    next: nxt.isCommercial ? nxt.map - 1 : nxt.map - 1,
    maxkills: totalKills || 1,
    maxitems: totalItems || 1,
    maxsecret: totalSecrets || 1,
    skills: playerKills,
    sitems: playerItems,
    ssecret: playerSecrets,
    stime: levelTime,
    partime: 0, // par times are inside Intermission class
    isCommercial: cur.isCommercial,
    lastMapName: currentName,
    nextMapName: nextMap,
  };

  // Initialize intermission
  if (!intermission) {
    intermission = new Intermission(wad, palData, texDataRef);
  }
  intermission.start(wbs, () => {
    // Called when intermission finishes
    // Check if we should show a finale text screen
    const finaleConfig = getFinaleConfig(currentName, cur.isCommercial, secretExit);
    if (finaleConfig) {
      F_StartFinale(finaleConfig);
    } else {
      G_DoWorldDone();
    }
  });

  setGameState(GameState.GS_INTERMISSION);
  forceWipe();
}

/** F_StartFinale — start the finale text screen */
function F_StartFinale(config: FinaleConfig): void {
  if (!finale) {
    finale = new Finale(wad, palData, texDataRef);
  }
  finale.start(config, () => {
    // Finale finished — for Doom II, load next map. For Doom I, go to title.
    if (config.isCommercial) {
      G_DoWorldDone();
    } else {
      // Doom I: after episode finale, return to title screen
      setGameState(GameState.GS_DEMOSCREEN);
      setUserGame(false);
      forceWipe();
    }
  });

  setGameState(GameState.GS_FINALE);
  forceWipe();
}

/** G_DoWorldDone — actually load the next map after intermission */
function G_DoWorldDone(): void {
  resetLevelStats();
  initMapFresh(pendingNextMap);
  player.respawnAtStart();
  resetCheatBuffer();
  ensureInput();
  ensureStatusBar();

  setGameState(GameState.GS_LEVEL);
  setUserGame(true);
  forceWipe();
}

/** G_DoLoadGame — load from slot */
function G_DoLoadGame(): void {
  setGameAction(GameAction.ga_nothing);

  const data = loadFromSlot(pendingSaveSlot);
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

/** Apply loaded save data */
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


// ============================================================
// F6 quicksave / F9 quickload helpers
// ============================================================

import { setPendingSaveSlot } from "../game/gamestate";

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
  loadingEl.textContent = "Loading WAD...";

  try {
    wad = await loadWAD("/doomu.wad");

    loadingEl.textContent = "Initializing math tables...";
    initTables();

    loadingEl.textContent = "Loading palette...";
    palData = new PaletteData(wad);

    loadingEl.textContent = "Loading textures...";
    texDataRef = new TextureData(wad);

    loadingEl.textContent = "Loading sounds...";
    S_Init(wad, Math.round(getSfxVolume() * 1.5), Math.round(getMusicVolume() * 1.5));
    initClientEffects();

    // Create and register the software renderer
    const renderer = new SoftwareRenderer();
    setRenderer(renderer);

    loadingEl.textContent = "Initializing...";
    createCanvas();

    // Resume AudioContext on first user interaction (browser autoplay policy)
    const resumeAudio = () => { I_ResumeAudioContext(); };
    document.addEventListener('click', resumeAudio, { once: false });
    document.addEventListener('keydown', resumeAudio, { once: false });

    // Register post-process passes (order matters)


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

    // Profiler overlay (F3)
    profilerDiv = document.createElement("div");
    profilerDiv.style.cssText =
      "position:fixed;top:30px;left:8px;color:#0f0;font:12px monospace;z-index:100;" +
      "background:rgba(0,0,0,0.75);padding:8px 12px;border-radius:4px;" +
      "white-space:pre;pointer-events:none;display:none;";
    document.body.appendChild(profilerDiv);

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
          // Feed cheat key buffer (DOOM: ST_Responder)
          feedCheatKey(e.key, player);
          // F3 — toggle profiler
          if (e.code === "F3") {
            e.preventDefault();
            toggleProfiler();
          }

          // F5 — cycle render mode
          if (e.code === "F5") {
            e.preventDefault();
            getRenderer().cycleRenderMode();
            if (player) {
              player.message = `Render: ${
                { normal: "Normal", depth: "Depth Buffer" }[getRenderer().getRenderMode() as 'normal' | 'depth']
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

        // WI_Responder — any key press during intermission accelerates
        if (gamestate === GameState.GS_INTERMISSION && intermission && !menuactive) {
          if (e.code === "Space" || e.code === "Enter" || e.code === "ControlLeft" || e.code === "ControlRight") {
            e.preventDefault();
            intermission.pressAccelerate();
          }
        }

        // F_Responder — any key press during finale
        if (gamestate === GameState.GS_FINALE && finale && !menuactive) {
          e.preventDefault();
          finale.pressKey();
        }
      },
      true
    );

    // ── Game Loop (D_DoomLoop) ──────────────────────────────
    loop = new GameLoop(
      // ── Tick (35 Hz) — G_Ticker + P_Ticker ──
      () => {
        profilerTickStart();

        // M_Ticker — skull animation
        menu.tick();

        // G_Ticker — process deferred actions (ga_newgame, ga_loadgame, ga_savegame)
        G_Ticker();

        // P_Ticker — game logic (only in GS_LEVEL, paused when menu is open)
        if (gamestate === GameState.GS_LEVEL && usergame && !menuactive) {
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
            updatePlayerMobj(mapRef);
            runThinkers();
            tickLevelTime();
            updateAnimations();
            updateThingAnimations();
            updateMonsterDeaths();
            updateMobjFloorZ();
            tickMonsterRespawn();
            updateVfx();
            updateProjectiles();
            getRenderer().updateLights();
            statusBar.tickMessage(player);

            // Sound: update spatial audio for all playing sounds
            S_SetListener({ x: player.x, y: player.y, angle: player.angle });
            S_UpdateSounds();
          } else {
            wipeTick();
          }
        }

        profilerTickEnd();

        // WI_Ticker — intermission screen logic
        if (gamestate === GameState.GS_INTERMISSION && intermission) {
          if (!isWipeActive()) {
            intermission.tick();
          } else {
            wipeTick();
          }
        }

        // F_Ticker — finale screen logic
        if (gamestate === GameState.GS_FINALE && finale) {
          if (!isWipeActive()) {
            finale.tick();
          } else {
            wipeTick();
          }
        }
      },

      // ── Draw (every frame) — D_Display ──
      () => {
        profilerFrameStart();
        // Wipe trigger: if gamestate changed since last draw, start wipe
        if (gamestate !== wipegamestate && !isWipeActive()) {
          wipeStartCapture();

          // Render the new state for the wipe end frame (full pipeline)
          if (gamestate === GameState.GS_LEVEL && usergame) {
            getRenderer().setView(player.x, player.y, player.viewz, player.angle);
            getRenderer().renderFrame();
            getRenderer().drawWeaponOverlay();
            statusBar.draw(player);
            applyScreenTint();
            getRenderer().setLightView(player.x, player.y, player.viewz);
            runPostProcess(rgbaBuffer, gBuffer, SCREENWIDTH, SCREENHEIGHT);
          } else if (gamestate === GameState.GS_INTERMISSION && intermission) {
            intermission.draw();
          } else if (gamestate === GameState.GS_FINALE && finale) {
            finale.draw();
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
                profilerBegin('view');
                getRenderer().setView(player.x, player.y, player.viewz, player.angle);
                updatePaletteFlash(player, palData);
                profilerEnd('view');

                profilerBegin('render');
                getRenderer().renderFrame();
                profilerEnd('render');

                profilerBegin('psprites');
                getRenderer().drawWeaponOverlay();
                profilerEnd('psprites');

                profilerBegin('hud');
                statusBar.draw(player);
                profilerEnd('hud');

                profilerBegin('tint');
                applyScreenTint();
                profilerEnd('tint');

                profilerBegin('postprocess');
                getRenderer().setLightView(player.x, player.y, player.viewz);
                runPostProcess(rgbaBuffer, gBuffer, SCREENWIDTH, SCREENHEIGHT);
                profilerEnd('postprocess');
              }
              break;

            case GameState.GS_INTERMISSION:
              if (intermission) {
                intermission.draw();
              }
              break;

            case GameState.GS_FINALE:
              if (finale) {
                finale.draw();
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
        profilerBegin('blit');
        imageBuffer.set(rgbaBuffer);
        ctx.putImageData(imageData, 0, 0);
        profilerEnd('blit');

        profilerFrameEnd();

        // FPS / Profiler
        if (isProfilerVisible()) {
          fpsDiv.style.display = 'none';
          drawProfilerOverlay(profilerDiv, loop.fps);
        } else {
          fpsDiv.style.display = 'block';
          profilerDiv.style.display = 'none';
          fpsDiv.textContent = `${loop.fps} FPS`;
        }
      },
      createBrowserClock(),
    );

    loop.start();
    console.log("TSDoom started!");
  } catch (err) {
    loadingEl.textContent = `Error: ${err}`;
    loadingEl.style.color = "#f00";
    console.error(err);
  }
}

main();
