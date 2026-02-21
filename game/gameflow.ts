// ============================================================
// Game Flow — game action processing (G_Ticker, G_DoNewGame, etc.)
// Extracted from main.ts — pure game logic, no DOM/browser deps.
// Reference: g_game.c
// ============================================================

import type { GameMap } from './map-types';
import type { Player } from './player';
import {
  GameState, GameAction,
  gamestate, gameaction, secretExit, usergame,
  pendingSaveSlot, pendingWarpMap, pendingSkill,
  setGameState, setGameAction, setUserGame, forceWipe,
  setPendingSaveSlot,
} from './gamestate';
import { setGameSkill } from './skill';
import { resetCheatBuffer } from './cheats';
import { getNextMap, parseMapName } from './mapflow';
import { captureGameState, applyGameState, saveToSlot, loadFromSlot, GameSaveData } from './savegame';
import { Music } from './sounds';
import { addTotalItem, addTotalSecret, resetLevelStats, totalKills, totalItems, totalSecrets, playerKills, playerItems, playerSecrets } from './level-stats';
import { levelTime } from './thinkers';

// ---- Intermission data (re-exported from intermission for convenience) ----
export interface WBStartStruct {
  epsd: number;
  last: number;
  next: number;
  maxkills: number;
  maxitems: number;
  maxsecret: number;
  skills: number;
  sitems: number;
  ssecret: number;
  stime: number;
  partime: number;
  isCommercial: boolean;
  lastMapName: string;
  nextMapName: string;
}

/** Finale configuration (passed through from mapflow) */
export interface FinaleConfig {
  text: string;
  flat: string;
  music: Music;
  isCommercial: boolean;
  episode: number;     // 1-based (Doom I) or 0 (Doom II)
}

/** Platform callbacks — implemented by main.ts */
export interface GameFlowCallbacks {
  /** Load a map by name: parse WAD, init renderer, init specials, etc. */
  loadMap(name: string): void;
  /** Ensure keyboard/mouse/gamepad input is initialized */
  ensureInput(): void;
  /** Ensure HUD status bar is initialized */
  ensureStatusBar(): void;
  /** Check if a map lump exists in the WAD */
  checkMapExists(name: string): boolean;
  /** Start the intermission screen */
  startIntermission(wbs: WBStartStruct, onFinish: () => void): void;
  /** Start the finale text screen */
  startFinale(config: FinaleConfig, onFinish: () => void): void;
  /** Get the finale config for a completed map (or null if no finale) */
  getFinaleConfig(mapName: string, isCommercial: boolean, secret: boolean): FinaleConfig | null;
}

// ---- Module state ----
let callbacks: GameFlowCallbacks;
let player: Player;
let pendingNextMap: string = '';

/** Reference to the current map — updated by callbacks.loadMap via setFlowMap */
let mapRef: GameMap;

/** Initialize the game flow system. Call once at startup. */
export function initGameFlow(cb: GameFlowCallbacks): void {
  callbacks = cb;
}

/** Update internal player reference (when Player object is recreated) */
export function setFlowPlayer(p: Player): void {
  player = p;
}

/** Update internal map reference (called by platform after loadMap) */
export function setFlowMap(m: GameMap): void {
  mapRef = m;
}

/** Get the current player reference */
export function getFlowPlayer(): Player {
  return player;
}

/** Get the current map reference */
export function getFlowMap(): GameMap {
  return mapRef;
}

// ============================================================
// G_Ticker — process deferred game actions (like DOOM's g_game.c)
// ============================================================

