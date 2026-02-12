// ============================================================
// Runtime Map Object State
// Lightweight mobj system for things that need runtime state
// (health, shootable flag, removal on death)
// Reference: p_mobj.h, p_mobj.c, info.c (mobjinfo[])
// ============================================================

import { FRACBITS, FRACUNIT } from '../math';
import { MapThing, GameMap } from '../map';
import { removedThings } from './pickups';
import { getGameSkill, SkillLevel, isRespawnMonsters, isFastMonsters } from './skill';
import { P_Random } from './random';
import {
  setMonsterPain, setMonsterDeath, isMonsterDead, getThingAnimDef,
  setMonsterState,
} from './animations';
import { FX_RemoveDynLight, FX_Sound } from '../../game/effects';
import { Sfx } from '../../game/sounds';
import { shouldSpawnThing } from './skill';
import {
  MT, MobjInfo, mobjinfo, getMTForDoomedNum, isMonsterType,
  MF_AMBUSH, MF_COUNTKILL, MF_SHOOTABLE, MF_SOLID, MF_NOBLOOD,
  MF_CORPSE, MF_FLOAT, MF_NOGRAVITY, MF_SKULLFLY, MF_JUSTHIT,
} from './mobjinfo';

// Re-export flags for backward compatibility with combat.ts, etc.
export { MF_SHOOTABLE, MF_SOLID, MF_NOBLOOD, MF_COUNTKILL } from './mobjinfo';
import { addTotalKill, addPlayerKill } from './intermission';

// ---- Combat info for thing types ----
export interface ThingCombatInfo {
  health: number;
  radius: number;  // fixed_t
  height: number;  // fixed_t
  flags: number;
  mass: number;
}

