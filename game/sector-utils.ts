// ============================================================
// Sector Utilities — Shared state, constants, and helpers
// for doors, platforms, floors, and ceilings.
// Reference: p_spec.c, p_switch.c, p_local.h
// ============================================================

import { ML_TWOSIDED, type GameMap, type Sector, type LineDef } from './map-types';
import { FRACBITS, FRACUNIT } from './math';
import { Thinker, addThinker, removeThinker } from './thinkers';
import { FX_Sound, SoundOrigin } from './effects';
import { Sfx } from './sounds';
import { getMapObjects, damageMobj } from './mobj';
import { getWorld } from './world';

import { PLAYERHEIGHT } from './constants';

// ---- Constants (from p_spec.h / p_local.h) ----
export const VDOORSPEED = FRACUNIT * 2;    // Door speed
export const VDOORWAIT = 150;              // Tics to wait at top
export const PLATSPEED = FRACUNIT;         // Platform speed
export const PLATWAIT = 3;                 // Seconds (x35 for tics)
export const FLOORSPEED = FRACUNIT;        // Floor speed
export const MAXINT = 0x7FFFFFFF;
export const CEILSPEED = FRACUNIT;         // Normal ceiling speed
export const MAXCEILINGS = 30;
export const STAIRSPEED = FLOORSPEED;       // Normal stair speed
export const TURBOSTAIRSPEED = FLOORSPEED * 4; // Turbo stair speed
export const DONUT_SPEED = FLOORSPEED / 2; // DOOM uses FLOORSPEED/2 for donuts

// ---- Result enum for T_MovePlane ----
export enum MoveResult {
  ok,
  crushed,
  pastdest,
}

// ===============================================
// Sector shared state
// ===============================================
const sectorLines: Map<Sector, LineDef[]> = new Map();
const sectorSpecialData: Map<Sector, Thinker> = new Map();

let currentMap: GameMap;

export function getCurrentMap(): GameMap {
  return currentMap;
}

export function getSectorLines(): Map<Sector, LineDef[]> {
  return sectorLines;
}

export function getSectorSpecialData(): Map<Sector, Thinker> {
  return sectorSpecialData;
}

export function hasSectorSpecial(sec: Sector): boolean {
  return sectorSpecialData.has(sec);
}

export function setSectorSpecial(sec: Sector, thinker: Thinker): void {
  sectorSpecialData.set(sec, thinker);
}

export function getSectorSpecial(sec: Sector): Thinker | undefined {
  return sectorSpecialData.get(sec);
}

export function deleteSectorSpecial(sec: Sector): void {
  sectorSpecialData.delete(sec);
}

// ===============================================
// Active tracking arrays (forward-compatible typing)
// ===============================================
const activePlats: (Thinker | null)[] = new Array(30).fill(null);
const activeCeilings: (Thinker | null)[] = new Array(MAXCEILINGS).fill(null);

export function getActivePlats(): (Thinker | null)[] {
  return activePlats;
}

export function getActiveCeilings(): (Thinker | null)[] {
  return activeCeilings;
}

// ===============================================
// Init
// ===============================================
export function initSpecials(): void {
  currentMap = getWorld().map;
  sectorLines.clear();
  sectorSpecialData.clear();

  // Build sector -> lines lookup
  for (const line of currentMap.linedefs) {
    if (line.frontsector) {
      let arr = sectorLines.get(line.frontsector);
      if (!arr) { arr = []; sectorLines.set(line.frontsector, arr); }
      arr.push(line);
    }
    if (line.backsector && line.backsector !== line.frontsector) {
      let arr = sectorLines.get(line.backsector);
      if (!arr) { arr = []; sectorLines.set(line.backsector, arr); }
      arr.push(line);
    }
  }
}

// ===============================================
// Utility functions
// ===============================================

/** Get a sound origin for the center of a sector.
 *  Uses the sector's first line's midpoint as a rough approximation. */
export function sectorSoundOrg(sec: Sector): SoundOrigin {
  const lines = sectorLines.get(sec);
  if (lines && lines.length > 0) {
    const l = lines[0];
    const v1 = currentMap.vertices[l.v1];
    const v2 = currentMap.vertices[l.v2];
    return { x: (v1.x + v2.x) >> 1, y: (v1.y + v2.y) >> 1 };
  }
  return { x: 0, y: 0 };
}

/** Check if the player is standing inside a given sector */
export function playerInSector(sector: Sector): boolean {
  const playerRef = getWorld().player;
  if (!playerRef || !currentMap) return false;
  const ss = currentMap.pointInSubsector(playerRef.x, playerRef.y);
  return ss.sector === sector;
}

/** Apply 10 damage to all monsters standing inside the given sector.
 *  Matches original Doom's PIT_ChangeSector crush logic. */
export function crushMonstersInSector(sector: Sector): void {
  if (!currentMap) return;
  for (const obj of getMapObjects()) {
    if (obj.removed || obj.health <= 0) continue;
    // Check if this mobj is inside the sector
    const ss = currentMap.pointInSubsector(obj.x, obj.y);
    if (ss.sector === sector) {
      damageMobj(obj, 10);
    }
  }
}

