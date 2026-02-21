// ============================================================
// Game State — global state machine (like DOOM's doomstat.h)
// Separates gamestate (what the game is doing) from
// menuactive (whether menu overlay is shown).
// Reference: doomdef.h, doomstat.h, g_game.c
// ============================================================

/** What the game is currently doing */
export enum GameState {
  GS_DEMOSCREEN,  // title / demo screens
  GS_LEVEL,       // active gameplay
  GS_INTERMISSION, // intermission stats screen between levels
  GS_FINALE,      // text screen between episodes / end of game
}

/** Deferred actions — set by menu/input, processed by G_Ticker in main loop */
export enum GameAction {
  ga_nothing,
  ga_newgame,
  ga_loadgame,
  ga_savegame,
  ga_warp,
  ga_completed,
}

// ---- Internal state ----

import { SkillLevel } from './skill';

let _gamestate: GameState = GameState.GS_DEMOSCREEN;
let _gameaction: GameAction = GameAction.ga_nothing;
let _menuactive = false;
let _usergame = false;
let _wipegamestate: GameState = GameState.GS_DEMOSCREEN;
/** Slot number for deferred load/save (-1 = quicksave) */
let _pendingSaveSlot = 0;
/** Map name for deferred warp (IDCLEV cheat) */
let _pendingWarpMap = '';
/** Whether the current exit is a secret exit */
let _secretExit = false;
/** Pending skill for deferred new game */
let _pendingSkill: SkillLevel = SkillLevel.sk_medium;

// ---- Getters ----

export function gamestate(): GameState { return _gamestate; }
export function gameaction(): GameAction { return _gameaction; }
export function menuactive(): boolean { return _menuactive; }
export function usergame(): boolean { return _usergame; }
export function wipegamestate(): GameState { return _wipegamestate; }
export function pendingSaveSlot(): number { return _pendingSaveSlot; }
export function pendingWarpMap(): string { return _pendingWarpMap; }
export function secretExit(): boolean { return _secretExit; }
export function pendingSkill(): SkillLevel { return _pendingSkill; }

// ---- Setters ----

export function setGameState(s: GameState): void { _gamestate = s; }
export function setGameAction(a: GameAction): void { _gameaction = a; }
export function setMenuActive(v: boolean): void { _menuactive = v; }
export function setUserGame(v: boolean): void { _usergame = v; }
export function setWipeGameState(s: GameState): void { _wipegamestate = s; }
/** Force a wipe on next draw by invalidating wipegamestate (like DOOM's wipegamestate = -1) */
export function forceWipe(): void { _wipegamestate = -1 as unknown as GameState; }
export function setPendingSaveSlot(slot: number): void { _pendingSaveSlot = slot; }
export function setPendingWarpMap(map: string): void { _pendingWarpMap = map; }
export function setSecretExit(v: boolean): void { _secretExit = v; }
export function setPendingSkill(skill: SkillLevel): void { _pendingSkill = skill; }
