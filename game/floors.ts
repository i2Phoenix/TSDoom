// ============================================================
// Floor Movers, Stairs, Donut -- T_MoveFloor
// Reference: p_floor.c
// ============================================================

import { ML_TWOSIDED, type LineDef, type Sector } from './map-types';
import { FRACBITS, FRACUNIT } from './math';
import { Thinker, addThinker, removeThinker } from './thinkers';
import {
  FLOORSPEED, STAIRSPEED, TURBOSTAIRSPEED, DONUT_SPEED, MoveResult,
  getCurrentMap, movePlane, getNextSector,
  findLowestCeilingSurrounding, findLowestFloorSurrounding,
  findHighestFloorSurrounding, findNextHighestFloor, findSectorsFromTag,
  hasSectorSpecial, setSectorSpecial, deleteSectorSpecial,
  getSectorLines, getTextureHeight,
} from './sector-utils';

// ---- Floor types ----
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

export function floorTick(t: Thinker): void {
  const floor = t as FloorThinker;
  const res = movePlane(floor.sector, floor.speed,
    floor.floordestheight, floor.crush, 0, floor.direction);

  if (res === MoveResult.pastdest) {
    deleteSectorSpecial(floor.sector);
    removeThinker(floor);
  }
}

/**
 * P_FindShortestTextureAround -- finds the shortest wall texture height
 * on two-sided linedefs touching a sector.
 * Reference: p_floor.c P_FindShortestTextureAround
 */
function findShortestTextureAround(sec: Sector): number {
  const currentMap = getCurrentMap();
  if (!currentMap) return FRACUNIT; // fallback: 1 unit

  let minSize = 0x7FFFFFFF;
  const _textureHeight = getTextureHeight();

  for (const line of currentMap.linedefs) {
    // Only check two-sided lines that touch this sector
    if (!(line.frontsector === sec || line.backsector === sec)) continue;
    if (!line.backsector || !line.frontsector) continue; // one-sided -- skip

    // Check both sides
    for (const sideIdx of line.sidenum) {
      if (sideIdx < 0) continue;
      const side = currentMap.sidedefs[sideIdx];
      if (!side) continue;

      // Check top, bottom, mid textures -- skip index 0 ("no texture")
      for (const texIdx of [side.topTexture, side.bottomTexture, side.midTexture]) {
        if (texIdx > 0) {
          const h = _textureHeight(texIdx);
          if (h > 0 && h < minSize) {
            minSize = h;
          }
        }
      }
    }
  }

  // Convert to fixed-point, or return FRACUNIT if nothing found
  return minSize !== 0x7FFFFFFF ? minSize * FRACUNIT : FRACUNIT;
}

export function evDoFloor(line: LineDef, floortype: FloorType): boolean {
  let rtn = false;
  const map = getCurrentMap();
  const sectors = findSectorsFromTag(line.tag, map);

  for (const sec of sectors) {
    if (hasSectorSpecial(sec)) continue;

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
        floor.floordestheight = findHighestFloorSurrounding(sec, map);
        break;
      case FloorType.lowerFloorToLowest:
        floor.direction = -1;
        floor.floordestheight = findLowestFloorSurrounding(sec, map);
        break;
      case FloorType.turboLower:
        floor.direction = -1;
        floor.speed = FLOORSPEED * 4;
        floor.floordestheight = findHighestFloorSurrounding(sec, map);
        if (floor.floordestheight !== sec.floorHeight) {
          floor.floordestheight += 8 * FRACUNIT;
        }
        break;
      case FloorType.raiseFloorCrush:
        floor.crush = true;
        floor.direction = 1;
        floor.floordestheight = findLowestCeilingSurrounding(sec, map);
        if (floor.floordestheight > sec.ceilingHeight) {
          floor.floordestheight = sec.ceilingHeight;
        }
        floor.floordestheight -= 8 * FRACUNIT;
        break;
      case FloorType.raiseFloor:
        floor.direction = 1;
        floor.floordestheight = findLowestCeilingSurrounding(sec, map);
        if (floor.floordestheight > sec.ceilingHeight) {
          floor.floordestheight = sec.ceilingHeight;
        }
        break;
      case FloorType.raiseFloorTurbo:
        floor.direction = 1;
        floor.speed = FLOORSPEED * 4;
        floor.floordestheight = findNextHighestFloor(sec, sec.floorHeight, map);
        break;
      case FloorType.raiseFloorToNearest:
        floor.direction = 1;
        floor.floordestheight = findNextHighestFloor(sec, sec.floorHeight, map);
        break;
      case FloorType.raiseFloor24:
        floor.direction = 1;
        floor.floordestheight = sec.floorHeight + 24 * FRACUNIT;
        break;
      case FloorType.raiseFloor24AndChange:
        floor.direction = 1;
        floor.floordestheight = sec.floorHeight + 24 * FRACUNIT;
        break;
      case FloorType.raiseToTexture:
        floor.direction = 1;
        floor.floordestheight = sec.floorHeight + findShortestTextureAround(sec);
        break;
      case FloorType.raiseFloor512:
        floor.direction = 1;
        floor.floordestheight = sec.floorHeight + 512 * FRACUNIT;
        break;
    }

    addThinker(floor);
    setSectorSpecial(sec, floor);
  }
  return rtn;
}

