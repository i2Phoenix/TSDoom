// ============================================================
// WorldContext — global GameInstance access
// Single source of truth for all mutable game state.
// ============================================================

import type { GameMap } from './map-types';
import type { Player } from './player';
import { GameInstance } from './game-instance';

export type { WorldContext } from './game-instance';

// ---- Global GameInstance ----

let _gi: GameInstance | null = null;

/** Initialize the global GameInstance (call once at startup). */
export function initGI(): GameInstance {
  _gi = new GameInstance();
  return _gi;
}

// ---- World initialization ----

/**
 * Initialize the world context for a new level.
 * Must be called before any game logic that accesses gi.world.
 */
export function initWorld(map: GameMap, player: Player, gi: GameInstance): void {
  gi.world = { map, player };
  gi.currentMap = map;
}

/**
 * Update the player reference (e.g., on level restart when Player is recreated).
 */
export function setWorldPlayer(player: Player, gi: GameInstance): void {
  if (!gi.world) throw new Error('setWorldPlayer() called before initWorld()');
  gi.world.player = player;
}
