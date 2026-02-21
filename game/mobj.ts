// ============================================================
// Runtime Map Object State
// Lightweight mobj system for things that need runtime state
// (health, shootable flag, removal on death)
// Reference: p_mobj.h, p_mobj.c, info.c (mobjinfo[])
// ============================================================

import { FRACBITS, FRACUNIT } from './math';
import type { MapThing, GameMap } from './map-types';
import { GameInstance } from './game-instance';
import { getRemovedThings } from './pickups';
import { SkillLevel, isRespawnMonsters, isFastMonsters } from './skill';
import { P_Random } from './random';
import {
  setMonsterPain, setMonsterDeath, isMonsterDead, getThingAnimDef,
  setMonsterState,
} from './animations';
import { FX_RemoveDynLight, FX_Sound } from './effects';
import { spawnTeleportFog } from './vfx';
import { A_BossDeath } from './bossdeath';
import { Sfx } from './sounds';
import { shouldSpawnThing } from './skill';
import {
  MT, MobjInfo, mobjinfo, getMTForDoomedNum, isMonsterType,
  MF_AMBUSH, MF_COUNTKILL, MF_SHOOTABLE, MF_SOLID, MF_NOBLOOD,
  MF_CORPSE, MF_FLOAT, MF_NOGRAVITY, MF_SKULLFLY, MF_JUSTHIT,
} from './mobjinfo';