// ===============================================
// T_MovePlane -- moves floor/ceiling of a sector
// Reference: p_floor.c T_MovePlane
// ===============================================
export function movePlane(
  sector: Sector,
  speed: number,
  dest: number,
  crush: boolean,
  floorOrCeiling: number, // 0=floor, 1=ceiling
  direction: number       // -1=down, 1=up
): MoveResult {
  if (floorOrCeiling === 0) {
    // FLOOR
    if (direction === -1) {
      // Floor moving down
      if (sector.floorHeight - speed < dest) {
        sector.floorHeight = dest;
        return MoveResult.pastdest;
      } else {
        sector.floorHeight -= speed;
      }
    } else {
      // Floor moving up
      if (sector.floorHeight + speed > dest) {
        sector.floorHeight = dest;
        return MoveResult.pastdest;
      } else {
        // Check if floor would crush player against ceiling
        const newFloor = sector.floorHeight + speed;
        if (newFloor + PLAYERHEIGHT > sector.ceilingHeight && playerInSector(sector)) {
          if (!crush) {
            sector.floorHeight = sector.ceilingHeight - PLAYERHEIGHT;
            return MoveResult.crushed;
          }
        }
        sector.floorHeight += speed;
      }
    }
  } else {
    // CEILING
    if (direction === -1) {
      // Ceiling moving down
      const newCeil = sector.ceilingHeight - speed;
      if (newCeil < dest) {
        sector.ceilingHeight = dest;
        return MoveResult.pastdest;
      } else {
        // Check if ceiling would crush player against floor
        if (newCeil < sector.floorHeight + PLAYERHEIGHT && playerInSector(sector)) {
          if (!crush) {
            // Don't move -- report crush so door can reverse
            return MoveResult.crushed;
          }
          // Crush mode: move anyway (crushing ceilings)
        }
        sector.ceilingHeight -= speed;
      }
    } else {
      // Ceiling moving up
      if (sector.ceilingHeight + speed > dest) {
        sector.ceilingHeight = dest;
        return MoveResult.pastdest;
      } else {
        sector.ceilingHeight += speed;
      }
    }
  }
  return MoveResult.ok;
}

// ===============================================
// Sector utility functions
// Reference: p_spec.c
// ===============================================

/** Find the sector on the other side of a two-sided line */
export function getNextSector(line: LineDef, sec: Sector, map: GameMap): Sector | null {
  if (!(line.flags & ML_TWOSIDED)) return null;
  if (line.frontsector === sec) return line.backsector;
  return line.frontsector;
}

/** Find lowest ceiling height in surrounding sectors */
export function findLowestCeilingSurrounding(sec: Sector, map: GameMap): number {
  let height = MAXINT;
  const lines = sectorLines.get(sec);
  if (!lines) return height;
  for (const line of lines) {
    const other = getNextSector(line, sec, map);
    if (!other) continue;
    if (other.ceilingHeight < height) height = other.ceilingHeight;
  }
  return height;
}

/** Find lowest floor height in surrounding sectors */
export function findLowestFloorSurrounding(sec: Sector, map: GameMap): number {
  let floor = sec.floorHeight;
  const lines = sectorLines.get(sec);
  if (!lines) return floor;
  for (const line of lines) {
    const other = getNextSector(line, sec, map);
    if (!other) continue;
    if (other.floorHeight < floor) floor = other.floorHeight;
  }
  return floor;
}

/** Find highest floor height in surrounding sectors */
export function findHighestFloorSurrounding(sec: Sector, map: GameMap): number {
  let floor = -500 * FRACUNIT;
  const lines = sectorLines.get(sec);
  if (!lines) return floor;
  for (const line of lines) {
    const other = getNextSector(line, sec, map);
    if (!other) continue;
    if (other.floorHeight > floor) floor = other.floorHeight;
  }
  return floor;
}

/** Find next highest floor in surrounding sectors above currentheight */
export function findNextHighestFloor(sec: Sector, currentheight: number, map: GameMap): number {
  const heights: number[] = [];
  const lines = sectorLines.get(sec);
  if (!lines) return currentheight;
  for (const line of lines) {
    const other = getNextSector(line, sec, map);
    if (!other) continue;
    if (other.floorHeight > currentheight) {
      heights.push(other.floorHeight);
    }
  }
  if (heights.length === 0) return currentheight;
  return Math.min(...heights);
}

/** Find highest ceiling height in surrounding sectors */
export function findHighestCeilingSurrounding(sec: Sector, map: GameMap): number {
  let height = 0;
  const lines = sectorLines.get(sec);
  if (!lines) return height;
  for (const line of lines) {
    const other = getNextSector(line, sec, map);
    if (!other) continue;
    if (other.ceilingHeight > height) height = other.ceilingHeight;
  }
  return height;
}

/** Find sectors by tag */
export function findSectorsFromTag(tag: number, map: GameMap): Sector[] {
  return map.sectors.filter(s => s.tag === tag);
}

