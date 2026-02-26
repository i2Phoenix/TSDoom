// ============================================================
// GameInstance — Single object holding all mutable game state.
//
// Replaces ~100+ module-level `let` variables scattered across
// 25+ game/ modules. Passed as `gi` parameter to all functions
// that need state access.
//
// Per-level state is reset via resetLevel().
// Per-session state persists across level transitions.
// ============================================================

import type { GameMap, LineDef, Sector, SideDef } from './map-types';
import type { AnimSequence } from './animations';
import type { Player } from './player';
import type { Thinker } from './thinkers';
import type { MapObjState, DroppedItem } from './mobj';
import type { VfxEffect } from './vfx';
import type { Projectile } from './projectiles';
import { GameState, GameAction } from './gamestate';
import { SkillLevel } from './skill';

// ---- WorldContext (inlined — replaces world.ts interface) ----

export interface WorldContext {
  map: GameMap;
  player: Player;
}

// ---- Scratch contexts for per-call shared state ----

export interface MoveContext {
  tmFloorZ: number;
  tmCeilingZ: number;
  tmDropoffZ: number;
  floatok: boolean;
  spechit: LineDef[];
}

export interface CombatContext {
  linetarget: MapObjState | null;
  aimslope: number;
  bulletslope: number;
}

export interface SightContext {
  sightValidcount: number;
  sightzstart: number;
  topslope: number;
  bottomslope: number;
  straceX: number;
  straceY: number;
  straceDx: number;
  straceDy: number;
  t2x: number;
  t2y: number;
  sightMap: GameMap | null;
}

// ---- Level statistics ----

export interface LevelStats {
  totalKills: number;
  totalItems: number;
  totalSecrets: number;
  playerKills: number;
  playerItems: number;
  playerSecrets: number;
}

// ---- GameInstance ----

export class GameInstance {
  // === Per-level state (reset on level load) ===

  /** Current world context (map + player) */
  world: WorldContext | null = null;

  /** Thinker list (sector movers, lights, etc.) */
  thinkers: Thinker[] = [];

  /** Level time in tics */
  levelTime = 0;

  /** All runtime map objects (monsters, barrels, etc.) */
  mapObjects: MapObjState[] = [];

  /** Counter for dynamically spawned things (negative indices) */
  nextMobjId = -1;

  /** Fast lookup: thingIndex → MapObjState */
  thingIndexMap = new Map<number, MapObjState>();

  /** Monsters currently in death animation */
  dyingMonsters = new Set<number>();

  /** Items dropped by killed monsters */
  droppedItems: DroppedItem[] = [];

  /** Sector → lines lookup (built on level load) */
  sectorLines = new Map<Sector, LineDef[]>();

  /** Sector → active thinker (door/floor/ceiling/plat) */
  sectorSpecialData = new Map<Sector, Thinker>();

  /** Active platforms array (MAXPLATS = 30) */
  activePlats: (Thinker | null)[] = new Array(30).fill(null);

  /** Active ceilings array (MAXCEILINGS = 30) */
  activeCeilings: (Thinker | null)[] = new Array(30).fill(null);

  /** Active visual effects (puffs, blood, explosions) */
  activeEffects: VfxEffect[] = [];

  /** Active projectiles (rockets, plasma, BFG, monster fireballs) */
  activeProjectiles: Projectile[] = [];

  /** Set of thing indices that have been picked up */
  removedThings = new Set<number>();

  /** Saved original sector specials (for respawn) */
  savedSectorSpecials: number[] = [];

  /** Saved original sector light levels (for respawn) */
  savedSectorLightLevels: number[] = [];

  /** Current map reference (cached from world) */
  currentMap: GameMap | null = null;

  /** Global validcount for linedef/sector deduplication (BSP traversal, blockmap iteration) */
  validcount = 0;

  /** AI sound propagation validcount */
  soundValidcount = 0;

  /** Boss brain spawn spots (thing type 87) */
  brainTargets: MapObjState[] = [];

  /** Boss brain round-robin spawn target index */
  brainTargetIndex = 0;

  /** Reference to boss brain thing (type 88) */
  bossBrainObj: MapObjState | null = null;

  /** Reference to boss eye/shooter thing (type 89) */
  bossEyeObj: MapObjState | null = null;

  /** Counter for boss-brain-spawned things (negative to avoid collisions) */
  brainDynamicCounter = -2000;

  /** Player MapObjState proxy (for AI sight checks) */
  playerMobj: MapObjState | null = null;