// ===============================================
// STAIR BUILDING -- EV_BuildStairs
// Reference: p_floor.c EV_BuildStairs
// ===============================================

/**
 * EV_BuildStairs -- build stairs from tagged sectors.
 * Finds sectors by tag, then cascades through neighbors with matching
 * floor texture, raising each sector by stepSize more than the previous.
 * Reference: p_floor.c EV_BuildStairs
 */
export function evBuildStairs(line: LineDef, turbo: boolean): boolean {
  const stepSize = turbo ? (16 << FRACBITS) : (8 << FRACBITS);
  const speed = turbo ? TURBOSTAIRSPEED : STAIRSPEED;

  let rtn = false;
  const map = getCurrentMap();
  const sectors = findSectorsFromTag(line.tag, map);
  const sectorLinesMap = getSectorLines();

  for (const sec of sectors) {
    if (hasSectorSpecial(sec)) continue;

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
    setSectorSpecial(sec, firstFloor);

    // Cascade through neighboring sectors with same floor texture
    let prevSec = sec;
    let ok = true;
    while (ok) {
      ok = false;
      const lines = sectorLinesMap.get(prevSec);
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

        // Already has a thinker -- skip
        if (hasSectorSpecial(nextSec)) continue;

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
        setSectorSpecial(nextSec, nextFloor);

        prevSec = nextSec;
        ok = true;
        break; // restart search from the new sector
      }
    }
  }

  return rtn;
}

// ===============================================
// EV_DoDonut -- Donut sector effect (linedef special 9)
// Reference: p_spec.c EV_DoDonut
//
// The donut geometry is three concentric regions:
//   outer -> ring -> hole
// The hole is the tagged sector. Effect:
//   1) Raise hole floor to ring's floor height + copy ring's floor texture
//   2) Lower ring floor to outer sector's floor height
// ===============================================
export function evDoDonut(line: LineDef): boolean {
  let rtn = false;
  const map = getCurrentMap();
  const sectors = findSectorsFromTag(line.tag, map);
  const sectorLinesMap = getSectorLines();

  for (const hole of sectors) {
    if (hasSectorSpecial(hole)) continue;

    // Find the ring sector: first two-sided line's other sector
    const holeLines = sectorLinesMap.get(hole);
    if (!holeLines) continue;

    let ring: Sector | null = null;
    for (const hl of holeLines) {
      ring = getNextSector(hl, hole, map);
      if (ring) break;
    }
    if (!ring) continue;
    if (hasSectorSpecial(ring)) continue;

    // Find the outer sector: first two-sided line of the ring that leads
    // to a sector OTHER than the hole
    const ringLines = sectorLinesMap.get(ring);
    if (!ringLines) continue;

    let outer: Sector | null = null;
    for (const rl of ringLines) {
      const s = getNextSector(rl, ring, map);
      if (s && s !== hole) { outer = s; break; }
    }
    if (!outer) continue;

    rtn = true;

    // 1) Raise hole floor to ring's floor height, change texture
    const raiseFloor: FloorThinker = {
      action: floorTick,
      removed: false,
      type: FloorType.raiseFloor,
      sector: hole,
      speed: DONUT_SPEED,
      floordestheight: ring.floorHeight,
      crush: false,
      direction: 1,
    };
    addThinker(raiseFloor);
    setSectorSpecial(hole, raiseFloor);
    // Copy ring floor texture to hole
    hole.floorPic = ring.floorPic;

    // 2) Lower ring floor to outer sector's floor height
    const lowerFloor: FloorThinker = {
      action: floorTick,
      removed: false,
      type: FloorType.lowerFloor,
      sector: ring,
      speed: DONUT_SPEED,
      floordestheight: outer.floorHeight,
      crush: false,
      direction: -1,
    };
    addThinker(lowerFloor);
    setSectorSpecial(ring, lowerFloor);
  }

  return rtn;
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
  setSectorSpecial(sector, floor);
  return floor;
}