export function G_Ticker(): void {
  while (gameaction() !== GameAction.ga_nothing) {
    switch (gameaction()) {
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

  setGameSkill(pendingSkill());

  resetLevelStats();
  const startMap = callbacks.checkMapExists("MAP01") ? "MAP01" : "E1M1";
  callbacks.loadMap(startMap);
  player.spawn();
  callbacks.ensureInput();
  callbacks.ensureStatusBar();

  setGameState(GameState.GS_LEVEL);
  setUserGame(true);
  forceWipe();

  console.log(`[gameflow] New game started (skill ${pendingSkill()})`);
}

/** G_DoWarp — warp to a new level (IDCLEV cheat) */
function G_DoWarp(): void {
  setGameAction(GameAction.ga_nothing);
  const mapName = pendingWarpMap();
  if (!mapName) return;

  // Validate that the map lump exists in the WAD
  let resolvedMap = mapName;
  if (!callbacks.checkMapExists(resolvedMap)) {
    // Try alternate format: E#M# → MAP##, or MAP## → E#M#
    const eMatch = resolvedMap.match(/^E(\d)M(\d)$/);
    const mMatch = resolvedMap.match(/^MAP(\d{2})$/);
    if (eMatch) {
      const altMap = `MAP${(parseInt(eMatch[1]) * 10 + parseInt(eMatch[2])).toString().padStart(2, '0')}`;
      if (callbacks.checkMapExists(altMap)) {
        resolvedMap = altMap;
      }
    } else if (mMatch) {
      const num = parseInt(mMatch[1]);
      const ep = Math.floor(num / 10);
      const mp = num % 10;
      if (ep >= 1 && mp >= 1) {
        const altMap = `E${ep}M${mp}`;
        if (callbacks.checkMapExists(altMap)) {
          resolvedMap = altMap;
        }
      }
    }
  }

  if (!callbacks.checkMapExists(resolvedMap)) {
    console.warn(`[gameflow] Map lump not found: ${mapName}`);
    if (player) {
      player.message = 'IMPOSSIBLE SELECTION';
    }
    return;
  }

  resetLevelStats();
  callbacks.loadMap(resolvedMap);
  player.spawn();
  resetCheatBuffer();
  callbacks.ensureInput();
  callbacks.ensureStatusBar();

  setGameState(GameState.GS_LEVEL);
  setUserGame(true);
  forceWipe();

  console.log(`[gameflow] Warped to ${mapName} (IDCLEV)`);
}

/** G_DoCompleted — transition to the intermission screen after a level exit */
function G_DoCompleted(): void {
  setGameAction(GameAction.ga_nothing);

  if (!mapRef) return;

  player.finishLevel();

  const currentName = mapRef.name;
  const nextMap = getNextMap(currentName, secretExit());
  pendingNextMap = nextMap;

  console.log(`[gameflow] Level completed: ${currentName} → ${nextMap}${secretExit() ? ' (secret)' : ''}`);

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
    partime: 0,
    isCommercial: cur.isCommercial,
    lastMapName: currentName,
    nextMapName: nextMap,
  };

  callbacks.startIntermission(wbs, () => {
    const finaleConfig = callbacks.getFinaleConfig(currentName, cur.isCommercial, secretExit());
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
  callbacks.startFinale(config, () => {
    if (config.isCommercial) {
      G_DoWorldDone();
    } else {
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
  callbacks.loadMap(pendingNextMap);
  player.respawnAtStart();
  resetCheatBuffer();
  callbacks.ensureInput();
  callbacks.ensureStatusBar();

  setGameState(GameState.GS_LEVEL);
  setUserGame(true);
  forceWipe();
}

/** G_DoLoadGame — load from slot */
function G_DoLoadGame(): void {
  setGameAction(GameAction.ga_nothing);

  const data = loadFromSlot(pendingSaveSlot());
  if (!data) {
    if (player) player.message = "No save in this slot.";
    return;
  }

  applyLoadedData(data);
}

/** G_DoSaveGame — save current state */
function G_DoSaveGame(): void {
  setGameAction(GameAction.ga_nothing);

  if (!usergame() || !player || !mapRef) {
    console.warn("[gameflow] Cannot save — not in game");
    return;
  }

  const slot = pendingSaveSlot();
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
  callbacks.loadMap(data.mapName);
  callbacks.ensureInput();
  callbacks.ensureStatusBar();

  applyGameState(data, player, mapRef);

  setGameState(GameState.GS_LEVEL);
  setUserGame(true);
  forceWipe();
  player.message = "Game loaded.";
  console.log(`[gameflow] Game loaded: ${data.mapName} (${data.description})`);
}

// ============================================================
// Quick save/load helpers
// ============================================================

export function quickSave(): void {
  if (!usergame() || gamestate() !== GameState.GS_LEVEL) return;
  setPendingSaveSlot(-1);
  setGameAction(GameAction.ga_savegame);
}

export function quickLoad(): void {
  setPendingSaveSlot(-1);
  setGameAction(GameAction.ga_loadgame);
}

// ============================================================
// Pure utility functions
// ============================================================

/** Map level name to Music enum */
export function musicForMap(mapName: string): Music {
  const upper = mapName.toUpperCase();

  const exmy = upper.match(/^E(\d)M(\d)$/);
  if (exmy) {
    const ep = parseInt(exmy[1]);
    const map = parseInt(exmy[2]);
    if (ep >= 1 && ep <= 3 && map >= 1 && map <= 9) {
      return (Music.e1m1 + (ep - 1) * 9 + (map - 1)) as Music;
    }
  }

  const mapxx = upper.match(/^MAP(\d{2})$/);
  if (mapxx) {
    const num = parseInt(mapxx[1]);
    const doom2Music: Music[] = [
      Music.runnin, Music.stalks, Music.countd, Music.betwee,
      Music.doom, Music.the_da, Music.shawn, Music.ddtblu,
      Music.in_cit, Music.dead, Music.stlks2, Music.theda2,
      Music.doom2, Music.ddtbl2, Music.runni2, Music.dead2,
      Music.stlks3, Music.romero, Music.shawn2, Music.messag,
      Music.count2, Music.ddtbl3, Music.ampie, Music.theda3,
      Music.adrian, Music.messg2, Music.romer2, Music.tense,
      Music.shawn3, Music.openin, Music.evil, Music.ultima,
    ];
    if (num >= 1 && num <= doom2Music.length) {
      return doom2Music[num - 1];
    }
  }

  return Music.None;
}

/** Count pickup items on the map for intermission totalItems */
export function countMapItems(map: GameMap): void {
  const COUNTABLE_ITEMS: Set<number> = new Set([
    2014, 2011, 2012, 2013,
    2015, 2018, 2019,
    2007, 2048, 2008, 2049, 2010, 2046, 2047, 17,
    8,
    2001, 82, 2002, 2003, 2004, 2006, 2005,
    2023, 2022, 2024, 2025, 2026, 2045,
  ]);
  for (const thing of map.things) {
    if (COUNTABLE_ITEMS.has(thing.type)) {
      addTotalItem();
    }
  }
}

/** Count secret sectors for intermission totalSecrets */
export function countMapSecrets(map: GameMap): void {
  for (const sector of map.sectors) {
    if ((sector.special & 0xFF) === 9) {
      addTotalSecret();
    }
  }
}
