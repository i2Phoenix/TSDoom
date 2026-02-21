// ============================================================
// P_CheckSight — Line of Sight / Visibility checks
// Port of p_sight.c — uses REJECT lookup table + BSP traversal
// ============================================================

import { FRACBITS } from './math';
import { NF_SUBSECTOR, ML_TWOSIDED, incValidcount, type GameMap } from './map-types';
import { MapObjState } from './mobj';
import { GameInstance } from './game-instance';
import type { SightContext } from './game-instance';

// Module-level reference to the sight context (refreshed per P_CheckSight call)
let sc: SightContext;

/**
 * P_DivlineSide — determine which side of a divline a point is on.
 * Returns 0 (front), 1 (back), or 2 (on the line).
 */
function P_DivlineSide(
  x: number, y: number,
  nodeX: number, nodeY: number, nodeDx: number, nodeDy: number,
): number {
  if (!nodeDx) {
    if (x === nodeX) return 2;
    if (x <= nodeX) return nodeDy > 0 ? 1 : 0;
    return nodeDy < 0 ? 1 : 0;
  }

  if (!nodeDy) {
    if (y === nodeY) return 2;
    if (y <= nodeY) return nodeDx < 0 ? 1 : 0;
    return nodeDx > 0 ? 1 : 0;
  }

  const dx = x - nodeX;
  const dy = y - nodeY;

  // Use shifted multiply to avoid overflow (matches original fixed-point math)
  const left = ((nodeDy >> FRACBITS) * (dx >> FRACBITS)) | 0;
  const right = ((dy >> FRACBITS) * (nodeDx >> FRACBITS)) | 0;

  if (right < left) return 0;  // front side
  if (left === right) return 2;
  return 1; // back side
}

/**
 * P_InterceptVector2 — fractional intercept point along the first divline.
 */
function P_InterceptVector2(
  v2x: number, v2y: number, v2dx: number, v2dy: number,
  v1x: number, v1y: number, v1dx: number, v1dy: number,
): number {
  const den = (((v1dy >> 8) * v2dx) >> FRACBITS) -
    (((v1dx >> 8) * v2dy) >> FRACBITS);

  if (den === 0) return 0;

  const num = ((((v1x - v2x) >> 8) * v1dy) >> FRACBITS) +
    ((((v2y - v1y) >> 8) * v1dx) >> FRACBITS);

  // FixedDiv
  if (Math.abs(num) >> 14 >= Math.abs(den)) {
    return num < 0 ? -0x7fffffff : 0x7fffffff;
  }
  return ((num << FRACBITS) / den) | 0;
}

/**
 * P_CrossSubsector — check if the sight line crosses a subsector without
 * being blocked by one-sided lines or narrowed fully by two-sided openings.
 */
function P_CrossSubsector(num: number): boolean {
  const sub = sc.sightMap!.subsectors[num];
  const segs = sc.sightMap!.segs;

  for (let i = 0; i < sub.numSegs; i++) {
    const seg = segs[sub.firstSeg + i];
    const line = seg.linedef;

    // Already checked this line?
    if (line.validcount === sc.sightValidcount) continue;
    line.validcount = sc.sightValidcount;

    const vertices = sc.sightMap!.vertices;
    const v1 = vertices[line.v1];
    const v2 = vertices[line.v2];

    // Check if the sight trace crosses this line
    let s1 = P_DivlineSide(v1.x, v1.y, sc.straceX, sc.straceY, sc.straceDx, sc.straceDy);
    let s2 = P_DivlineSide(v2.x, v2.y, sc.straceX, sc.straceY, sc.straceDx, sc.straceDy);

    // Line isn't crossed?
    if (s1 === s2) continue;

    // Check the reverse: does the line's divline separate strace origin from t2?
    const divlX = v1.x;
    const divlY = v1.y;
    const divlDx = v2.x - v1.x;
    const divlDy = v2.y - v1.y;

    s1 = P_DivlineSide(sc.straceX, sc.straceY, divlX, divlY, divlDx, divlDy);
    s2 = P_DivlineSide(sc.t2x, sc.t2y, divlX, divlY, divlDx, divlDy);

    // Line isn't crossed?
    if (s1 === s2) continue;

    // Stop: one-sided line blocks sight
    if (!(line.flags & ML_TWOSIDED)) return false;

    // Two-sided line: check opening
    const front = seg.frontsector;
    const back = seg.backsector;
    if (!front || !back) return false;

    // No wall to block sight with?
    if (front.floorHeight === back.floorHeight &&
      front.ceilingHeight === back.ceilingHeight) continue;

    // Calculate opening
    const opentop = front.ceilingHeight < back.ceilingHeight
      ? front.ceilingHeight : back.ceilingHeight;
    const openbottom = front.floorHeight > back.floorHeight
      ? front.floorHeight : back.floorHeight;

    // Totally closed door?
    if (openbottom >= opentop) return false;

    // Calculate fraction along the sight trace
    const frac = P_InterceptVector2(
      sc.straceX, sc.straceY, sc.straceDx, sc.straceDy,
      divlX, divlY, divlDx, divlDy,
    );

    if (frac <= 0) continue;

    // Narrow the slope window
    if (front.floorHeight !== back.floorHeight) {
      const slope = ((openbottom - sc.sightzstart) / frac * (1 << FRACBITS)) | 0;
      if (slope > sc.bottomslope) sc.bottomslope = slope;
    }

    if (front.ceilingHeight !== back.ceilingHeight) {
      const slope = ((opentop - sc.sightzstart) / frac * (1 << FRACBITS)) | 0;
      if (slope < sc.topslope) sc.topslope = slope;
    }

    if (sc.topslope <= sc.bottomslope) return false;
  }

  // Passed the subsector ok
  return true;
}

