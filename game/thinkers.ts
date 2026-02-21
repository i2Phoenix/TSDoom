// ============================================================
// Thinker System
// Reference: p_tick.c — linked list of action functions
// ============================================================

import { GameInstance } from './game-instance';

export interface Thinker {
  action: ((t: Thinker, gi: GameInstance) => void) | null;
  removed: boolean;
}

/** Add a thinker to the global GameInstance list */
export function addThinker(t: Thinker, gi: GameInstance): void {
  gi.thinkers.push(t);
}

export function removeThinker(t: Thinker): void {
  t.removed = true;
}

/**
 * Run all thinkers for this tick.
 * Mirrors P_RunThinkers from p_tick.c
 */
export function runThinkers(gi: GameInstance): void {
  const thinkers = gi.thinkers;
  for (let i = thinkers.length - 1; i >= 0; i--) {
    const t = thinkers[i];
    if (t.removed) {
      thinkers.splice(i, 1);
    } else if (t.action) {
      t.action(t, gi);
    }
  }
}

/** Clear all thinkers (level change) */
export function clearThinkers(gi: GameInstance): void {
  gi.thinkers.length = 0;
}

export function getLevelTime(gi: GameInstance): number {
  return gi.levelTime;
}

export function tickLevelTime(gi: GameInstance): void {
  gi.levelTime++;
}

export function setLevelTime(t: number, gi: GameInstance): void {
  gi.levelTime = t;
}

/** Direct access to the thinker list (for save/load) */
export function getThinkersList(gi: GameInstance): Thinker[] {
  return gi.thinkers;
}
