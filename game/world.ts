// ============================================================
// WorldContext — shared game world state
// Single source of truth for map, player, and map objects.
// Replaces per-module cached refs (currentMap, playerRef, etc.)
// ============================================================

import type { GameMap } from '../src/map';
import type { Player } from './player';

/**
 * Shared context holding the current level's core state.
 * Created once per level load, accessed by all game/ modules.
 */
export interface WorldContext {
  /** Current loaded map (BSP, linedefs, sectors, etc.) */
  map: GameMap;
  /** The live player instance */
  player: Player;
}

let _world: WorldContext | null = null;

/**
 * Initialize the world context for a new level.
 * Must be called before any game logic that uses getWorld().
 */
export function initWorld(map: GameMap, player: Player): void {
  _world = { map, player };
}

/**
 * Get the current world context.
 * Crashes loudly if called before initWorld() — this is intentional
 * to make init-order bugs immediately visible.
 */
export function getWorld(): WorldContext {
  return _world!;
}

/**
 * Update the player reference (e.g., on level restart when Player is recreated).
 */
export function setWorldPlayer(player: Player): void {
  _world!.player = player;
}
