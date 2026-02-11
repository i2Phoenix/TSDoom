// ============================================================
// Thinker System
// Reference: p_tick.c — linked list of action functions
// ============================================================

export interface Thinker {
  action: ((t: Thinker) => void) | null;
  removed: boolean;
}

const thinkers: Thinker[] = [];

export function addThinker(t: Thinker): void {
  thinkers.push(t);
}

export function removeThinker(t: Thinker): void {
  t.removed = true;
}

/**
 * Run all thinkers for this tick.
 * Mirrors P_RunThinkers from p_tick.c
 */
export function runThinkers(): void {
  for (let i = thinkers.length - 1; i >= 0; i--) {
    const t = thinkers[i];
    if (t.removed) {
      thinkers.splice(i, 1);
    } else if (t.action) {
      t.action(t);
    }
  }
}

/** Clear all thinkers (level change) */
export function clearThinkers(): void {
  thinkers.length = 0;
}

export let levelTime = 0;

export function tickLevelTime(): void {
  levelTime++;
}

export function setLevelTime(t: number): void {
  levelTime = t;
}

/** Direct access to the thinker list (for save/load) */
export function getThinkersList(): Thinker[] {
  return thinkers;
}
