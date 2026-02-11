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

// ---- Global state variables ----

export let gamestate: GameState = GameState.GS_DEMOSCREEN;
export let gameaction: GameAction = GameAction.ga_nothing;
export let menuactive: boolean = false;
export let usergame: boolean = false;
export let wipegamestate: GameState = GameState.GS_DEMOSCREEN;

/** Slot number for deferred load/save (-1 = quicksave) */
export let pendingSaveSlot: number = 0;



/** Map name for deferred warp (IDCLEV cheat) */
export let pendingWarpMap: string = '';

/** Whether the current exit is a secret exit */
export let secretExit: boolean = false;

/** Pending skill for deferred new game */
import { SkillLevel } from './skill';
export let pendingSkill: SkillLevel = SkillLevel.sk_medium;

// ---- Setters ----

export function setGameState(s: GameState): void { gamestate = s; }
export function setGameAction(a: GameAction): void { gameaction = a; }
export function setMenuActive(v: boolean): void { menuactive = v; }
export function setUserGame(v: boolean): void { usergame = v; }
export function setWipeGameState(s: GameState): void { wipegamestate = s; }
/** Force a wipe on next draw by invalidating wipegamestate (like DOOM's wipegamestate = -1) */
export function forceWipe(): void { wipegamestate = -1 as unknown as GameState; }
export function setPendingSaveSlot(slot: number): void { pendingSaveSlot = slot; }
export function setPendingWarpMap(map: string): void { pendingWarpMap = map; }
export function setSecretExit(v: boolean): void { secretExit = v; }
export function setPendingSkill(skill: SkillLevel): void { pendingSkill = skill; }
