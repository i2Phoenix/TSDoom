// ============================================================
// Crushing Ceilings -- T_MoveCeiling
// Reference: p_ceilng.c
// ============================================================

import type { LineDef, Sector } from './map-types';
import { FRACBITS } from './math';
import { GameInstance } from './game-instance';
import { Thinker, addThinker, removeThinker } from './thinkers';
import { FX_Sound } from './effects';
import { Sfx } from './sounds';
import {
  CEILSPEED, MAXCEILINGS, MoveResult,
  sectorSoundOrg, movePlane,
  findHighestCeilingSurrounding, findSectorsFromTag,
  hasSectorSpecial, setSectorSpecial, deleteSectorSpecial,
  playerInSector, crushMonstersInSector,
  getActiveCeilings,
} from './sector-utils';

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

/** Track tick count for sound timing (ceiling movement sounds every 8 tics) */
let ceilingTick_counter = 0;
export function tickCeilingCounter(): void { ceilingTick_counter++; }

export function ceilingTick(t: Thinker, gi: GameInstance): void {
  const ceiling = t as CeilingThinker;

  switch (ceiling.direction) {
    case 0: // IN STASIS
      break;

    case 1: { // UP
      const res = movePlane(ceiling.sector, ceiling.speed,
        ceiling.topheight, false, 1, ceiling.direction, gi);

      // Play movement sound every 8 tics (not for silent type)
      if (!(ceilingTick_counter & 7)) {
        if (ceiling.type !== CeilingType.silentCrushAndRaise) {
          FX_Sound(sectorSoundOrg(ceiling.sector, gi), Sfx.stnmov);
        }
      }

      if (res === MoveResult.pastdest) {
        if (ceiling.type === CeilingType.raiseToHighest) {
          removeActiveCeiling(ceiling, gi);
        } else if (ceiling.type === CeilingType.silentCrushAndRaise) {
          FX_Sound(sectorSoundOrg(ceiling.sector, gi), Sfx.pstop);
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
        ceiling.bottomheight, ceiling.crush, 1, ceiling.direction, gi);

      // Play movement sound every 8 tics (not for silent type)
      if (!(ceilingTick_counter & 7)) {
        if (ceiling.type !== CeilingType.silentCrushAndRaise) {
          FX_Sound(sectorSoundOrg(ceiling.sector, gi), Sfx.stnmov);
        }
      }

      if (res === MoveResult.pastdest) {
        if (ceiling.type === CeilingType.silentCrushAndRaise) {
          FX_Sound(sectorSoundOrg(ceiling.sector, gi), Sfx.pstop);
          ceiling.speed = CEILSPEED;
          ceiling.direction = 1;
        } else if (ceiling.type === CeilingType.crushAndRaise) {
          ceiling.speed = CEILSPEED;
          ceiling.direction = 1;
        } else if (ceiling.type === CeilingType.fastCrushAndRaise) {
          ceiling.direction = 1;
        } else if (ceiling.type === CeilingType.lowerAndCrush ||
          ceiling.type === CeilingType.lowerToFloor) {
          removeActiveCeiling(ceiling, gi);
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

        // Apply crush damage (10 hp per tick, from p_map.c PIT_ChangeSector)
        const playerRef = gi.world?.player;
        if (playerRef && playerInSector(ceiling.sector, gi)) {
          playerRef.takeDamage(10);
        }
        // Also damage monsters in the sector
        crushMonstersInSector(ceiling.sector, gi);
      }
      break;
    }
  }
}

export function addActiveCeiling(ceiling: CeilingThinker, gi: GameInstance): void {
  const activeCeilings = getActiveCeilings(gi);
  for (let i = 0; i < MAXCEILINGS; i++) {
    if (activeCeilings[i] === null) {
      activeCeilings[i] = ceiling;
      return;
    }
  }
}

export function removeActiveCeiling(ceiling: CeilingThinker, gi: GameInstance): void {
  const activeCeilings = getActiveCeilings(gi);
  for (let i = 0; i < MAXCEILINGS; i++) {
    if (activeCeilings[i] === ceiling) {
      deleteSectorSpecial(ceiling.sector, gi);
      removeThinker(ceiling);
      activeCeilings[i] = null;
      return;
    }
  }
}

/** Reactivate ceilings that were put in stasis (for same tag) */
function activateInStasisCeiling(line: LineDef, gi: GameInstance): void {
  const activeCeilings = getActiveCeilings(gi);
  for (let i = 0; i < MAXCEILINGS; i++) {
    const c = activeCeilings[i] as CeilingThinker | null;
    if (c && c.tag === line.tag && c.direction === 0) {
      c.direction = c.olddirection;
      // Re-enable the thinker action
      c.action = ceilingTick;
    }
  }
}

/**
 * EV_DoCeiling -- move a ceiling up/down.
 * Reference: p_ceilng.c EV_DoCeiling
 */
export function evDoCeiling(line: LineDef, type: CeilingType, gi: GameInstance): boolean {
  // Reactivate in-stasis ceilings for crush types
  switch (type) {
    case CeilingType.fastCrushAndRaise:
    case CeilingType.silentCrushAndRaise:
    case CeilingType.crushAndRaise:
      activateInStasisCeiling(line, gi);
      break;
    default:
      break;
  }

  let rtn = false;
  const map = gi.currentMap!;
  const sectors = findSectorsFromTag(line.tag, map);

  for (const sec of sectors) {
    if (hasSectorSpecial(sec, gi)) continue;

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
        ceiling.topheight = findHighestCeilingSurrounding(sec, map, gi);
        ceiling.direction = 1;
        ceiling.speed = CEILSPEED;
        break;
    }

    addThinker(ceiling, gi);
    setSectorSpecial(sec, ceiling, gi);
    addActiveCeiling(ceiling, gi);
  }

  return rtn;
}

/**
 * EV_CeilingCrushStop -- stop a ceiling from crushing.
 * Reference: p_ceilng.c EV_CeilingCrushStop
 */
export function evCeilingCrushStop(line: LineDef, gi: GameInstance): boolean {
  let rtn = false;
  const activeCeilings = getActiveCeilings(gi);
  for (let i = 0; i < MAXCEILINGS; i++) {
    const c = activeCeilings[i] as CeilingThinker | null;
    if (c && c.tag === line.tag && c.direction !== 0) {
      c.olddirection = c.direction;
      c.direction = 0; // in stasis
      rtn = true;
    }
  }
  return rtn;
}