// Re-export flags for backward compatibility with combat.ts, etc.
export { MF_SHOOTABLE, MF_SOLID, MF_NOBLOOD, MF_COUNTKILL } from './mobjinfo';

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
  3004: { health: 20, radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 100 },  // Zombieman
  9: { health: 30, radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 100 },  // Shotgun Guy
  3001: { health: 60, radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 100 },  // Imp
  3002: { health: 150, radius: 30 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 400 },  // Demon
  58: { health: 150, radius: 30 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 400 },  // Spectre
  3006: { health: 400, radius: 16 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Cacodemon
  3005: { health: 1000, radius: 31 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Baron of Hell
  69: { health: 500, radius: 24 * FRACUNIT, height: 64 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 },  // Hell Knight
  3003: { health: 3000, radius: 128 * FRACUNIT, height: 100 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Spider Mastermind
  16: { health: 4000, radius: 40 * FRACUNIT, height: 110 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Cyberdemon
  72: { health: 500, radius: 16 * FRACUNIT, height: 72 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 600 },  // Keen (Commander)
  7: { health: 3000, radius: 128 * FRACUNIT, height: 100 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Spiderdemon
  68: { health: 600, radius: 64 * FRACUNIT, height: 64 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 600 },  // Arachnotron
  71: { health: 500, radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 500 },  // Pain Elemental
  65: { health: 300, radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 500 },  // Heavy Weapon Dude
  66: { health: 700, radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 500 },  // Revenant
  67: { health: 400, radius: 48 * FRACUNIT, height: 64 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 1000 }, // Mancubus
  64: { health: 700, radius: 20 * FRACUNIT, height: 56 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID | MF_COUNTKILL, mass: 500 },  // Arch-vile
  88: { health: 250, radius: 16 * FRACUNIT, height: 16 * FRACUNIT, flags: MF_SHOOTABLE | MF_SOLID, mass: 10000000 },  // Boss Brain (Icon of Sin)
};

// MTF_AMBUSH flag from MapThing options
const MTF_AMBUSH = 8;

// Direction constants for movedir
export const DI_EAST = 0;
export const DI_NORTHEAST = 1;
export const DI_NORTH = 2;
export const DI_NORTHWEST = 3;
export const DI_WEST = 4;
export const DI_SOUTHWEST = 5;
export const DI_SOUTH = 6;
export const DI_SOUTHEAST = 7;
export const DI_NODIR = 8;
export const NUMDIRS = 8;

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

/** Get all dropped items (for renderer and pickup system) */
export function getDroppedItems(gi: GameInstance): ReadonlyArray<DroppedItem> {
  return gi.droppedItems;
}

/** Remove a dropped item by index (when picked up) */
export function removeDroppedItem(index: number, gi: GameInstance): void {
  gi.droppedItems.splice(index, 1);
}

/** Clear dropped items (level change) */
export function clearDroppedItems(gi: GameInstance): void {
  gi.droppedItems.length = 0;
}

/** Initialize runtime state for all shootable things on the map */
export function initMapObjects(gi: GameInstance): void {
  const gameMap = gi.world!.map;
  gi.mapObjects = [];
  gi.nextMobjId = -1;

  const things = gameMap.things;
  for (let i = 0; i < things.length; i++) {
    const thing = things[i];

    // Difficulty filter: skip things not present on current skill
    if (!shouldSpawnThing(thing.options, gi)) continue;

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
      reactiontime: (gi.gameskill === SkillLevel.sk_nightmare) ? 0 : (mInfo ? mInfo.reactiontime : 8),
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
    gi.mapObjects.push(obj);

    // Count monsters for intermission stats
    if (fl & MF_COUNTKILL) {
      gi.stats.totalKills++;
    }
  }
  gi.dyingMonsters.clear();
  gi.droppedItems.length = 0;
  buildThingIndexMap(gi);
}

/** Get all live map objects */
export function getMapObjects(gi: GameInstance): MapObjState[] {
  return gi.mapObjects;
}

/** Build the thing index lookup map (called after init or load) */
function buildThingIndexMap(gi: GameInstance): void {
  gi.thingIndexMap.clear();
  for (const obj of gi.mapObjects) {
    gi.thingIndexMap.set(obj.thingIndex, obj);
  }
}

/**
 * Spawn a Lost Soul at a given position, charging toward a target.
 * Used by Pain Elemental's A_PainAttack and A_PainDie.
 *
 * Reference: A_PainShootSkull (p_enemy.c)
 */
export function spawnLostSoul(
  x: number, y: number, z: number,
  target: MapObjState,
  angle: number,
  gi: GameInstance,
): void {
  const mt = getMTForDoomedNum(3006); // Lost Soul
  if (mt === undefined) return;
  const mInfo = mobjinfo[mt];
  if (!mInfo) return;

  // Cap lost souls at 21 (original DOOM limit)
  let skullCount = 0;
  for (const obj of gi.mapObjects) {
    if (!obj.removed && obj.type === 3006) skullCount++;
  }
  if (skullCount >= 21) return;

  // Get floor/ceiling from world
  const map = gi.world?.map;
  if (!map) return;
  const ss = map.pointInSubsector(x, y);
  const floorZ = ss.sector ? ss.sector.floorHeight : 0;
  const ceilZ = ss.sector ? ss.sector.ceilingHeight : 0;

  const skull: MapObjState = {
    thingIndex: gi.nextMobjId--,
    x, y, z,
    health: mInfo.spawnhealth,
    spawnHealth: mInfo.spawnhealth,
    radius: mInfo.radius,
    height: mInfo.height,
    flags: mInfo.flags,
    mass: mInfo.mass,
    type: 3006,
    removed: false,
    deathHandled: false,
    mobjType: mt,
    angle,
    movedir: DI_NODIR,
    movecount: 0,
    target,
    threshold: 0,
    reactiontime: 0,
    lastlook: 0,
    momx: 0,
    momy: 0,
    momz: 0,
    floorz: floorZ,
    ceilingz: ceilZ,
    tracer: null,
    info: mInfo,
    spawnX: x,
    spawnY: y,
    spawnAngle: angle,
    respawnTimer: 0,
  };

  // Set charge momentum toward target (like A_SkullAttack)
  const SKULLSPEED = 20 * FRACUNIT;
  const dx = target.x - x;
  const dy = target.y - y;
  const dz = target.z + (target.height >> 1) - z;
  const dist = Math.max(1, Math.sqrt(
    (dx / FRACUNIT) * (dx / FRACUNIT) +
    (dy / FRACUNIT) * (dy / FRACUNIT) +
    (dz / FRACUNIT) * (dz / FRACUNIT)
  ));
  skull.momx = Math.round((dx / FRACUNIT) / dist * (SKULLSPEED / FRACUNIT)) * FRACUNIT;
  skull.momy = Math.round((dy / FRACUNIT) / dist * (SKULLSPEED / FRACUNIT)) * FRACUNIT;
  skull.momz = Math.round((dz / FRACUNIT) / dist * (SKULLSPEED / FRACUNIT)) * FRACUNIT;

  gi.mapObjects.push(skull);
  gi.thingIndexMap.set(skull.thingIndex, skull);
}

/** Get a MapObjState by its map thing index (O(1) via Map) */
export function getMapObjectByThingIndex(thingIndex: number, gi: GameInstance): MapObjState | undefined {
  return gi.thingIndexMap.get(thingIndex);
}

/** Replace map objects array (for save/load) */
export function setMapObjects(objs: MapObjState[], gi: GameInstance): void {
  gi.mapObjects = objs;
  gi.dyingMonsters.clear();
  buildThingIndexMap(gi);
}

/** Replace dropped items (for save/load) */
export function setDroppedItems(items: DroppedItem[], gi: GameInstance): void {
  gi.droppedItems.length = 0;
  gi.droppedItems.push(...items);
}

/** Get dying monsters set (for save) */
export function getDyingMonsters(gi: GameInstance): Set<number> {
  return gi.dyingMonsters;
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
  source: MapObjState | null | undefined,
  gi: GameInstance,
): boolean {
  if (!(target.flags & MF_SHOOTABLE)) return false;
  if (target.health <= 0) return false;

  target.health -= damage;

  if (target.health <= 0) {
    killMobj(target, gi);
    return true;
  }

  // Non-lethal hit: trigger pain animation (probability-based)
  if (!isBarrel(target.type)) {
    const animDef = getThingAnimDef(target.type);
    if (animDef && animDef.painChance !== undefined && animDef.painState !== undefined) {
      if (P_Random(gi) < animDef.painChance) {
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
function killMobj(target: MapObjState, gi: GameInstance): void {
  target.flags &= ~(MF_SHOOTABLE | MF_SOLID);
  target.flags |= MF_CORPSE;  // Mark as corpse for Arch-vile resurrection

  if (isBarrel(target.type)) {
    // Barrels: instant removal, explosion VFX spawned by combat.ts
    target.removed = true;
    getRemovedThings(gi).add(target.thingIndex);
    // Remove static barrel light
    FX_RemoveDynLight(target.x, target.y);
    return;
  }

  // Monsters: start death animation (don't add to removedThings!)
  // Determine overkill: health dropped below negative of spawn health
  const overkill = target.health < -target.spawnHealth;
  setMonsterDeath(target.thingIndex, target.type, overkill);
  gi.dyingMonsters.add(gi.mapObjects.indexOf(target));

  // Count the kill for intermission stats
  if (target.flags & MF_COUNTKILL) {
    gi.stats.playerKills++;
  }

  // Play death sound
  const animDef = getThingAnimDef(target.type);
  if (animDef) {
    if (overkill) {
      // XDeath = universal gib/slop sound
      FX_Sound({ x: target.x, y: target.y }, Sfx.slop);
    } else if (animDef.deathSound && animDef.deathSound.length > 0) {
      const sfx = animDef.deathSound[P_Random(gi) % animDef.deathSound.length];
      FX_Sound({ x: target.x, y: target.y }, sfx);
    }
  }

  // Check boss death triggers (tag 666/667)
  A_BossDeath(target, gi);
}

/**
 * Called each tick from the game loop.
 * Checks dying monsters for completed death animations and spawns drops.
 */
export function updateMonsterDeaths(gi: GameInstance): void {
  for (const idx of gi.dyingMonsters) {
    const obj = gi.mapObjects[idx];
    if (!obj || obj.deathHandled) continue;

    if (isMonsterDead(obj.thingIndex)) {
      obj.deathHandled = true;
      gi.dyingMonsters.delete(idx);

      // Spawn dropped item
      const animDef = getThingAnimDef(obj.type);
      if (animDef?.dropItem) {
        gi.droppedItems.push({
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
export function updateMobjFloorZ(gi: GameInstance): void {
  const currentMap = gi.world?.map;
  if (!currentMap) return;

  for (const obj of gi.mapObjects) {
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
export function tickMonsterRespawn(gi: GameInstance): void {
  if (!isRespawnMonsters(gi)) return;
  const currentMap = gi.world?.map;
  if (!currentMap) return;

  for (const obj of gi.mapObjects) {
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
      setMonsterState(obj.thingIndex, obj.type, animDef.spawnState, 'alive', gi);
    }

    // Spawn telefog VFX at respawn position (matching P_SpawnMobj(MT_TFOG) in original)
    spawnTeleportFog(obj.x, obj.y, obj.z, gi);
    FX_Sound({ x: obj.x, y: obj.y }, Sfx.telept);
  }
}
