// ============================================================
// Doors -- T_VerticalDoor
// Reference: p_doors.c
// ============================================================

import type { LineDef, Sector } from './map-types';
import { FRACUNIT } from './math';
import { Thinker, addThinker, removeThinker } from './thinkers';
import { FX_Sound } from './effects';
import { Sfx } from './sounds';
import type { Player } from './player';
import {
  VDOORSPEED, VDOORWAIT, MoveResult,
  getCurrentMap, sectorSoundOrg, movePlane,
  findLowestCeilingSurrounding, findSectorsFromTag,
  hasSectorSpecial, setSectorSpecial, getSectorSpecial, deleteSectorSpecial,
} from './sector-utils';

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

export interface DoorThinker extends Thinker {
  type: DoorType;
  sector: Sector;
  topheight: number;  // ceiling height to rise to
  speed: number;
  direction: number;  // 1=up, 0=wait, -1=down
  topwait: number;    // tics to wait at top
  topcountdown: number;
}

export function doorTick(t: Thinker): void {
  const door = t as DoorThinker;

  switch (door.direction) {
    case 0: // WAITING
      if (--door.topcountdown <= 0) {
        switch (door.type) {
          case DoorType.blazeRaise:
          case DoorType.normal:
            door.direction = -1; // time to go back down
            FX_Sound(sectorSoundOrg(door.sector), Sfx.dorcls);
            break;
          case DoorType.close30ThenOpen:
            door.direction = 1;
            FX_Sound(sectorSoundOrg(door.sector), Sfx.doropn);
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
            FX_Sound(sectorSoundOrg(door.sector), Sfx.dorcls);
            deleteSectorSpecial(door.sector);
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
            FX_Sound(sectorSoundOrg(door.sector), Sfx.doropn);
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
            deleteSectorSpecial(door.sector);
            removeThinker(door);
            break;
        }
      }
      break;
    }
  }
}

/**
 * EV_DoDoor -- open doors by tag
 * Reference: p_doors.c
 */
export function evDoDoor(line: LineDef, type: DoorType): boolean {
  let rtn = false;
  const map = getCurrentMap();
  const sectors = findSectorsFromTag(line.tag, map);

  for (const sec of sectors) {
    if (hasSectorSpecial(sec)) continue;

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
        door.topheight = findLowestCeilingSurrounding(sec, map) - 4 * FRACUNIT;
        door.direction = -1;
        door.speed = VDOORSPEED * 4;
        break;
      case DoorType.close:
        door.topheight = findLowestCeilingSurrounding(sec, map) - 4 * FRACUNIT;
        door.direction = -1;
        break;
      case DoorType.close30ThenOpen:
        door.topheight = sec.ceilingHeight;
        door.direction = -1;
        break;
      case DoorType.blazeRaise:
      case DoorType.blazeOpen:
        door.direction = 1;
        door.topheight = findLowestCeilingSurrounding(sec, map) - 4 * FRACUNIT;
        door.speed = VDOORSPEED * 4;
        break;
      case DoorType.normal:
      case DoorType.open:
        door.direction = 1;
        door.topheight = findLowestCeilingSurrounding(sec, map) - 4 * FRACUNIT;
        break;
    }

    FX_Sound(sectorSoundOrg(sec), door.direction === 1 ? Sfx.doropn : Sfx.dorcls);
    addThinker(door);
    setSectorSpecial(sec, door);
  }
  return rtn;
}


/**
 * EV_VerticalDoor -- manual door (no tag, uses back sector)
 * Reference: p_doors.c
 */
export function evVerticalDoor(line: LineDef, player: Player | null): void {
  // Check for locks (DOOM: p_doors.c EV_VerticalDoor)
  if (player) {
    switch (line.special) {
      case 26: // Blue Lock
      case 32:
        if (!player.keys[0] && !player.keys[3]) {
          player.message = 'You need a blue key to open this door';
          FX_Sound(null, Sfx.oof);
          return;
        }
        break;
      case 27: // Yellow Lock
      case 34:
        if (!player.keys[1] && !player.keys[4]) {
          player.message = 'You need a yellow key to open this door';
          FX_Sound(null, Sfx.oof);
          return;
        }
        break;
      case 28: // Red Lock
      case 33:
        if (!player.keys[2] && !player.keys[5]) {
          player.message = 'You need a red key to open this door';
          FX_Sound(null, Sfx.oof);
          return;
        }
        break;
    }
  }

  const map = getCurrentMap();

  // Get the back sector (door sector)
  const sideIdx = line.sidenum[1];
  if (sideIdx === -1 || sideIdx === 0xFFFF) return;

  const sec = map.sidedefs[sideIdx]?.sector;
  if (!sec) return;

  // If the sector already has a thinker, toggle direction
  if (hasSectorSpecial(sec)) {
    const existing = getSectorSpecial(sec) as DoorThinker;
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

  door.topheight = findLowestCeilingSurrounding(sec, map) - 4 * FRACUNIT;

  FX_Sound(sectorSoundOrg(sec), Sfx.doropn);
  addThinker(door);
  setSectorSpecial(sec, door);
}

/**
 * EV_DoLockedDoor -- open locked doors by tag (switch/button-triggered)
 * Reference: p_doors.c EV_DoLockedDoor
 * Checks key, sets message if locked, then delegates to evDoDoor.
 */
export function evDoLockedDoor(line: LineDef, type: DoorType, player: Player | null): boolean {
  if (!player) return false;

  switch (line.special) {
    case 99:  // Blue Lock
    case 133:
      if (!player.keys[0] && !player.keys[3]) {
        player.message = 'You need a blue key to activate this object';
        FX_Sound(null, Sfx.oof);
        return false;
      }
      break;
    case 134: // Red Lock
    case 135:
      if (!player.keys[2] && !player.keys[5]) {
        player.message = 'You need a red key to activate this object';
        FX_Sound(null, Sfx.oof);
        return false;
      }
      break;
    case 136: // Yellow Lock
    case 137:
      if (!player.keys[1] && !player.keys[4]) {
        player.message = 'You need a yellow key to activate this object';
        FX_Sound(null, Sfx.oof);
        return false;
      }
      break;
  }

  return evDoDoor(line, type);
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
  setSectorSpecial(sector, door);
  return door;
}