// ===============================================
// Switch texture toggling
// Reference: p_switch.c
// ===============================================
const SWITCH_PAIRS: [string, string][] = [
  ['SW1BRCOM', 'SW2BRCOM'], ['SW1BRN1', 'SW2BRN1'],
  ['SW1BRN2', 'SW2BRN2'], ['SW1BRNGN', 'SW2BRNGN'],
  ['SW1BROWN', 'SW2BROWN'], ['SW1COMM', 'SW2COMM'],
  ['SW1COMP', 'SW2COMP'], ['SW1DIRT', 'SW2DIRT'],
  ['SW1EXIT', 'SW2EXIT'], ['SW1GRAY', 'SW2GRAY'],
  ['SW1GRAY1', 'SW2GRAY1'], ['SW1METAL', 'SW2METAL'],
  ['SW1PIPE', 'SW2PIPE'], ['SW1SLAD', 'SW2SLAD'],
  ['SW1STARG', 'SW2STARG'], ['SW1STON1', 'SW2STON1'],
  ['SW1STON2', 'SW2STON2'], ['SW1STONE', 'SW2STONE'],
  ['SW1STRTN', 'SW2STRTN'],
  // Registered episodes 2&3
  ['SW1BLUE', 'SW2BLUE'], ['SW1CMT', 'SW2CMT'],
  ['SW1GARG', 'SW2GARG'], ['SW1GSTON', 'SW2GSTON'],
  ['SW1HOT', 'SW2HOT'], ['SW1LION', 'SW2LION'],
  ['SW1SATYR', 'SW2SATYR'], ['SW1SKIN', 'SW2SKIN'],
  ['SW1VINE', 'SW2VINE'], ['SW1WOOD', 'SW2WOOD'],
  // DOOM II switches
  ['SW1PANEL', 'SW2PANEL'], ['SW1ROCK', 'SW2ROCK'],
  ['SW1MET2', 'SW2MET2'], ['SW1WDMET', 'SW2WDMET'],
  ['SW1BRIK', 'SW2BRIK'], ['SW1MOD1', 'SW2MOD1'],
  ['SW1ZIM', 'SW2ZIM'], ['SW1STON6', 'SW2STON6'],
  ['SW1TEK', 'SW2TEK'], ['SW1MARB', 'SW2MARB'],
  ['SW1SKULL', 'SW2SKULL'],
];

// Map: texture index -> its partner texture index
const switchMap: Map<number, number> = new Map();
let switchesInitialized = false;

// Platform-independent texture callbacks (injected at init)
export type TextureNameLookup = (name: string) => number;
export type TextureHeightLookup = (texIdx: number) => number;
let _textureHeight: TextureHeightLookup = () => FRACUNIT; // fallback

export function getTextureHeight(): TextureHeightLookup {
  return _textureHeight;
}

export function initSwitchList(
  textureNumForName: TextureNameLookup,
  textureHeight?: TextureHeightLookup,
): void {
  if (textureHeight) _textureHeight = textureHeight;
  switchMap.clear();
  for (const [name1, name2] of SWITCH_PAIRS) {
    const idx1 = textureNumForName(name1);
    const idx2 = textureNumForName(name2);
    // Skip if either texture is missing (-1) or is the no-texture sentinel (0)
    if (idx1 > 0 && idx2 > 0) {
      switchMap.set(idx1, idx2);
      switchMap.set(idx2, idx1);
    }
  }
  switchesInitialized = true;
}

export function changeSwitchTexture(line: LineDef, useAgain: boolean): void {
  if (!useAgain) line.special = 0;

  const side = currentMap.sidedefs[line.sidenum[0]];
  if (!side) return;

  // Check top, mid, bottom textures
  const texProps = ['topTexture', 'midTexture', 'bottomTexture'] as const;
  type TexProp = typeof texProps[number];
  for (const prop of texProps) {
    const tex = side[prop];
    if (tex === 0) continue; // 0 = no texture
    const partner = switchMap.get(tex);
    if (partner !== undefined) {
      // Switch sound: swtchn for turning on (SW1->SW2), swtchx for turning off (SW2->SW1)
      FX_Sound(null, useAgain ? Sfx.swtchn : Sfx.swtchx);
      (side as Record<TexProp, number>)[prop] = partner;
      return;
    }
  }
}

// ===============================================
// Save/Load helpers
// ===============================================

/** Clear sectorSpecialData and activePlats (for load -- before restoring) */
export function clearSpecialsState(): void {
  sectorSpecialData.clear();
  activePlats.fill(null);
}

/** Link a thinker to a sector (for load restore) */
export function linkSectorSpecial(sector: Sector, thinker: Thinker): void {
  sectorSpecialData.set(sector, thinker);
}

/** Add a platform to activePlats (for load restore) */
export function addActivePlat(plat: Thinker): void {
  for (let i = 0; i < activePlats.length; i++) {
    if (activePlats[i] === null) {
      activePlats[i] = plat;
      return;
    }
  }
}
