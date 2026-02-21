// ============================================================
// TSDoom — Main Entry Point
// Reference: d_main.c (D_DoomLoop, D_Display, D_ProcessEvents)
// ============================================================

import { loadWAD, WAD } from "./wad";
import { initTables } from "../game/math";
import { PaletteData } from "./palette";
import { TextureData } from "./textures";
import { GameMapImpl } from "./map";
import type { GameMap } from "../game/map-types";
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
import { initTouchControls } from "./input-touch";
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
import { feedCheatKey } from "../game/cheats";
import { updateProjectiles, clearProjectiles } from "../game/projectiles";
import { initBossBrain, tickBossBrain } from "../game/bossbrain";
import { AM_Start, AM_Responder, AM_Drawer, isAutomapActive, AM_SetScreenBuffer } from "../game/automap";
import { S_Init, S_Start, S_UpdateSounds, S_SetListener, S_ChangeMusic } from "./sound/s_sound";
import { Music } from "../game/sounds";
import { I_ResumeAudioContext, I_SuspendAudioContext } from "./sound/i_sound";
import { initClientEffects } from "./effects-client";
import {
  wipeStartCapture,
  wipeEndCapture,
  isWipeActive,
  wipeTick,
} from "./render/software/wipe";
import { spawnSectorLights, saveSectorState } from "../game/lights";
import { loadSettings, getResolutionIndex, getSfxVolume, getMusicVolume } from "../game/settings";
import {
  GameState, GameAction,
  gamestate, menuactive, usergame, wipegamestate,
  setGameAction, setWipeGameState, forceWipe,
  setPendingSaveSlot,
} from "../game/gamestate";
import { Intermission } from "./game/intermission";
import { Finale, getFinaleConfig } from "./game/finale";
import {
  G_Ticker, initGameFlow, setFlowPlayer, setFlowMap,
  musicForMap, countMapItems, countMapSecrets,
  quickSave, quickLoad,
} from "../game/gameflow";
import type { GameFlowCallbacks } from "../game/gameflow";

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
  AM_SetScreenBuffer(rgbaBuffer, SCREENWIDTH, SCREENHEIGHT);
  fitCanvasToViewport();
  if (usergame()) {
    (getRenderer() as SoftwareRenderer).init(mapRef, texDataRef, palData, wad);
  }
}

// ============================================================
// Map initialization (shared by new game / load game / respawn)
// ============================================================

