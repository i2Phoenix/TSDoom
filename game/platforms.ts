// ============================================================
// Platforms -- T_PlatRaise
// Reference: p_plats.c
// ============================================================

import type { LineDef, Sector } from './map-types';
import { FRACUNIT } from './math';
import { Thinker, addThinker, removeThinker } from './thinkers';
import { FX_Sound } from './effects';
import { Sfx } from './sounds';
import {
  PLATSPEED, PLATWAIT, MoveResult,
  getCurrentMap, sectorSoundOrg, movePlane,
  findLowestFloorSurrounding, findHighestFloorSurrounding, findNextHighestFloor,
  findSectorsFromTag,
  hasSectorSpecial, setSectorSpecial, deleteSectorSpecial,
  getActivePlats, addActivePlat,
} from './sector-utils';

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

export function platTick(t: Thinker): void {
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
        FX_Sound(sectorSoundOrg(plat.sector), Sfx.pstop);
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
        FX_Sound(sectorSoundOrg(plat.sector), Sfx.pstop);
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
        FX_Sound(sectorSoundOrg(plat.sector), Sfx.pstart);
      }
      break;

    case PlatStatus.in_stasis:
      break;
  }
}

function removeActivePlat(plat: PlatThinker): void {
  const activePlats = getActivePlats();
  for (let i = 0; i < activePlats.length; i++) {
    if (activePlats[i] === plat) {
      deleteSectorSpecial(plat.sector);
      removeThinker(plat);
      activePlats[i] = null;
      return;
    }
  }
}

/**
 * EV_StopPlat -- stop platforms with matching tag.
 * Reference: p_plats.c EV_StopPlat
 */
export function evStopPlat(line: LineDef): void {
  const activePlats = getActivePlats();
  for (let i = 0; i < activePlats.length; i++) {
    const plat = activePlats[i] as PlatThinker | null;
    if (plat && plat.tag === line.tag && plat.status !== PlatStatus.in_stasis) {
      plat.oldstatus = plat.status;
      plat.status = PlatStatus.in_stasis;
    }
  }
}

/**
 * EV_DoPlat -- activate platforms by tag
 * Reference: p_plats.c
 */
export function evDoPlat(line: LineDef, type: PlatType, amount: number): boolean {
  let rtn = false;
  const map = getCurrentMap();
  const sectors = findSectorsFromTag(line.tag, map);

  for (const sec of sectors) {
    if (hasSectorSpecial(sec)) continue;

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
        plat.high = findNextHighestFloor(sec, sec.floorHeight, map);
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
        plat.low = findLowestFloorSurrounding(sec, map);
        if (plat.low > sec.floorHeight) plat.low = sec.floorHeight;
        plat.high = sec.floorHeight;
        plat.wait = 35 * PLATWAIT;
        plat.status = PlatStatus.down;
        break;
      case PlatType.blazeDWUS:
        plat.speed = PLATSPEED * 8;
        plat.low = findLowestFloorSurrounding(sec, map);
        if (plat.low > sec.floorHeight) plat.low = sec.floorHeight;
        plat.high = sec.floorHeight;
        plat.wait = 35 * PLATWAIT;
        plat.status = PlatStatus.down;
        break;
      case PlatType.perpetualRaise:
        plat.speed = PLATSPEED;
        plat.low = findLowestFloorSurrounding(sec, map);
        if (plat.low > sec.floorHeight) plat.low = sec.floorHeight;
        plat.high = findHighestFloorSurrounding(sec, map);
        if (plat.high < sec.floorHeight) plat.high = sec.floorHeight;
        plat.wait = 35 * PLATWAIT;
        plat.status = Math.random() > 0.5 ? PlatStatus.up : PlatStatus.down;
        break;
    }

    FX_Sound(sectorSoundOrg(sec), Sfx.pstart);
    addThinker(plat);
    setSectorSpecial(sec, plat);
    addActivePlat(plat);
  }
  return rtn;
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
  setSectorSpecial(sector, plat);
  addActivePlat(plat);
  return plat;
}
