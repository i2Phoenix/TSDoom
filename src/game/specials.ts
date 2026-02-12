// ============================================================
// Sector Specials — Doors, Lifts, Floor Movers
// Reference: p_doors.c, p_plats.c, p_floor.c, p_spec.c, p_switch.c
// ============================================================

import { GameMap, Sector, LineDef, ML_TWOSIDED, ML_BLOCKING } from '../map';
import { FRACBITS, FRACUNIT, fixedMul, fixedDiv } from '../math';
import { Thinker, addThinker, removeThinker } from './thinkers';
import { G_ExitLevel, G_SecretExitLevel } from './mapflow';
import { SoundOrigin, S_StartSound } from '../sound/s_sound';
import { Sfx } from '../sound/sounds';
import { spawnTeleportFog } from './vfx';
import type { Player } from './player';
import type { MapObjState } from './mobj';

const PLAYERHEIGHT = 56 << FRACBITS;  // must match player.ts

// Player position reference for crush detection
let playerRef: { x: number; y: number; z: number } | null = null;

export function setPlayerRef(p: { x: number; y: number; z: number }): void {
  playerRef = p;
}

/** Get a sound origin for the center of a sector.
 *  Uses the sector's first line's midpoint as a rough approximation. */
function sectorSoundOrg(sec: Sector): SoundOrigin {
  const lines = sectorLines.get(sec);
  if (lines && lines.length > 0) {
    const l = lines[0];
    const v1 = currentMap.vertices[l.v1];
    const v2 = currentMap.vertices[l.v2];
    return { x: (v1.x + v2.x) >> 1, y: (v1.y + v2.y) >> 1 };
  }
  return { x: 0, y: 0 };
}

// ---- Constants (from p_spec.h / p_local.h) ----
const VDOORSPEED = FRACUNIT * 2;    // Door speed
const VDOORWAIT = 150;              // Tics to wait at top
const PLATSPEED = FRACUNIT;         // Platform speed
const PLATWAIT = 3;                 // Seconds (×35 for tics)
const FLOORSPEED = FRACUNIT;        // Floor speed
const MAXINT = 0x7FFFFFFF;

// ---- Result enum for T_MovePlane ----
enum MoveResult {
  ok,
  crushed,
  pastdest,
}

// ---- Door types ----
export enum DoorType {
  normal,       // open, wait, close
  close30ThenOpen,
  close,
  open,         // stay open
  raiseIn5Mins,
  blazeRaise,
  blazeOpen,
  blazeClose,
}

// ---- Platform types ----
export enum PlatType {
  downWaitUpStay,
  blazeDWUS,
  raiseAndChange,
  raiseToNearestAndChange,
  perpetualRaise,
}

export enum PlatStatus {
  up,
  down,
  waiting,
  in_stasis,
}

// ===============================================
// T_MovePlane — moves floor/ceiling of a sector
// Reference: p_floor.c T_MovePlane
// ===============================================

/** Check if the player is standing inside a given sector */
function playerInSector(sector: Sector): boolean {
  if (!playerRef || !currentMap) return false;
  const ss = currentMap.pointInSubsector(playerRef.x, playerRef.y);
  return ss.sector === sector;
}