// Thing types that are shootable with their properties from mobjinfo[]
const THING_COMBAT_INFO: Record<number, ThingCombatInfo> = {
  // Barrel (MT_BARREL)
  2035: { health: 20, radius: 10 * FRACUNIT, height: 42 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_NOBLOOD, mass: 100 },

  // Monsters
  3004: { health: 20,  radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 100 },  // Zombieman
  9:    { health: 30,  radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 100 },  // Shotgun Guy
  3001: { health: 60,  radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 100 },  // Imp
  3002: { health: 150, radius: 30 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 400 },  // Demon
  58:   { health: 150, radius: 30 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 400 },  // Spectre
  3006: { health: 400, radius: 16 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Cacodemon
  3005: { health: 1000, radius: 31 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Baron of Hell
  69:   { health: 500, radius: 24 * FRACUNIT, height: 64 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 },  // Hell Knight
  3003: { health: 3000, radius: 128 * FRACUNIT, height: 100 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Spider Mastermind
  16:   { health: 4000, radius: 40 * FRACUNIT, height: 110 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Cyberdemon
  72:   { health: 500, radius: 16 * FRACUNIT, height: 72 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 600 },  // Keen (Commander)
  7:    { health: 3000, radius: 128 * FRACUNIT, height: 100 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Spiderdemon
  68:   { health: 600, radius: 64 * FRACUNIT, height: 64 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 600 },  // Arachnotron
  71:   { health: 500, radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 500 },  // Pain Elemental
  65:   { health: 300, radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 500 },  // Heavy Weapon Dude
  66:   { health: 700, radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 500 },  // Revenant
  67:   { health: 400, radius: 48 * FRACUNIT, height: 64 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Mancubus
  64:   { health: 700, radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 500 },  // Arch-vile
};

// MTF_AMBUSH flag from MapThing options
const MTF_AMBUSH = 8;

// Direction constants for movedir
export const DI_EAST      = 0;
export const DI_NORTHEAST = 1;
export const DI_NORTH     = 2;
export const DI_NORTHWEST = 3;
export const DI_WEST      = 4;
export const DI_SOUTHWEST = 5;
export const DI_SOUTH     = 6;
export const DI_SOUTHEAST = 7;
export const DI_NODIR     = 8;
export const NUMDIRS      = 8;

// ---- Runtime state for a map thing ----
export interface MapObjState {
  thingIndex: number;  // index into GameMap.things[]
  x: number;           // fixed_t
  y: number;           // fixed_t
  z: number;           // fixed_t (floor height of containing sector)
  health: number;
  spawnHealth: number;  // original health at spawn (for overkill/xdeath check)
  radius: number;      // fixed_t
  height: number;      // fixed_t
  flags: number;
  mass: number;
  type: number;        // thing type ID (DoomEd number)
  removed: boolean;
  deathHandled: boolean; // true after drop has been spawned

  // --- AI fields (Phase 1) ---
  mobjType: MT | -1;   // MT_* enum (-1 if not in mobjinfo)
  angle: number;       // BAM angle (facing direction)
  movedir: number;     // 0-8 (DI_EAST..DI_NODIR)
  movecount: number;   // ticks until direction change
  target: MapObjState | null;   // current chase/attack target
  threshold: number;   // ticks of "loyalty" to current target
  reactiontime: number; // ticks before first attack (8 at spawn)
  lastlook: number;    // last player index checked
  momx: number;        // momentum X (fixed_t)
  momy: number;        // momentum Y (fixed_t)
  momz: number;        // momentum Z (fixed_t)
  floorz: number;      // floor height at current position (fixed_t)
  ceilingz: number;    // ceiling height at current position (fixed_t)
  tracer: MapObjState | null;  // for Revenant homing, Arch-vile fire
  info: MobjInfo | null;       // pointer into mobjinfo table

  // --- Respawn fields (Nightmare) ---
  spawnX: number;      // original spawn X (fixed_t)
  spawnY: number;      // original spawn Y (fixed_t)
  spawnAngle: number;  // original spawn angle (BAM)
  respawnTimer: number; // tics until respawn (0 = not counting)
}

// ---- Dropped Items ----
export interface DroppedItem {
  x: number;        // fixed_t
  y: number;        // fixed_t
  z: number;        // fixed_t (floor height)
  thingType: number; // thing type for sprite lookup and pickup
}

const droppedItems: DroppedItem[] = [];

/** Get all dropped items (for renderer and pickup system) */
export function getDroppedItems(): ReadonlyArray<DroppedItem> {
  return droppedItems;
}

/** Remove a dropped item by index (when picked up) */
export function removeDroppedItem(index: number): void {
  droppedItems.splice(index, 1);
}

/** Clear dropped items (level change) */
export function clearDroppedItems(): void {
  droppedItems.length = 0;
}

// ---- Module state ----
let mapObjects: MapObjState[] = [];
let currentMap: GameMap | null = null;
/** Track mobj indices that are in dying state (for updateMonsterDeaths) */
const dyingMonsters: Set<number> = new Set();

/** Initialize runtime state for all shootable things on the map */
export function initMapObjects(gameMap: GameMap): void {
  currentMap = gameMap;
  mapObjects = [];

  const things = gameMap.things;
  for (let i = 0; i < things.length; i++) {
    const thing = things[i];

    // Difficulty filter: skip things not present on current skill
    if (!shouldSpawnThing(thing.options)) continue;

    // Try mobjinfo first (preferred), then legacy THING_COMBAT_INFO
    const mt = getMTForDoomedNum(thing.type);
    const mInfo = mt !== undefined ? mobjinfo[mt] : undefined;
    const combatInfo = THING_COMBAT_INFO[thing.type];

    // Must have either mobjinfo or combat info to be tracked
    if (!mInfo && !combatInfo) continue;

    // Get floor/ceiling height from the subsector at the thing's position
    const tx = thing.x << FRACBITS;
    const ty = thing.y << FRACBITS;
    const ss = gameMap.pointInSubsector(tx, ty);
    const floorZ = ss.sector ? ss.sector.floorHeight : 0;
    const ceilZ = ss.sector ? ss.sector.ceilingHeight : 0;

    // Use mobjinfo values if available, fall back to combat info
    const hp = mInfo ? mInfo.spawnhealth : combatInfo!.health;
    const rad = mInfo ? mInfo.radius : combatInfo!.radius;
    const ht = mInfo ? mInfo.height : combatInfo!.height;
    let fl = mInfo ? mInfo.flags : combatInfo!.flags;
    const ms = mInfo ? mInfo.mass : combatInfo!.mass;

    // Set MF_AMBUSH from MapThing options bit 3
    if (thing.options & MTF_AMBUSH) {
      fl |= MF_AMBUSH;
    }

    // Convert thing angle (degrees) to BAM
    const bamAngle = ((thing.angle * 0x100000000 / 360) >>> 0);

    const obj: MapObjState = {
      thingIndex: i,
      x: tx,
      y: ty,
      z: floorZ,
      health: hp,
      spawnHealth: hp,
      radius: rad,
      height: ht,
      flags: fl,
      mass: ms,
      type: thing.type,
      removed: false,
      deathHandled: false,
      // AI fields
      mobjType: mt !== undefined ? mt : -1,
      angle: bamAngle,
      movedir: DI_NODIR,
      movecount: 0,
      target: null,
      threshold: 0,
      reactiontime: (getGameSkill() === SkillLevel.sk_nightmare) ? 0 : (mInfo ? mInfo.reactiontime : 8),
      lastlook: 0,
      momx: 0,
      momy: 0,
      momz: 0,
      floorz: floorZ,
      ceilingz: ceilZ,
      tracer: null,
      info: mInfo || null,
      // Respawn fields
      spawnX: tx,
      spawnY: ty,
      spawnAngle: bamAngle,
      respawnTimer: 0,
    };
    mapObjects.push(obj);

    // Count monsters for intermission stats
    if (fl & MF_COUNTKILL) {
      addTotalKill();
    }
  }
  dyingMonsters.clear();
  droppedItems.length = 0;
  buildThingIndexMap();
}

/** Get all live map objects */
export function getMapObjects(): MapObjState[] {
  return mapObjects;
}

/** Fast lookup: map thing index → MapObjState */
const thingIndexMap = new Map<number, MapObjState>();

/** Build the thing index lookup map (called after init or load) */
function buildThingIndexMap(): void {
  thingIndexMap.clear();
  for (const obj of mapObjects) {
    thingIndexMap.set(obj.thingIndex, obj);
  }
}

/** Get a MapObjState by its map thing index (O(1) via Map) */
export function getMapObjectByThingIndex(thingIndex: number): MapObjState | undefined {
  return thingIndexMap.get(thingIndex);
}

/** Replace map objects array (for save/load) */
export function setMapObjects(objs: MapObjState[]): void {
  mapObjects = objs;
  dyingMonsters.clear();
  buildThingIndexMap();
}

/** Replace dropped items (for save/load) */
export function setDroppedItems(items: DroppedItem[]): void {
  droppedItems.length = 0;
  droppedItems.push(...items);
}

/** Get dying monsters set (for save) */
export function getDyingMonsters(): Set<number> {
  return dyingMonsters;
}

/** Get the current map reference */
export function getCurrentMap(): GameMap | null {
  return currentMap;
}

/** Check if a thing type is a barrel */
export function isBarrel(type: number): boolean {
  return type === 2035;
}

/**
 * P_DamageMobj — apply damage to a map object.
 * Triggers pain animation on non-lethal hits, death animation on kill.
 * Returns true if the target was killed.
 */
export function damageMobj(
  target: MapObjState,
  damage: number,
  source?: MapObjState | null
): boolean {
  if (!(target.flags & MF_SHOOTABLE)) return false;
  if (target.health <= 0) return false;

  target.health -= damage;

  if (target.health <= 0) {
    killMobj(target);
    return true;
  }

  // Non-lethal hit: trigger pain animation (probability-based)
  if (!isBarrel(target.type)) {
    const animDef = getThingAnimDef(target.type);
    if (animDef && animDef.painChance !== undefined && animDef.painState !== undefined) {
      if (P_Random() < animDef.painChance) {
        setMonsterPain(target.thingIndex, target.type);
        // Play pain sound
        if (animDef.painSound !== undefined) {
          FX_Sound({ x: target.x, y: target.y }, animDef.painSound);
        }
      }
    }

    // Infighting: if source is a different monster species, retarget
    if (source && source !== target
        && source.mobjType !== -1 && target.mobjType !== -1
        && source.mobjType !== target.mobjType) {
      const srcIsMon = isMonsterType(source.mobjType as MT);
      const tgtIsMon = isMonsterType(target.mobjType as MT);
      if (srcIsMon && tgtIsMon) {
        target.target = source;
        target.threshold = 100;
        target.flags |= MF_JUSTHIT;  // attack immediately
      }
    }
  }

  return false;
}

/**
 * Kill a map object.
 * - Barrels: instant removal (explosion handled by VFX/combat).
 * - Monsters: start death animation, stay on map as corpse.
 */
function killMobj(target: MapObjState): void {
  target.flags &= ~(MF_SHOOTABLE | MF_SOLID);

  if (isBarrel(target.type)) {
    // Barrels: instant removal, explosion VFX spawned by combat.ts
    target.removed = true;
    removedThings.add(target.thingIndex);
    // Remove static barrel light
    FX_RemoveDynLight(target.x, target.y);
    return;
  }

  // Monsters: start death animation (don't add to removedThings!)
  // Determine overkill: health dropped below negative of spawn health
  const overkill = target.health < -target.spawnHealth;
  setMonsterDeath(target.thingIndex, target.type, overkill);
  dyingMonsters.add(mapObjects.indexOf(target));

  // Count the kill for intermission stats
  if (target.flags & MF_COUNTKILL) {
    addPlayerKill();
  }

  // Play death sound
  const animDef = getThingAnimDef(target.type);
  if (animDef) {
    if (overkill) {
      // XDeath = universal gib/slop sound
      FX_Sound({ x: target.x, y: target.y }, Sfx.slop);
    } else if (animDef.deathSound && animDef.deathSound.length > 0) {
      const sfx = animDef.deathSound[P_Random() % animDef.deathSound.length];
      FX_Sound({ x: target.x, y: target.y }, sfx);
    }
  }
}

/**
 * Called each tick from the game loop.
 * Checks dying monsters for completed death animations and spawns drops.
 */
export function updateMonsterDeaths(): void {
  for (const idx of dyingMonsters) {
    const obj = mapObjects[idx];
    if (!obj || obj.deathHandled) continue;

    if (isMonsterDead(obj.thingIndex)) {
      obj.deathHandled = true;
      dyingMonsters.delete(idx);

      // Spawn dropped item
      const animDef = getThingAnimDef(obj.type);
      if (animDef?.dropItem) {
        droppedItems.push({
          x: obj.x,
          y: obj.y,
          z: obj.z,
          thingType: animDef.dropItem,
        });
      }
    }
  }
}

/**
 * updateMobjFloorZ — sync map object z with current sector floor.
 * Called each tick. Handles objects on moving floors (lifts, crushers).
 * In original DOOM, P_MobjThinker does this for every mobj.
 * Objects sitting on the floor follow it when it moves.
 */
export function updateMobjFloorZ(): void {
  if (!currentMap) return;

  for (const obj of mapObjects) {
    if (obj.removed) continue;

    // Look up current sector at object position
    const ss = currentMap.pointInSubsector(obj.x, obj.y);
    if (!ss.sector) continue;

    const newFloorZ = ss.sector.floorHeight;
    const newCeilZ = ss.sector.ceilingHeight;

    // Object was on the floor — keep it on the floor
    if (obj.z <= obj.floorz) {
      obj.z = newFloorZ;
    }
    // Object is above the new ceiling — push it down
    else if (obj.z + obj.height > newCeilZ) {
      obj.z = newCeilZ - obj.height;
    }
    // Object is below the new floor (floor rose under it) — push up
    else if (obj.z < newFloorZ) {
      obj.z = newFloorZ;
    }

    obj.floorz = newFloorZ;
    obj.ceilingz = newCeilZ;
  }
}

// ---- Nightmare monster respawn (~12 seconds = 420 tics) ----
const RESPAWN_TICS = 420;  // 12 * 35 = 420 tics

/**
 * tickMonsterRespawn — Nightmare-only monster respawn.
 * Dead monsters (MF_COUNTKILL) get a countdown timer.
 * When it expires, they respawn at their original spawn position.
 *
 * Reference: P_RespawnSpecials (p_mobj.c)
 * Called each tick from the game loop, only when isRespawnMonsters() is true.
 */
export function tickMonsterRespawn(): void {
  if (!isRespawnMonsters()) return;
  if (!currentMap) return;

  for (const obj of mapObjects) {
    if (obj.removed) continue;

    // Only respawn dead monsters (MF_COUNTKILL was set at spawn)
    if (obj.health > 0) continue;
    if (!obj.info) continue;
    if (!isMonsterType(obj.mobjType as MT)) continue;

    // Start countdown if not yet running
    if (obj.respawnTimer === 0) {
      obj.respawnTimer = RESPAWN_TICS;
    }

    obj.respawnTimer--;

    if (obj.respawnTimer > 0) continue;

    // ---- Respawn the monster ----

    // Restore position to original spawn point
    const ss = currentMap.pointInSubsector(obj.spawnX, obj.spawnY);
    const floorZ = ss.sector ? ss.sector.floorHeight : 0;
    const ceilZ = ss.sector ? ss.sector.ceilingHeight : 0;

    obj.x = obj.spawnX;
    obj.y = obj.spawnY;
    obj.z = floorZ;
    obj.floorz = floorZ;
    obj.ceilingz = ceilZ;
    obj.angle = obj.spawnAngle;

    // Restore health and flags from mobjinfo
    obj.health = obj.info.spawnhealth;
    obj.flags = obj.info.flags;
    obj.radius = obj.info.radius;
    obj.height = obj.info.height;

    // Reset AI state
    obj.target = null;
    obj.threshold = 0;
    obj.reactiontime = 0; // Nightmare: always 0
    obj.movedir = DI_NODIR;
    obj.movecount = 0;
    obj.momx = 0;
    obj.momy = 0;
    obj.momz = 0;
    obj.tracer = null;
    obj.deathHandled = false;
    obj.respawnTimer = 0;

    // Reset animation to spawn/idle state
    const animDef = getThingAnimDef(obj.type);
    if (animDef) {
      setMonsterState(obj.thingIndex, obj.type, animDef.spawnState, 'alive');
    }

    // TODO: Spawn telefog VFX at respawn position when VFX system supports it
  }
}