function initMapFresh(mapName: string): void {
  mapRef = new GameMapImpl(wad, texDataRef, mapName);
  (getRenderer() as SoftwareRenderer).init(mapRef, texDataRef, palData, wad);

  if (!player) {
    player = new Player(mapRef);
  } else {
    player.setMap(mapRef);
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
  initBossBrain();
  initEnemyAI();
  initAICallbacks();
  resetPaletteFlash(palData);
  getRenderer().clearLights();
  getRenderer().spawnStaticLights(mapRef.things, (x, y) => mapRef.pointInSubsector(x, y));
  AM_Start(mapRef);

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

  // Update gameflow references
  setFlowMap(mapRef);
  setFlowPlayer(player);
}

function ensureInput(): void {
  if (!inputInitialized) {
    initBrowserInput(canvas, menuactive);
    inputInitialized = true;
  }
}

function ensureStatusBar(): void {
  if (!statusBar) {
    statusBar = new StatusBar(wad, palData, texDataRef);
  }
}

// ============================================================
// GameFlow callbacks — platform-specific operations for game/gameflow.ts
// ============================================================

const flowCallbacks: GameFlowCallbacks = {
  loadMap(name: string): void {
    initMapFresh(name);
  },
  ensureInput(): void {
    ensureInput();
  },
  ensureStatusBar(): void {
    ensureStatusBar();
  },
  checkMapExists(name: string): boolean {
    return wad.checkNumForName(name) !== -1;
  },
  startIntermission(wbs, onFinish): void {
    if (!intermission) {
      intermission = new Intermission(wad, palData, texDataRef);
    }
    intermission.start(wbs, onFinish);
  },
  startFinale(config, onFinish): void {
    if (!finale) {
      finale = new Finale(wad, palData, texDataRef);
    }
    finale.start(config, onFinish);
  },
  getFinaleConfig(mapName, isCommercial, secret) {
    return getFinaleConfig(mapName, isCommercial, secret);
  },
};

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

    // Initialize game flow system (delegates G_Ticker actions to platform callbacks)
    initGameFlow(flowCallbacks);

    // Create and register the software renderer
    const renderer = new SoftwareRenderer();
    setRenderer(renderer);

    loadingEl.textContent = "Initializing...";
    createCanvas();
    AM_SetScreenBuffer(rgbaBuffer, SCREENWIDTH, SCREENHEIGHT);

    // Resume AudioContext on first user interaction (browser autoplay policy)
    // Use AbortController to remove all listeners after the first successful resume.
    const resumeAbort = new AbortController();
    const resumeAudio = () => {
      I_ResumeAudioContext();
      resumeAbort.abort();
    };
    const resumeOpts = { signal: resumeAbort.signal } as AddEventListenerOptions;
    document.addEventListener('click', resumeAudio, resumeOpts);
    document.addEventListener('keydown', resumeAudio, resumeOpts);
    document.addEventListener('pointerdown', resumeAudio, resumeOpts);
    document.addEventListener('touchstart', resumeAudio, resumeOpts);

    // Suspend/resume AudioContext when tab visibility changes (saves battery)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        I_SuspendAudioContext();
      } else {
        I_ResumeAudioContext();
      }
    });

    // Initialize touch controls (if applicable)
    initTouchControls();

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
      onQuitGame: () => {
        // Try to close the tab; works when page was opened via JS.
        // Falls back to navigating away (effectively kills the game).
        window.close();
        // Fallback for tabs not opened by script
        setTimeout(() => { location.href = 'about:blank'; }, 200);
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
          if (menuactive() && document.pointerLockElement) {
            document.exitPointerLock();
          }
          return;
        }

        // Game input (only when playing and no menu)
        if (gamestate() === GameState.GS_LEVEL && usergame() && !menuactive()) {
          // Feed cheat key buffer (DOOM: ST_Responder)
          feedCheatKey(e.key, player);

          // Automap responder (TAB toggle + zoom/pan when active)
          if (AM_Responder(e.code)) {
            e.preventDefault();
            return;
          }

          // F1 — open help screen (matches original DOOM)
          if (e.code === "F1") {
            e.preventDefault();
            menu.openHelpScreen();
            if (document.pointerLockElement) document.exitPointerLock();
            return;
          }

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
              player.message = `Render: ${{ normal: "Normal", depth: "Depth Buffer" }[getRenderer().getRenderMode() as 'normal' | 'depth']
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
        if (gamestate() === GameState.GS_INTERMISSION && intermission && !menuactive()) {
          if (e.code === "Space" || e.code === "Enter" || e.code === "ControlLeft" || e.code === "ControlRight") {
            e.preventDefault();
            intermission.pressAccelerate();
          }
        }

        // F_Responder — any key press during finale
        if (gamestate() === GameState.GS_FINALE && finale && !menuactive()) {
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
        if (gamestate() === GameState.GS_LEVEL && usergame() && !menuactive()) {
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
            tickBossBrain();
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
        if (gamestate() === GameState.GS_INTERMISSION && intermission) {
          if (!isWipeActive()) {
            intermission.tick();
          } else {
            wipeTick();
          }
        }

        // F_Ticker — finale screen logic
        if (gamestate() === GameState.GS_FINALE && finale) {
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
        if (gamestate() !== wipegamestate() && !isWipeActive()) {
          wipeStartCapture();

          // Render the new state for the wipe end frame (full pipeline)
          if (gamestate() === GameState.GS_LEVEL && usergame()) {
            getRenderer().setView(player.x, player.y, player.viewz, player.angle);
            getRenderer().renderFrame();
            getRenderer().setWeaponInvisible(player.powers[2] > 0);
            getRenderer().drawWeaponOverlay();
            statusBar.draw(player);
            applyScreenTint();
            getRenderer().setLightView(player.x, player.y, player.viewz);
            runPostProcess(rgbaBuffer, gBuffer, SCREENWIDTH, SCREENHEIGHT);
          } else if (gamestate() === GameState.GS_INTERMISSION && intermission) {
            intermission.draw();
          } else if (gamestate() === GameState.GS_FINALE && finale) {
            finale.draw();
          } else {
            menu.drawTitleScreen();
          }

          wipeEndCapture();
          setWipeGameState(gamestate());
        }

        if (isWipeActive()) {
          // Wipe in progress — menu can be drawn on top (like DOOM)
          if (menuactive()) menu.draw();
        } else {
          // Normal rendering based on gamestate
          switch (gamestate()) {
            case GameState.GS_LEVEL:
              if (usergame()) {
                profilerBegin('view');
                getRenderer().setView(player.x, player.y, player.viewz, player.angle);
                updatePaletteFlash(player, palData);
                profilerEnd('view');

                profilerBegin('render');
                getRenderer().renderFrame();
                profilerEnd('render');

                profilerBegin('psprites');
                getRenderer().setWeaponInvisible(player.powers[2] > 0);
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

                // Automap overlay (draws on top of everything)
                if (isAutomapActive()) {
                  AM_Drawer(player.x, player.y, player.angle);
                }
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
          if (menuactive()) {
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