  /** Level statistics */
  stats: LevelStats = createLevelStats();

  /** Animated texture sequences (flat/wall cycling) */
  animSequences: AnimSequence[] = [];

  /** Flat animation translation table (original picnum → current) */
  flatTranslation: number[] = [];

  /** Texture animation translation table (original picnum → current) */
  textureTranslation: number[] = [];

  /** Scrolling wall linedefs (linedef special 48) */
  scrollLines: SideDef[] = [];

  // === Per-session state (persists across levels) ===

  /** Current game state machine state */
  gamestate: GameState = GameState.GS_DEMOSCREEN;

  /** Deferred game action */
  gameaction: GameAction = GameAction.ga_nothing;

  /** Whether the menu overlay is active */
  menuactive = false;

  /** Whether a user game is in progress */
  usergame = false;

  /** Wipe state tracking */
  wipegamestate: GameState = GameState.GS_DEMOSCREEN;

  /** Pending save slot (-1 = quicksave) */
  pendingSaveSlot = 0;

  /** Pending warp map name (IDCLEV) */
  pendingWarpMap = '';

  /** Whether current exit is secret */
  secretExit = false;

  /** Pending episode for deferred new game (1-4, Doom I only) */
  pendingEpisode = 1;

  /** Pending skill for deferred new game */
  pendingSkill: SkillLevel = SkillLevel.sk_medium;

  /** Current game skill */
  gameskill: SkillLevel = SkillLevel.sk_medium;

  /** Fast monsters flag */
  fastMonsters = false;

  /** Pending next map name (after level completion, for intermission→worlddone) */
  pendingNextMap = '';

  /** Random number generator index */
  prndindex = 0;

  /** Automap display mode (0=OFF, 1=FULLSCREEN, 2=MINIMAP) */
  automapMode = 0;

  /** Automap cheat reveal level (0=normal, 1=all lines, 2=all lines+things) */
  automapRevealLevel = 0;

  // === Scratch contexts (reused across calls within a tic) ===

  /** Movement collision scratch state */
  move: MoveContext = createMoveContext();

  /** Combat/hitscan scratch state */
  combat: CombatContext = createCombatContext();

  /** Line-of-sight scratch state */
  sight: SightContext = createSightContext();

  // === Methods ===

  /** Reset per-level state for a new level load */
  resetLevel(): void {
    this.thinkers.length = 0;
    this.levelTime = 0;
    this.mapObjects.length = 0;
    this.nextMobjId = -1;
    this.thingIndexMap.clear();
    this.dyingMonsters.clear();
    this.droppedItems.length = 0;
    this.sectorLines.clear();
    this.sectorSpecialData.clear();
    this.activePlats.fill(null);
    this.activeCeilings.fill(null);
    this.savedSectorSpecials.length = 0;
    this.savedSectorLightLevels.length = 0;
    this.activeEffects.length = 0;
    this.activeProjectiles.length = 0;
    this.removedThings.clear();
    this.currentMap = null;
    this.validcount = 0;
    this.soundValidcount = 0;
    this.playerMobj = null;
    this.stats = createLevelStats();
    this.brainTargets.length = 0;
    this.brainTargetIndex = 0;
    this.bossBrainObj = null;
    this.bossEyeObj = null;
    this.brainDynamicCounter = -2000;
    this.animSequences.length = 0;
    this.flatTranslation.length = 0;
    this.textureTranslation.length = 0;
    this.scrollLines.length = 0;
  }
}

// ---- Factory functions ----

function createMoveContext(): MoveContext {
  return {
    tmFloorZ: 0,
    tmCeilingZ: 0,
    tmDropoffZ: 0,
    floatok: false,
    spechit: [],
  };
}

function createCombatContext(): CombatContext {
  return {
    linetarget: null,
    aimslope: 0,
    bulletslope: 0,
  };
}

function createSightContext(): SightContext {
  return {
    sightValidcount: 0,
    sightzstart: 0,
    topslope: 0,
    bottomslope: 0,
    straceX: 0,
    straceY: 0,
    straceDx: 0,
    straceDy: 0,
    t2x: 0,
    t2y: 0,
    sightMap: null,
  };
}

function createLevelStats(): LevelStats {
  return {
    totalKills: 0,
    totalItems: 0,
    totalSecrets: 0,
    playerKills: 0,
    playerItems: 0,
    playerSecrets: 0,
  };
}