/**
 * P_CrossBSPNode — recursively check if the sight trace crosses the BSP node.
 */
function P_CrossBSPNode(bspnum: number): boolean {
  if (bspnum & NF_SUBSECTOR) {
    if (bspnum === 0xFFFF) {
      return P_CrossSubsector(0);
    }
    return P_CrossSubsector(bspnum & ~NF_SUBSECTOR);
  }

  const bsp = sc.sightMap!.nodes[bspnum];

  // Decide which side the start point is on
  let side = P_DivlineSide(sc.straceX, sc.straceY, bsp.x, bsp.y, bsp.dx, bsp.dy);
  if (side === 2) side = 0; // "on" should cross both sides

  // Cross the starting side
  if (!P_CrossBSPNode(bsp.children[side])) return false;

  // The partition plane is crossed here
  if (side === P_DivlineSide(sc.t2x, sc.t2y, bsp.x, bsp.y, bsp.dx, bsp.dy)) {
    // The line doesn't touch the other side
    return true;
  }

  // Cross the ending side
  return P_CrossBSPNode(bsp.children[side ^ 1]);
}

/**
 * Get the sector index for a MapObjState (using pointInSubsector).
 */
function getSectorIndex(mobj: MapObjState, map: GameMap): number {
  const ss = map.pointInSubsector(mobj.x, mobj.y);
  if (!ss.sector) return 0;
  const idx = map.sectors.indexOf(ss.sector);
  return idx >= 0 ? idx : 0;
}

/**
 * P_CheckSight — check if a straight line between t1 and t2 is unobstructed.
 * Uses REJECT matrix for fast rejection, then BSP traversal for accurate check.
 *
 * @param t1 The looker (monster)
 * @param t2 The target (player or other mobj)
 * @param map The current game map
 * @returns true if t2 is visible from t1
 */
export function P_CheckSight(
  t1: MapObjState,
  t2: MapObjState,
  map: GameMap,
  gi: GameInstance,
): boolean {
  const numSectors = map.sectors.length;

  // Determine sector indices for REJECT table lookup
  const s1 = getSectorIndex(t1, map);
  const s2 = getSectorIndex(t2, map);

  // Check REJECT matrix (fast rejection)
  const pnum = s1 * numSectors + s2;
  const bytenum = pnum >> 3;
  const bitnum = 1 << (pnum & 7);

  if (map.rejectMatrix.length > bytenum && (map.rejectMatrix[bytenum] & bitnum)) {
    // REJECT says these sectors can't see each other
    return false;
  }

  // Set up for BSP traversal
  sc = gi.sight;
  sc.sightMap = map;
  sc.sightValidcount = incValidcount(gi);

  // Eye position: z + 3/4 of height (eyes near top)
  sc.sightzstart = t1.z + t1.height - (t1.height >> 2);
  sc.topslope = (t2.z + t2.height) - sc.sightzstart;
  sc.bottomslope = t2.z - sc.sightzstart;

  sc.straceX = t1.x;
  sc.straceY = t1.y;
  sc.t2x = t2.x;
  sc.t2y = t2.y;
  sc.straceDx = t2.x - t1.x;
  sc.straceDy = t2.y - t1.y;

  // The head node is the last node output
  return P_CrossBSPNode(map.nodes.length - 1);
}