function movePlane(
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
            // Don't move — report crush so door can reverse
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
function getNextSector(line: LineDef, sec: Sector, map: GameMap): Sector | null {
  if (!(line.flags & ML_TWOSIDED)) return null;
  if (line.frontsector === sec) return line.backsector;
  return line.frontsector;
}

/** Find lowest ceiling height in surrounding sectors */
function findLowestCeilingSurrounding(sec: Sector, map: GameMap): number {
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
function findLowestFloorSurrounding(sec: Sector, map: GameMap): number {
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
function findHighestFloorSurrounding(sec: Sector, map: GameMap): number {
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
function findNextHighestFloor(sec: Sector, currentheight: number, map: GameMap): number {
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

/** Find sectors by tag */
function findSectorsFromTag(tag: number, map: GameMap): Sector[] {
  return map.sectors.filter(s => s.tag === tag);
}

// ===============================================
// Sector → Lines mapping (built at init)
// ===============================================
const sectorLines: Map<Sector, LineDef[]> = new Map();
const sectorSpecialData: Map<Sector, Thinker> = new Map();

let currentMap: GameMap;

export function initSpecials(map: GameMap): void {
  currentMap = map;
  sectorLines.clear();
  sectorSpecialData.clear();

  // Build sector → lines lookup  
  for (const line of map.linedefs) {
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
// DOORS — T_VerticalDoor
// Reference: p_doors.c
// ===============================================
export interface DoorThinker extends Thinker {
  type: DoorType;
  sector: Sector;
  topheight: number;  // ceiling height to rise to
  speed: number;
  direction: number;  // 1=up, 0=wait, -1=down
  topwait: number;    // tics to wait at top
  topcountdown: number;
}

function doorTick(t: Thinker): void {
  const door = t as DoorThinker;

  switch (door.direction) {
    case 0: // WAITING
      if (--door.topcountdown <= 0) {
        switch (door.type) {
          case DoorType.blazeRaise:
          case DoorType.normal:
            door.direction = -1; // time to go back down
            S_StartSound(sectorSoundOrg(door.sector), Sfx.dorcls);
            break;
          case DoorType.close30ThenOpen:
            door.direction = 1;
            S_StartSound(sectorSoundOrg(door.sector), Sfx.doropn);
            break;
        }
      }
      break;

    case 2: // INITIAL WAIT
      if (--door.topcountdown <= 0) {
        if (door.type === DoorType.raiseIn5Mins) {
          door.direction = 1;
          door.type = DoorType.normal;
        }
      }
      break;

    case -1: { // DOWN
      const res = movePlane(door.sector, door.speed,
        door.sector.floorHeight, false, 1, door.direction);
      if (res === MoveResult.pastdest) {
        switch (door.type) {
          case DoorType.blazeRaise:
          case DoorType.blazeClose:
          case DoorType.normal:
          case DoorType.close:
            S_StartSound(sectorSoundOrg(door.sector), Sfx.dorcls);
            sectorSpecialData.delete(door.sector);
            removeThinker(door);
            break;
          case DoorType.close30ThenOpen:
            door.direction = 0;
            door.topcountdown = 35 * 30;
            break;
        }
      } else if (res === MoveResult.crushed) {
        switch (door.type) {
          case DoorType.blazeClose:
          case DoorType.close:
            break; // DO NOT GO BACK UP
          default:
            door.direction = 1;
            S_StartSound(sectorSoundOrg(door.sector), Sfx.doropn);
            break;
        }
      }
      break;
    }

    case 1: { // UP
      const res = movePlane(door.sector, door.speed,
        door.topheight, false, 1, door.direction);
      if (res === MoveResult.pastdest) {
        switch (door.type) {
          case DoorType.blazeRaise:
          case DoorType.normal:
            door.direction = 0; // wait at top
            door.topcountdown = door.topwait;
            break;
          case DoorType.close30ThenOpen:
          case DoorType.blazeOpen:
          case DoorType.open:
            sectorSpecialData.delete(door.sector);
            removeThinker(door);
            break;
        }
      }
      break;
    }
  }
}

/**
 * EV_DoDoor — open doors by tag
 * Reference: p_doors.c
 */
function evDoDoor(line: LineDef, type: DoorType): boolean {
  let rtn = false;
  const sectors = findSectorsFromTag(line.tag, currentMap);

  for (const sec of sectors) {
    if (sectorSpecialData.has(sec)) continue;

    rtn = true;
    const door: DoorThinker = {
      action: doorTick,
      removed: false,
      type,
      sector: sec,
      topheight: 0,
      speed: VDOORSPEED,
      direction: 0,
      topwait: VDOORWAIT,
      topcountdown: 0,
    };

    switch (type) {
      case DoorType.blazeClose:
        door.topheight = findLowestCeilingSurrounding(sec, currentMap) - 4 * FRACUNIT;
        door.direction = -1;
        door.speed = VDOORSPEED * 4;
        break;
      case DoorType.close:
        door.topheight = findLowestCeilingSurrounding(sec, currentMap) - 4 * FRACUNIT;
        door.direction = -1;
        break;
      case DoorType.close30ThenOpen:
        door.topheight = sec.ceilingHeight;
        door.direction = -1;
        break;
      case DoorType.blazeRaise:
      case DoorType.blazeOpen:
        door.direction = 1;
        door.topheight = findLowestCeilingSurrounding(sec, currentMap) - 4 * FRACUNIT;
        door.speed = VDOORSPEED * 4;
        break;
      case DoorType.normal:
      case DoorType.open:
        door.direction = 1;
        door.topheight = findLowestCeilingSurrounding(sec, currentMap) - 4 * FRACUNIT;
        break;
    }

    S_StartSound(sectorSoundOrg(sec), door.direction === 1 ? Sfx.doropn : Sfx.dorcls);
    addThinker(door);
    sectorSpecialData.set(sec, door);
  }
  return rtn;
}


/**
 * EV_VerticalDoor — manual door (no tag, uses back sector)
 * Reference: p_doors.c
 */
function evVerticalDoor(line: LineDef, player: Player | null): void {
  // Check for locks (DOOM: p_doors.c EV_VerticalDoor)
  if (player) {
    switch (line.special) {
      case 26: // Blue Lock
      case 32:
        if (!player.keys[0] && !player.keys[3]) {
          player.message = 'You need a blue key to open this door';
          S_StartSound(null, Sfx.oof);
          return;
        }
        break;
      case 27: // Yellow Lock
      case 34:
        if (!player.keys[1] && !player.keys[4]) {
          player.message = 'You need a yellow key to open this door';
          S_StartSound(null, Sfx.oof);
          return;
        }
        break;
      case 28: // Red Lock
      case 33:
        if (!player.keys[2] && !player.keys[5]) {
          player.message = 'You need a red key to open this door';
          S_StartSound(null, Sfx.oof);
          return;
        }
        break;
    }
  }

  // Get the back sector (door sector)
  const sideIdx = line.sidenum[1];
  if (sideIdx === -1 || sideIdx === 0xFFFF) return;
  
  const sec = currentMap.sidedefs[sideIdx]?.sector;
  if (!sec) return;

  // If the sector already has a thinker, toggle direction
  if (sectorSpecialData.has(sec)) {
    const existing = sectorSpecialData.get(sec) as DoorThinker;
    switch (line.special) {
      case 1: case 26: case 27: case 28: case 117:
        if (existing.direction === -1) {
          existing.direction = 1; // go back up
        } else {
          existing.direction = -1; // start going down
        }
        return;
    }
    return;
  }

  // Create new door
  const door: DoorThinker = {
    action: doorTick,
    removed: false,
    type: DoorType.normal,
    sector: sec,
    topheight: 0,
    speed: VDOORSPEED,
    direction: 1,
    topwait: VDOORWAIT,
    topcountdown: 0,
  };

  switch (line.special) {
    case 1: case 26: case 27: case 28:
      door.type = DoorType.normal;
      break;
    case 31: case 32: case 33: case 34:
      door.type = DoorType.open;
      line.special = 0; // one-shot
      break;
    case 117:
      door.type = DoorType.blazeRaise;
      door.speed = VDOORSPEED * 4;
      break;
    case 118:
      door.type = DoorType.blazeOpen;
      line.special = 0;
      door.speed = VDOORSPEED * 4;
      break;
  }

  door.topheight = findLowestCeilingSurrounding(sec, currentMap) - 4 * FRACUNIT;

  S_StartSound(sectorSoundOrg(sec), Sfx.doropn);
  addThinker(door);
  sectorSpecialData.set(sec, door);
}

/**
 * EV_DoLockedDoor — open locked doors by tag (switch/button-triggered)
 * Reference: p_doors.c EV_DoLockedDoor
 * Checks key, sets message if locked, then delegates to evDoDoor.
 */
function evDoLockedDoor(line: LineDef, type: DoorType, player: Player | null): boolean {
  if (!player) return false;

  switch (line.special) {
    case 99:  // Blue Lock
    case 133:
      if (!player.keys[0] && !player.keys[3]) {
        player.message = 'You need a blue key to activate this object';
        S_StartSound(null, Sfx.oof);
        return false;
      }
      break;
    case 134: // Red Lock
    case 135:
      if (!player.keys[2] && !player.keys[5]) {
        player.message = 'You need a red key to activate this object';
        S_StartSound(null, Sfx.oof);
        return false;
      }
      break;
    case 136: // Yellow Lock
    case 137:
      if (!player.keys[1] && !player.keys[4]) {
        player.message = 'You need a yellow key to activate this object';
        S_StartSound(null, Sfx.oof);
        return false;
      }
      break;
  }

  return evDoDoor(line, type);
}

// ===============================================
// PLATFORMS — T_PlatRaise
// Reference: p_plats.c
// ===============================================
export interface PlatThinker extends Thinker {
  type: PlatType;
  sector: Sector;
  speed: number;
  low: number;
  high: number;
  wait: number;
  count: number;
  status: PlatStatus;
  oldstatus: PlatStatus;
  crush: boolean;
  tag: number;
}

const activePlats: (PlatThinker | null)[] = new Array(30).fill(null);

function platTick(t: Thinker): void {
  const plat = t as PlatThinker;

  switch (plat.status) {
    case PlatStatus.up: {
      const res = movePlane(plat.sector, plat.speed, plat.high, plat.crush, 0, 1);
      if (res === MoveResult.crushed && !plat.crush) {
        plat.count = plat.wait;
        plat.status = PlatStatus.down;
      } else if (res === MoveResult.pastdest) {
        plat.count = plat.wait;
        plat.status = PlatStatus.waiting;
        S_StartSound(sectorSoundOrg(plat.sector), Sfx.pstop);
        switch (plat.type) {
          case PlatType.blazeDWUS:
          case PlatType.downWaitUpStay:
          case PlatType.raiseAndChange:
          case PlatType.raiseToNearestAndChange:
            removeActivePlat(plat);
            break;
        }
      }
      break;
    }

    case PlatStatus.down: {
      const res = movePlane(plat.sector, plat.speed, plat.low, false, 0, -1);
      if (res === MoveResult.pastdest) {
        plat.count = plat.wait;
        plat.status = PlatStatus.waiting;
        S_StartSound(sectorSoundOrg(plat.sector), Sfx.pstop);
      }
      break;
    }

    case PlatStatus.waiting:
      if (--plat.count <= 0) {
        if (plat.sector.floorHeight === plat.low) {
          plat.status = PlatStatus.up;
        } else {
          plat.status = PlatStatus.down;
        }
        S_StartSound(sectorSoundOrg(plat.sector), Sfx.pstart);
      }
      break;

    case PlatStatus.in_stasis:
      break;
  }
}

function removeActivePlat(plat: PlatThinker): void {
  for (let i = 0; i < activePlats.length; i++) {
    if (activePlats[i] === plat) {
      sectorSpecialData.delete(plat.sector);
      removeThinker(plat);
      activePlats[i] = null;
      return;
    }
  }
}

/**
 * EV_DoPlat — activate platforms by tag
 * Reference: p_plats.c
 */
function evDoPlat(line: LineDef, type: PlatType, amount: number): boolean {
  let rtn = false;
  const sectors = findSectorsFromTag(line.tag, currentMap);

  for (const sec of sectors) {
    if (sectorSpecialData.has(sec)) continue;

    rtn = true;
    const plat: PlatThinker = {
      action: platTick,
      removed: false,
      type,
      sector: sec,
      speed: 0,
      low: 0,
      high: 0,
      wait: 0,
      count: 0,
      status: PlatStatus.up,
      oldstatus: PlatStatus.up,
      crush: false,
      tag: line.tag,
    };

    switch (type) {
      case PlatType.raiseToNearestAndChange:
        plat.speed = PLATSPEED / 2;
        plat.high = findNextHighestFloor(sec, sec.floorHeight, currentMap);
        plat.wait = 0;
        plat.status = PlatStatus.up;
        sec.special = 0;
        break;
      case PlatType.raiseAndChange:
        plat.speed = PLATSPEED / 2;
        plat.high = sec.floorHeight + amount * FRACUNIT;
        plat.wait = 0;
        plat.status = PlatStatus.up;
        break;
      case PlatType.downWaitUpStay:
        plat.speed = PLATSPEED * 4;
        plat.low = findLowestFloorSurrounding(sec, currentMap);
        if (plat.low > sec.floorHeight) plat.low = sec.floorHeight;
        plat.high = sec.floorHeight;
        plat.wait = 35 * PLATWAIT;
        plat.status = PlatStatus.down;
        break;
      case PlatType.blazeDWUS:
        plat.speed = PLATSPEED * 8;
        plat.low = findLowestFloorSurrounding(sec, currentMap);
        if (plat.low > sec.floorHeight) plat.low = sec.floorHeight;
        plat.high = sec.floorHeight;
        plat.wait = 35 * PLATWAIT;
        plat.status = PlatStatus.down;
        break;
      case PlatType.perpetualRaise:
        plat.speed = PLATSPEED;
        plat.low = findLowestFloorSurrounding(sec, currentMap);
        if (plat.low > sec.floorHeight) plat.low = sec.floorHeight;
        plat.high = findHighestFloorSurrounding(sec, currentMap);
        if (plat.high < sec.floorHeight) plat.high = sec.floorHeight;
        plat.wait = 35 * PLATWAIT;
        plat.status = Math.random() > 0.5 ? PlatStatus.up : PlatStatus.down;
        break;
    }

    S_StartSound(sectorSoundOrg(sec), Sfx.pstart);
    addThinker(plat);
    sectorSpecialData.set(sec, plat);
    addActivePlat(plat);
  }
  return rtn;
}

// ===============================================
// FLOOR MOVERS — T_MoveFloor
// Reference: p_floor.c
// ===============================================
export enum FloorType {
  lowerFloor,
  lowerFloorToLowest,
  turboLower,
  raiseFloor,
  raiseFloorToNearest,
  raiseFloorCrush,
  raiseFloorTurbo,
  raiseFloor24,
  raiseFloor24AndChange,
  raiseFloor512,
  raiseToTexture,
  lowerAndChange,
}

export interface FloorThinker extends Thinker {
  type: FloorType;
  sector: Sector;
  speed: number;
  floordestheight: number;
  crush: boolean;
  direction: number;
}

function floorTick(t: Thinker): void {
  const floor = t as FloorThinker;
  const res = movePlane(floor.sector, floor.speed,
    floor.floordestheight, floor.crush, 0, floor.direction);

  if (res === MoveResult.pastdest) {
    sectorSpecialData.delete(floor.sector);
    removeThinker(floor);
  }
}

function evDoFloor(line: LineDef, floortype: FloorType): boolean {
  let rtn = false;
  const sectors = findSectorsFromTag(line.tag, currentMap);

  for (const sec of sectors) {
    if (sectorSpecialData.has(sec)) continue;

    rtn = true;
    const floor: FloorThinker = {
      action: floorTick,
      removed: false,
      type: floortype,
      sector: sec,
      speed: FLOORSPEED,
      floordestheight: 0,
      crush: false,
      direction: 0,
    };

    switch (floortype) {
      case FloorType.lowerFloor:
        floor.direction = -1;
        floor.floordestheight = findHighestFloorSurrounding(sec, currentMap);
        break;
      case FloorType.lowerFloorToLowest:
        floor.direction = -1;
        floor.floordestheight = findLowestFloorSurrounding(sec, currentMap);
        break;
      case FloorType.turboLower:
        floor.direction = -1;
        floor.speed = FLOORSPEED * 4;
        floor.floordestheight = findHighestFloorSurrounding(sec, currentMap);
        if (floor.floordestheight !== sec.floorHeight) {
          floor.floordestheight += 8 * FRACUNIT;
        }
        break;
      case FloorType.raiseFloorCrush:
        floor.crush = true;
        floor.direction = 1;
        floor.floordestheight = findLowestCeilingSurrounding(sec, currentMap);
        if (floor.floordestheight > sec.ceilingHeight) {
          floor.floordestheight = sec.ceilingHeight;
        }
        floor.floordestheight -= 8 * FRACUNIT;
        break;
      case FloorType.raiseFloor:
        floor.direction = 1;
        floor.floordestheight = findLowestCeilingSurrounding(sec, currentMap);
        if (floor.floordestheight > sec.ceilingHeight) {
          floor.floordestheight = sec.ceilingHeight;
        }
        break;
      case FloorType.raiseFloorTurbo:
        floor.direction = 1;
        floor.speed = FLOORSPEED * 4;
        floor.floordestheight = findNextHighestFloor(sec, sec.floorHeight, currentMap);
        break;
      case FloorType.raiseFloorToNearest:
        floor.direction = 1;
        floor.floordestheight = findNextHighestFloor(sec, sec.floorHeight, currentMap);
        break;
      case FloorType.raiseFloor24:
        floor.direction = 1;
        floor.floordestheight = sec.floorHeight + 24 * FRACUNIT;
        break;
      case FloorType.raiseFloor512:
        floor.direction = 1;
        floor.floordestheight = sec.floorHeight + 512 * FRACUNIT;
        break;
    }

    addThinker(floor);
    sectorSpecialData.set(sec, floor);
  }
  return rtn;
}

// ===============================================
// STAIR BUILDING — EV_BuildStairs
// Reference: p_floor.c EV_BuildStairs
// ===============================================

const STAIRSPEED = FLOORSPEED;       // Normal stair speed
const TURBOSTAIRSPEED = FLOORSPEED * 4; // Turbo stair speed

/**
 * EV_BuildStairs — build stairs from tagged sectors.
 * Finds sectors by tag, then cascades through neighbors with matching
 * floor texture, raising each sector by stepSize more than the previous.
 * Reference: p_floor.c EV_BuildStairs
 */
function evBuildStairs(line: LineDef, turbo: boolean): boolean {
  const stepSize = turbo ? (16 << FRACBITS) : (8 << FRACBITS);
  const speed = turbo ? TURBOSTAIRSPEED : STAIRSPEED;

  let rtn = false;
  const sectors = findSectorsFromTag(line.tag, currentMap);

  for (const sec of sectors) {
    if (sectorSpecialData.has(sec)) continue;

    rtn = true;
    let height = sec.floorHeight + stepSize;
    const stairFloorPic = sec.floorPic;

    // Create floor mover for the first sector
    const firstFloor: FloorThinker = {
      action: floorTick,
      removed: false,
      type: FloorType.raiseFloor,
      sector: sec,
      speed,
      floordestheight: height,
      crush: false,
      direction: 1,
    };
    addThinker(firstFloor);
    sectorSpecialData.set(sec, firstFloor);

    // Cascade through neighboring sectors with same floor texture
    let prevSec = sec;
    let ok = true;
    while (ok) {
      ok = false;
      const lines = sectorLines.get(prevSec);
      if (!lines) break;

      for (const sline of lines) {
        // Must be two-sided
        if (!(sline.flags & ML_TWOSIDED)) continue;

        // Get the sector on the other side
        const nextSec = sline.frontsector === prevSec
          ? sline.backsector
          : (sline.backsector === prevSec ? sline.frontsector : null);
        if (!nextSec) continue;

        // Must have the same floor texture
        if (nextSec.floorPic !== stairFloorPic) continue;

        // Already has a thinker — skip
        if (sectorSpecialData.has(nextSec)) continue;

        // Found next stair sector
        height += stepSize;
        const nextFloor: FloorThinker = {
          action: floorTick,
          removed: false,
          type: FloorType.raiseFloor,
          sector: nextSec,
          speed,
          floordestheight: height,
          crush: false,
          direction: 1,
        };
        addThinker(nextFloor);
        sectorSpecialData.set(nextSec, nextFloor);

        prevSec = nextSec;
        ok = true;
        break; // restart search from the new sector
      }
    }
  }

  return rtn;
}

// ===============================================
// CRUSHING CEILINGS — T_MoveCeiling
// Reference: p_ceilng.c
// ===============================================

const CEILSPEED = FRACUNIT;       // Normal ceiling speed
const MAXCEILINGS = 30;

export enum CeilingType {
  lowerToFloor,
  raiseToHighest,
  lowerAndCrush,
  crushAndRaise,
  fastCrushAndRaise,
  silentCrushAndRaise,
}

export interface CeilingThinker extends Thinker {
  type: CeilingType;
  sector: Sector;
  bottomheight: number;
  topheight: number;
  speed: number;
  crush: boolean;
  direction: number;    // -1=down, 0=stasis, 1=up
  olddirection: number; // saved direction when in stasis
  tag: number;
}

const activeCeilings: (CeilingThinker | null)[] = new Array(MAXCEILINGS).fill(null);

/** Find highest ceiling height in surrounding sectors */
function findHighestCeilingSurrounding(sec: Sector, map: GameMap): number {
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

/** Track tick count for sound timing (ceiling movement sounds every 8 tics) */
let ceilingTick_counter = 0;
export function tickCeilingCounter(): void { ceilingTick_counter++; }

function ceilingTick(t: Thinker): void {
  const ceiling = t as CeilingThinker;

  switch (ceiling.direction) {
    case 0: // IN STASIS
      break;

    case 1: { // UP
      const res = movePlane(ceiling.sector, ceiling.speed,
        ceiling.topheight, false, 1, ceiling.direction);

      // Play movement sound every 8 tics (not for silent type)
      if (!(ceilingTick_counter & 7)) {
        if (ceiling.type !== CeilingType.silentCrushAndRaise) {
          S_StartSound(sectorSoundOrg(ceiling.sector), Sfx.stnmov);
        }
      }

      if (res === MoveResult.pastdest) {
        if (ceiling.type === CeilingType.raiseToHighest) {
          removeActiveCeiling(ceiling);
        } else if (ceiling.type === CeilingType.silentCrushAndRaise) {
          S_StartSound(sectorSoundOrg(ceiling.sector), Sfx.pstop);
          ceiling.direction = -1;
        } else if (ceiling.type === CeilingType.fastCrushAndRaise ||
                   ceiling.type === CeilingType.crushAndRaise) {
          ceiling.direction = -1;
        }
      }
      break;
    }

    case -1: { // DOWN
      const res = movePlane(ceiling.sector, ceiling.speed,
        ceiling.bottomheight, ceiling.crush, 1, ceiling.direction);

      // Play movement sound every 8 tics (not for silent type)
      if (!(ceilingTick_counter & 7)) {
        if (ceiling.type !== CeilingType.silentCrushAndRaise) {
          S_StartSound(sectorSoundOrg(ceiling.sector), Sfx.stnmov);
        }
      }

      if (res === MoveResult.pastdest) {
        if (ceiling.type === CeilingType.silentCrushAndRaise) {
          S_StartSound(sectorSoundOrg(ceiling.sector), Sfx.pstop);
          ceiling.speed = CEILSPEED;
          ceiling.direction = 1;
        } else if (ceiling.type === CeilingType.crushAndRaise) {
          ceiling.speed = CEILSPEED;
          ceiling.direction = 1;
        } else if (ceiling.type === CeilingType.fastCrushAndRaise) {
          ceiling.direction = 1;
        } else if (ceiling.type === CeilingType.lowerAndCrush ||
                   ceiling.type === CeilingType.lowerToFloor) {
          removeActiveCeiling(ceiling);
        }
      } else if (res === MoveResult.crushed) {
        // Slow down when actively crushing something
        switch (ceiling.type) {
          case CeilingType.silentCrushAndRaise:
          case CeilingType.crushAndRaise:
          case CeilingType.lowerAndCrush:
            ceiling.speed = CEILSPEED >> 3; // CEILSPEED / 8
            break;
          default:
            break;
        }

        // Apply crush damage to player (10 hp per contact)
        if (playerRef && playerInSector(ceiling.sector)) {
          // Damage will be applied via the player's sector damage check
          // Here we signal it by narrowing the gap
        }
      }
      break;
    }
  }
}

function addActiveCeiling(ceiling: CeilingThinker): void {
  for (let i = 0; i < MAXCEILINGS; i++) {
    if (activeCeilings[i] === null) {
      activeCeilings[i] = ceiling;
      return;
    }
  }
}

function removeActiveCeiling(ceiling: CeilingThinker): void {
  for (let i = 0; i < MAXCEILINGS; i++) {
    if (activeCeilings[i] === ceiling) {
      sectorSpecialData.delete(ceiling.sector);
      removeThinker(ceiling);
      activeCeilings[i] = null;
      return;
    }
  }
}

/** Reactivate ceilings that were put in stasis (for same tag) */
function activateInStasisCeiling(line: LineDef): void {
  for (let i = 0; i < MAXCEILINGS; i++) {
    const c = activeCeilings[i];
    if (c && c.tag === line.tag && c.direction === 0) {
      c.direction = c.olddirection;
      // Re-enable the thinker action
      c.action = ceilingTick;
    }
  }
}

/**
 * EV_DoCeiling — move a ceiling up/down.
 * Reference: p_ceilng.c EV_DoCeiling
 */
function evDoCeiling(line: LineDef, type: CeilingType): boolean {
  // Reactivate in-stasis ceilings for crush types
  switch (type) {
    case CeilingType.fastCrushAndRaise:
    case CeilingType.silentCrushAndRaise:
    case CeilingType.crushAndRaise:
      activateInStasisCeiling(line);
      break;
    default:
      break;
  }

  let rtn = false;
  const sectors = findSectorsFromTag(line.tag, currentMap);

  for (const sec of sectors) {
    if (sectorSpecialData.has(sec)) continue;

    rtn = true;
    const ceiling: CeilingThinker = {
      action: ceilingTick,
      removed: false,
      type,
      sector: sec,
      bottomheight: 0,
      topheight: 0,
      speed: CEILSPEED,
      crush: false,
      direction: 0,
      olddirection: 0,
      tag: sec.tag,
    };

    switch (type) {
      case CeilingType.fastCrushAndRaise:
        ceiling.crush = true;
        ceiling.topheight = sec.ceilingHeight;
        ceiling.bottomheight = sec.floorHeight + (8 << FRACBITS);
        ceiling.direction = -1;
        ceiling.speed = CEILSPEED * 2;
        break;
      case CeilingType.silentCrushAndRaise:
      case CeilingType.crushAndRaise:
        ceiling.crush = true;
        ceiling.topheight = sec.ceilingHeight;
        ceiling.bottomheight = sec.floorHeight + (8 << FRACBITS);
        ceiling.direction = -1;
        ceiling.speed = CEILSPEED;
        break;
      case CeilingType.lowerAndCrush:
        ceiling.bottomheight = sec.floorHeight + (8 << FRACBITS);
        ceiling.direction = -1;
        ceiling.speed = CEILSPEED;
        break;
      case CeilingType.lowerToFloor:
        ceiling.bottomheight = sec.floorHeight;
        ceiling.direction = -1;
        ceiling.speed = CEILSPEED;
        break;
      case CeilingType.raiseToHighest:
        ceiling.topheight = findHighestCeilingSurrounding(sec, currentMap);
        ceiling.direction = 1;
        ceiling.speed = CEILSPEED;
        break;
    }

    addThinker(ceiling);
    sectorSpecialData.set(sec, ceiling);
    addActiveCeiling(ceiling);
  }

  return rtn;
}

/**
 * EV_CeilingCrushStop — stop a ceiling from crushing.
 * Reference: p_ceilng.c EV_CeilingCrushStop
 */
function evCeilingCrushStop(line: LineDef): boolean {
  let rtn = false;
  for (let i = 0; i < MAXCEILINGS; i++) {
    const c = activeCeilings[i];
    if (c && c.tag === line.tag && c.direction !== 0) {
      c.olddirection = c.direction;
      c.direction = 0; // in stasis
      rtn = true;
    }
  }
  return rtn;
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
];

// Map: texture index → its partner texture index
const switchMap: Map<number, number> = new Map();
let switchesInitialized = false;

import { TextureData } from '../textures';
let texDataRef: TextureData | null = null;

export function initSwitchList(texData: TextureData): void {
  texDataRef = texData;
  switchMap.clear();
  for (const [name1, name2] of SWITCH_PAIRS) {
    const idx1 = texData.textureNumForName(name1);
    const idx2 = texData.textureNumForName(name2);
    if (idx1 >= 0 && idx2 >= 0) {
      switchMap.set(idx1, idx2);
      switchMap.set(idx2, idx1);
    }
  }
  switchesInitialized = true;
}

function changeSwitchTexture(line: LineDef, useAgain: boolean): void {
  if (!useAgain) line.special = 0;

  const side = currentMap.sidedefs[line.sidenum[0]];
  if (!side) return;

  // Check top, mid, bottom textures
  for (const prop of ['topTexture', 'midTexture', 'bottomTexture'] as const) {
    const tex = side[prop];
    const partner = switchMap.get(tex);
    if (partner !== undefined) {
      // Switch sound: swtchn for turning on (SW1→SW2), swtchx for turning off (SW2→SW1)
      S_StartSound(null, useAgain ? Sfx.swtchn : Sfx.swtchx);
      (side as any)[prop] = partner;
      return;
    }
  }
}


// ===============================================
// P_UseSpecialLine — main dispatch
// Reference: p_switch.c P_UseSpecialLine
// ===============================================
export function useSpecialLine(line: LineDef, player: Player | null): boolean {
  switch (line.special) {
    // MANUALS (doors you press Use on)
    case 1:   // Vertical Door (raise)
    case 26:  // Blue locked door raise
    case 27:  // Yellow locked door raise
    case 28:  // Red locked door raise
    case 31:  // Manual door open (stay open)
    case 32:  // Blue locked door open
    case 33:  // Red locked door open
    case 34:  // Yellow locked door open
    case 117: // Blazing door raise
    case 118: // Blazing door open
      evVerticalDoor(line, player);
      return true;

    // SWITCHES (one-shot)
    case 11:
      // Exit level (switch)
      changeSwitchTexture(line, false);
      G_ExitLevel();
      return true;
    case 124:
      // Secret exit (switch)
      changeSwitchTexture(line, false);
      G_SecretExitLevel();
      return true;
    case 7:  // S1 Build Stairs 8
      if (evBuildStairs(line, false))
        changeSwitchTexture(line, false);
      return true;
    case 127: // S1 Build Stairs 16 (turbo)
      if (evBuildStairs(line, true))
        changeSwitchTexture(line, false);
      return true;
    case 49: // S1 Ceiling Crush And Raise
      if (evDoCeiling(line, CeilingType.crushAndRaise))
        changeSwitchTexture(line, false);
      return true;
    case 9:  // Change donut (not implemented)
      return false;
    case 21: // PlatDownWaitUpStay (switch)
      if (evDoPlat(line, PlatType.downWaitUpStay, 0))
        changeSwitchTexture(line, false);
      return true;
    case 23: // Lower floor to lowest
      if (evDoFloor(line, FloorType.lowerFloorToLowest))
        changeSwitchTexture(line, false);
      return true;
    case 29: // Raise door (switch)
      if (evDoDoor(line, DoorType.normal))
        changeSwitchTexture(line, false);
      return true;
    case 18: // Raise floor to next highest
      if (evDoFloor(line, FloorType.raiseFloorToNearest))
        changeSwitchTexture(line, false);
      return true;
    case 20: // Raise plat to nearest and change
      if (evDoPlat(line, PlatType.raiseToNearestAndChange, 0))
        changeSwitchTexture(line, false);
      return true;
    case 101: // Raise floor
      if (evDoFloor(line, FloorType.raiseFloor))
        changeSwitchTexture(line, false);
      return true;
    case 102: // Lower floor
      if (evDoFloor(line, FloorType.lowerFloor))
        changeSwitchTexture(line, false);
      return true;
    case 103: // Open door (switch)
      if (evDoDoor(line, DoorType.open))
        changeSwitchTexture(line, false);
      return true;
    case 50: // Close door (switch)
      if (evDoDoor(line, DoorType.close))
        changeSwitchTexture(line, false);
      return true;
    case 71: // Turbo lower floor
      if (evDoFloor(line, FloorType.turboLower))
        changeSwitchTexture(line, false);
      return true;

    // LOCKED DOOR SWITCHES (one-shot)
    case 133: // BlzOpenDoor BLUE
    case 135: // BlzOpenDoor RED
    case 137: // BlzOpenDoor YELLOW
      if (evDoLockedDoor(line, DoorType.blazeOpen, player))
        changeSwitchTexture(line, false);
      return true;

    // BUTTONS (repeatable switches)
    case 42: // Close door (button)
      if (evDoDoor(line, DoorType.close))
        changeSwitchTexture(line, true);
      return true;
    case 45: // Lower floor (button)
      if (evDoFloor(line, FloorType.lowerFloor))
        changeSwitchTexture(line, true);
      return true;
    case 60: // Lower floor to lowest (button)
      if (evDoFloor(line, FloorType.lowerFloorToLowest))
        changeSwitchTexture(line, true);
      return true;
    case 61: // Open door (button)
      if (evDoDoor(line, DoorType.open))
        changeSwitchTexture(line, true);
      return true;
    case 62: // PlatDownWaitUpStay (button)
      if (evDoPlat(line, PlatType.downWaitUpStay, 1))
        changeSwitchTexture(line, true);
      return true;
    case 63: // Raise door normal (button)
      if (evDoDoor(line, DoorType.normal))
        changeSwitchTexture(line, true);
      return true;
    case 64: // Raise floor (button)
      if (evDoFloor(line, FloorType.raiseFloor))
        changeSwitchTexture(line, true);
      return true;
    case 65: // Raise floor crush (button)
      if (evDoFloor(line, FloorType.raiseFloorCrush))
        changeSwitchTexture(line, true);
      return true;
    case 69: // Raise floor to nearest (button)
      if (evDoFloor(line, FloorType.raiseFloorToNearest))
        changeSwitchTexture(line, true);
      return true;
    case 70: // Turbo lower floor (button)
      if (evDoFloor(line, FloorType.turboLower))
        changeSwitchTexture(line, true);
      return true;

    // LOCKED DOOR BUTTONS (repeatable)
    case 99:  // BlzOpenDoor BLUE
    case 134: // BlzOpenDoor RED
    case 136: // BlzOpenDoor YELLOW
      if (evDoLockedDoor(line, DoorType.blazeOpen, player))
        changeSwitchTexture(line, true);
      return true;
  }

  return false;
}

/**
 * P_UseSpecialLine for monsters — only manual doors (special 1).
 * Reference: p_spec.c — monsters can only activate type 1 doors.
 */
export function monsterUseSpecialLine(line: LineDef): boolean {
  if (line.special === 1) {
    evVerticalDoor(line, null);
    return true;
  }
  return false;
}

// ===============================================
// TELEPORTERS — EV_Teleport
// Reference: p_telept.c
// ===============================================

/**
 * Teleportable actor — either a Player or MapObjState.
 * We duck-type: if it has `viewheight`, it's a Player.
 */
export interface TeleportActor {
  x: number;
  y: number;
  z: number;
  angle: number;
  momx: number;
  momy: number;
  momz: number;
  // Player-specific (optional)
  viewheight?: number;
  deltaviewheight?: number;
  viewz?: number;
  reactiontime?: number;
}

function isPlayerActor(actor: TeleportActor): boolean {
  return 'viewheight' in actor && 'deltaviewheight' in actor;
}

/**
 * EV_Teleport — teleport an actor to a destination thing.
 * Finds thing type 14 in sectors matching the line's tag.
 * Reference: p_telept.c EV_Teleport
 */
function evTeleport(line: LineDef, side: number, actor: TeleportActor): boolean {
  // Don't teleport if you're on the back side of the teleporter line
  // (prevents teleporting back immediately after arriving)
  if (side === 1) return false;
  if (!currentMap) return false;

  const tag = line.tag;
  if (tag === 0) return false;

  // Find sectors with this tag
  const sectors = findSectorsFromTag(tag, currentMap);
  if (sectors.length === 0) return false;

  // Find a teleport destination thing (type 14) in one of those sectors
  for (const thing of currentMap.things) {
    if (thing.type !== 14) continue; // T_TELEPORTMAN = 14

    // Check if this thing is inside one of the tagged sectors
    const thingX = thing.x << FRACBITS;
    const thingY = thing.y << FRACBITS;
    const ss = currentMap.pointInSubsector(thingX, thingY);
    if (!ss.sector) continue;
    if (!sectors.includes(ss.sector)) continue;

    // Found destination! Perform teleport.
    const oldX = actor.x;
    const oldY = actor.y;
    const oldZ = actor.z;

    // Destination angle (MapThing.angle is in degrees)
    const destAngle = ((thing.angle * 0xFFFFFFFF / 360) >>> 0);

    // Spawn fog at OLD position
    spawnTeleportFog(oldX, oldY, oldZ);
    S_StartSound({ x: oldX, y: oldY }, Sfx.telept);

    // Move actor to destination
    const destZ = ss.sector.floorHeight;
    actor.x = thingX;
    actor.y = thingY;
    actor.z = destZ;
    actor.angle = destAngle;

    // Zero momentum
    actor.momx = 0;
    actor.momy = 0;
    actor.momz = 0;

    // Player-specific: reset view for smooth transition
    if (isPlayerActor(actor)) {
      const VIEWHEIGHT = 41 << FRACBITS;
      actor.viewheight = VIEWHEIGHT;
      actor.deltaviewheight = 0;
      actor.viewz = destZ + VIEWHEIGHT;
      actor.reactiontime = 18; // freeze controls briefly (18 tics)
    }

    // Spawn fog at NEW position (offset slightly in front based on angle)
    // Original DOOM spawns fog 20 units in front of destination
    const fineAngle = (destAngle >>> 19) & 0x1FFF;
    const TELEPORTOFFSET = 20 << FRACBITS;
    // Use lookup for cos/sin
    const fogX = thingX + Math.round(TELEPORTOFFSET * Math.cos(fineAngle * Math.PI * 2 / 8192));
    const fogY = thingY + Math.round(TELEPORTOFFSET * Math.sin(fineAngle * Math.PI * 2 / 8192));
    spawnTeleportFog(fogX, fogY, destZ);
    S_StartSound({ x: fogX, y: fogY }, Sfx.telept);

    return true;
  }

  return false;
}

/**
 * P_CrossSpecialLine — triggered when player/monster crosses a line 
 * Reference: p_spec.c P_CrossSpecialLine
 */
export function crossSpecialLine(line: LineDef, side: number = 0, actor?: TeleportActor): void {
  // Monster filter: in original DOOM (p_spec.c), monsters can only trigger
  // walk-over doors, lifts/platforms, and teleports — NOT exits, floors, ceilings, etc.
  if (actor && !isPlayerActor(actor)) {
    switch (line.special) {
      // Doors: W1 / WR
      case 2: case 3: case 4: case 16: case 108: case 109: case 110:  // W1 doors
      case 75: case 76: case 86: case 90:                              // WR doors
      // Lifts/platforms: W1 / WR
      case 10: case 22:                                                // W1 lifts
      case 87: case 88: case 95:                                       // WR lifts
      // Teleporters
      case 39: case 97: case 125: case 126:
        break; // allowed — continue to the switch below
      default:
        return; // all other specials are player-only
    }
  }

  switch (line.special) {
    case 2: // Open door (walk trigger)
      evDoDoor(line, DoorType.open);
      line.special = 0;
      break;
    case 3: // Close door (walk trigger)
      evDoDoor(line, DoorType.close);
      line.special = 0;
      break;
    case 4: // Raise door normal (walk trigger)
      evDoDoor(line, DoorType.normal);
      line.special = 0;
      break;
    case 5: // Raise floor (walk trigger)
      evDoFloor(line, FloorType.raiseFloor);
      line.special = 0;
      break;
    case 10: // PlatDownWaitUpStay (walk trigger)
      evDoPlat(line, PlatType.downWaitUpStay, 0);
      line.special = 0;
      break;
    case 16: // Close door 30 then open
      evDoDoor(line, DoorType.close30ThenOpen);
      line.special = 0;
      break;
    case 19: // Lower floor (walk trigger)
      evDoFloor(line, FloorType.lowerFloor);
      line.special = 0;
      break;
    case 22: // Raise to nearest and change
      evDoPlat(line, PlatType.raiseToNearestAndChange, 0);
      line.special = 0;
      break;
    case 36: // Lower floor turbo (walk trigger)
      evDoFloor(line, FloorType.turboLower);
      line.special = 0;
      break;
    case 37: // Lower and change
      evDoFloor(line, FloorType.lowerAndChange);
      line.special = 0;
      break;
    case 38: // Lower floor to lowest
      evDoFloor(line, FloorType.lowerFloorToLowest);
      line.special = 0;
      break;
    case 6: // W1 Ceiling Crush And Raise (with stop)
      evDoCeiling(line, CeilingType.crushAndRaise);
      line.special = 0;
      break;
    case 25: // W1 Crush And Raise
      evDoCeiling(line, CeilingType.crushAndRaise);
      line.special = 0;
      break;
    case 44: // W1 Lower And Crush
      evDoCeiling(line, CeilingType.lowerAndCrush);
      line.special = 0;
      break;
    case 40: // W1 Raise Ceiling To Highest
      evDoCeiling(line, CeilingType.raiseToHighest);
      line.special = 0;
      break;
    case 41: // W1 Lower Ceiling To Floor
      evDoCeiling(line, CeilingType.lowerToFloor);
      line.special = 0;
      break;
    case 57: // W1 Ceiling Crush Stop
      evCeilingCrushStop(line);
      line.special = 0;
      break;
    case 141: // W1 Silent Crush And Raise
      evDoCeiling(line, CeilingType.silentCrushAndRaise);
      line.special = 0;
      break;
    case 52: // EXIT (walk trigger)
      G_ExitLevel();
      line.special = 0;
      break;
    case 51: // SECRET EXIT (walk trigger)
      G_SecretExitLevel();
      line.special = 0;
      break;
    case 108: // Blazing door raise (walk trigger)
      evDoDoor(line, DoorType.blazeRaise);
      line.special = 0;
      break;
    case 109: // Blazing door open (walk trigger)
      evDoDoor(line, DoorType.blazeOpen);
      line.special = 0;
      break;
    case 110: // Blazing door close (walk trigger)
      evDoDoor(line, DoorType.blazeClose);
      line.special = 0;
      break;

    // RETRIGGERS (don't clear special)
    case 72: // WR Lower Ceiling And Crush
      evDoCeiling(line, CeilingType.lowerAndCrush);
      break;
    case 73: // WR Crush And Raise
      evDoCeiling(line, CeilingType.crushAndRaise);
      break;
    case 74: // WR Ceiling Crush Stop
      evCeilingCrushStop(line);
      break;
    case 77: // WR Fast Crush And Raise
      evDoCeiling(line, CeilingType.fastCrushAndRaise);
      break;
    case 75: // Close door (retrigger)
      evDoDoor(line, DoorType.close);
      break;
    case 76: // Close door 30 (retrigger)
      evDoDoor(line, DoorType.close30ThenOpen);
      break;
    case 86: // Open door (retrigger)
      evDoDoor(line, DoorType.open);
      break;
    case 87: // Perpetual platform raise
      evDoPlat(line, PlatType.perpetualRaise, 0);
      break;
    case 88: // PlatDownWaitUpStay (retrigger)
      evDoPlat(line, PlatType.downWaitUpStay, 0);
      break;
    case 90: // Raise door normal (retrigger)
      evDoDoor(line, DoorType.normal);
      break;
    case 91: // Raise floor (retrigger)
      evDoFloor(line, FloorType.raiseFloor);
      break;
    case 92: // Raise floor 24 (retrigger)
      evDoFloor(line, FloorType.raiseFloor24);
      break;
    case 93: // Raise floor 24 and change (retrigger)
      evDoFloor(line, FloorType.raiseFloor24AndChange);
      break;
    case 94: // Raise floor crush (retrigger)
      evDoFloor(line, FloorType.raiseFloorCrush);
      break;
    case 95: // Raise nearest and change (retrigger)
      evDoPlat(line, PlatType.raiseToNearestAndChange, 0);
      break;
    case 96: // Raise floor to nearest (retrigger)
      // Short texture raise — simplify to raise floor
      evDoFloor(line, FloorType.raiseFloor24);
      break;
    case 98: // Lower floor turbo (retrigger)
      evDoFloor(line, FloorType.turboLower);
      break;

    // STAIR BUILDING
    case 8: // W1 Build Stairs 8
      evBuildStairs(line, false);
      line.special = 0;
      break;
    case 100: // W1 Build Stairs 16 (turbo)
      evBuildStairs(line, true);
      line.special = 0;
      break;

    // TELEPORTERS
    case 39: // W1 Teleport
      if (actor) {
        if (evTeleport(line, side, actor)) {
          line.special = 0;
        }
      }
      break;
    case 97: // WR Teleport (retrigger)
      if (actor) {
        evTeleport(line, side, actor);
      }
      break;
    case 125: // W1 Teleport — monsters only
      if (actor && !isPlayerActor(actor)) {
        if (evTeleport(line, side, actor)) {
          line.special = 0;
        }
      }
      break;
    case 126: // WR Teleport — monsters only (retrigger)
      if (actor && !isPlayerActor(actor)) {
        evTeleport(line, side, actor);
      }
      break;
  }
}

// ===========================================================
// Save/Load helpers
// ===========================================================

/** Get the sectorSpecialData map (for save) */
export function getSectorSpecialData(): Map<Sector, Thinker> {
  return sectorSpecialData;
}

/** Get activePlats array (for save) */
export function getActivePlats(): (PlatThinker | null)[] {
  return activePlats;
}

/** Clear sectorSpecialData and activePlats (for load — before restoring) */
export function clearSpecialsState(): void {
  sectorSpecialData.clear();
  activePlats.fill(null);
}

/** Link a thinker to a sector (for load restore) */
export function linkSectorSpecial(sector: Sector, thinker: Thinker): void {
  sectorSpecialData.set(sector, thinker);
}

/** Add a platform to activePlats (for load restore) */
export function addActivePlat(plat: PlatThinker): void {
  for (let i = 0; i < activePlats.length; i++) {
    if (activePlats[i] === null) {
      activePlats[i] = plat;
      return;
    }
  }
}

/**
 * Create and register a DoorThinker from saved data (for load).
 * Returns the thinker so the caller can link it.
 */
export function restoreDoorThinker(
  sector: Sector, type: DoorType, topheight: number, speed: number,
  direction: number, topwait: number, topcountdown: number
): DoorThinker {
  const door: DoorThinker = {
    action: doorTick, removed: false,
    type, sector, topheight, speed, direction, topwait, topcountdown,
  };
  addThinker(door);
  sectorSpecialData.set(sector, door);
  return door;
}

/**
 * Create and register a PlatThinker from saved data (for load).
 */
export function restorePlatThinker(
  sector: Sector, type: PlatType, speed: number, low: number, high: number,
  wait: number, count: number, status: PlatStatus, oldstatus: PlatStatus,
  crush: boolean, tag: number
): PlatThinker {
  const plat: PlatThinker = {
    action: platTick, removed: false,
    type, sector, speed, low, high, wait, count, status, oldstatus, crush, tag,
  };
  addThinker(plat);
  sectorSpecialData.set(sector, plat);
  addActivePlat(plat);
  return plat;
}

/**
 * Create and register a FloorThinker from saved data (for load).
 */
export function restoreFloorThinker(
  sector: Sector, type: FloorType, speed: number, floordestheight: number,
  crush: boolean, direction: number
): FloorThinker {
  const floor: FloorThinker = {
    action: floorTick, removed: false,
    type, sector, speed, floordestheight, crush, direction,
  };
  addThinker(floor);
  sectorSpecialData.set(sector, floor);
  return floor;
}
