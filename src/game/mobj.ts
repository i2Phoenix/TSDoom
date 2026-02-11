// ============================================================
// Runtime Map Object State
// Lightweight mobj system for things that need runtime state
// (health, shootable flag, removal on death)
// Reference: p_mobj.h, p_mobj.c, info.c (mobjinfo[])
// ============================================================

import { FRACBITS, FRACUNIT } from '../math';
import { MapThing, GameMap } from '../map';
import { removedThings } from './pickups';
import { P_Random } from './random';
import {
  setMonsterPain, setMonsterDeath, isMonsterDead, getThingAnimDef,
} from './animations';
import { removeDynLightAt } from '../render/dynlights';

// ---- Mobj flags (from p_mobj.h) ----
export const MF_SHOOTABLE = 0x00000004;  // Can be hit
export const MF_SOLID     = 0x00000002;  // Blocks movement
export const MF_NOBLOOD   = 0x00000800;  // Don't bleed when hit (barrels, etc.)
export const MF_COUNTKILL = 0x00400000;  // Count toward kill %

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
  type: number;        // thing type ID
  removed: boolean;
  deathHandled: boolean; // true after drop has been spawned
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
    const info = THING_COMBAT_INFO[thing.type];
    if (!info) continue; // Not a shootable thing

    // Get floor height from the subsector at the thing's position
    const tx = thing.x << FRACBITS;
    const ty = thing.y << FRACBITS;
    const ss = gameMap.pointInSubsector(tx, ty);
    const floorZ = ss.sector ? ss.sector.floorHeight : 0;

    mapObjects.push({
      thingIndex: i,
      x: tx,
      y: ty,
      z: floorZ,
      health: info.health,
      spawnHealth: info.health,
      radius: info.radius,
      height: info.height,
      flags: info.flags,
      mass: info.mass,
      type: thing.type,
      removed: false,
      deathHandled: false,
    });
  }
  dyingMonsters.clear();
  droppedItems.length = 0;
}

/** Get all live map objects */
export function getMapObjects(): MapObjState[] {
  return mapObjects;
}

/** Replace map objects array (for save/load) */
export function setMapObjects(objs: MapObjState[]): void {
  mapObjects = objs;
  dyingMonsters.clear();
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
  damage: number
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
    removeDynLightAt(target.x, target.y);
    return;
  }

  // Monsters: start death animation (don't add to removedThings!)
  // Determine overkill: health dropped below negative of spawn health
  const overkill = target.health < -target.spawnHealth;
  setMonsterDeath(target.thingIndex, target.type, overkill);
  dyingMonsters.add(mapObjects.indexOf(target));
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
