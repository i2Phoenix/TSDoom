// ============================================================
// Monster Movement System
// Reference: p_map.c (P_TryMove, PIT_CheckLine, PIT_CheckThing)
//            p_enemy.c (P_Move, P_NewChaseDir, P_TryWalk)
// ============================================================

import { FRACBITS, FRACUNIT, fixedMul } from '../math';
import { GameMap, LineDef, ML_TWOSIDED, ML_BLOCKING } from '../map';
import { MapObjState, getMapObjects, getCurrentMap, DI_EAST, DI_NORTHEAST, DI_NORTH, DI_NORTHWEST, DI_WEST, DI_SOUTHWEST, DI_SOUTH, DI_SOUTHEAST, DI_NODIR, NUMDIRS } from './mobj';
import { MT, MF_SOLID, MF_SHOOTABLE, MF_FLOAT, MF_DROPOFF, MF_CORPSE, MF_NOBLOCKMAP, MF_MISSILE, MF_NOGRAVITY, MF_JUSTHIT } from './mobjinfo';
import { P_Random } from './random';
import { P_CheckSight } from './sight';
import { monsterUseSpecialLine, crossSpecialLine } from './specials';

// ---- Constants ----
const MAXMOVE       = 30 * FRACUNIT;  // max movement per tic
const MAXSTEPHEIGHT = 24 * FRACUNIT;  // max step-up
const FLOATSPEED    = 4 * FRACUNIT;   // flying monster vertical speed

// Speed tables for 8 cardinal/diagonal directions
// Each direction is a unit vector scaled to FRACUNIT
const xspeed = [FRACUNIT, 47000, 0, -47000, -FRACUNIT, -47000, 0, 47000];
const yspeed = [0, 47000, FRACUNIT, 47000, 0, -47000, -FRACUNIT, -47000];

// Direction opposites
const opposite: number[] = [
  DI_WEST,      // DI_EAST
  DI_SOUTHWEST, // DI_NORTHEAST
  DI_SOUTH,     // DI_NORTH
  DI_SOUTHEAST, // DI_NORTHWEST
  DI_EAST,      // DI_WEST
  DI_NORTHEAST, // DI_SOUTHWEST
  DI_NORTH,     // DI_SOUTH
  DI_NORTHWEST, // DI_SOUTHEAST
  DI_NODIR,     // DI_NODIR
];

// Diagonal directions indexed by (deltaX > 0, deltaY > 0)
const diags: number[] = [
  DI_NORTHWEST, // -x, +y
  DI_NORTHEAST, // +x, +y
  DI_SOUTHWEST, // -x, -y
  DI_SOUTHEAST, // +x, -y
];

// ---- P_TryMove state ----
let tmFloorZ = 0;
let tmCeilingZ = 0;
let tmDropoffZ = 0;   // lowest floor touched by bboxes
let floatok = false;   // true if move would be ok if FLOAT

// Special lines crossed during movement (for door/lift activation)
const spechit: LineDef[] = [];

/**
 * P_TryMove — attempt to move actor to (newx, newy).
 * Returns true if the move is legal, false if blocked.
 * Sets tmFloorZ, tmCeilingZ, tmDropoffZ, floatok.
 */
export function P_TryMove(
  actor: MapObjState,
  newx: number,
  newy: number,
  map: GameMap,
): boolean {
  floatok = false;
  spechit.length = 0;

  // Check line collisions (PIT_CheckLine equivalent)
  const bbox = {
    top: newy + actor.radius,
    bottom: newy - actor.radius,
    left: newx - actor.radius,
    right: newx + actor.radius,
  };

  // Find floor/ceiling at new position
  const ss = map.pointInSubsector(newx, newy);
  const sec = ss.sector;
  if (!sec) return false;

  tmFloorZ = sec.floorHeight;
  tmCeilingZ = sec.ceilingHeight;
  tmDropoffZ = sec.floorHeight;

  // Check all linedefs for collision (simplified — not using blockmap iterator)
  for (let i = 0; i < map.linedefs.length; i++) {
    const ld = map.linedefs[i];
    const v1 = map.vertices[ld.v1];
    const v2 = map.vertices[ld.v2];

    // Quick bbox rejection
    const ldLeft = Math.min(v1.x, v2.x);
    const ldRight = Math.max(v1.x, v2.x);
    const ldBottom = Math.min(v1.y, v2.y);
    const ldTop = Math.max(v1.y, v2.y);

    if (ldRight < bbox.left || ldLeft > bbox.right ||
        ldTop < bbox.bottom || ldBottom > bbox.top) {
      continue;
    }

    // Check if bbox actually crosses the line
    if (!boxCrossesLine(bbox, v1.x, v1.y, ld.dx, ld.dy)) {
      continue;
    }

    // One-sided line — always blocks
    if (!(ld.flags & ML_TWOSIDED)) {
      return false;
    }

    // ML_BLOCKING — blocks everything
    if (ld.flags & ML_BLOCKING) {
      return false;
    }

    const front = ld.frontsector;
    const back = ld.backsector;
    if (!front || !back) return false;

    // Compute opening
    const openTop = Math.min(front.ceilingHeight, back.ceilingHeight);
    const openBottom = Math.max(front.floorHeight, back.floorHeight);
    const lowFloor = Math.min(front.floorHeight, back.floorHeight);

    // Update floor/ceiling tracking
    if (openTop < tmCeilingZ) tmCeilingZ = openTop;
    if (openBottom > tmFloorZ) tmFloorZ = openBottom;
    if (lowFloor < tmDropoffZ) tmDropoffZ = lowFloor;

    // Check if opening is large enough
    if (openTop - openBottom < actor.height) {
      return false; // doesn't fit
    }

    // Step-up too high
    if (openBottom - actor.z > MAXSTEPHEIGHT) {
      return false;
    }

    // Ceiling too low
    if (openTop - actor.z < actor.height) {
      return false;
    }

    // Track special lines for door/lift activation
    if (ld.special) {
      spechit.push(ld);
    }
  }

  // Check thing-thing collisions
  const objects = getMapObjects();
  for (let i = 0; i < objects.length; i++) {
    const other = objects[i];
    if (other === actor) continue;
    if (other.removed) continue;
    if (other.health <= 0) continue;  // skip dead things
    if (!(other.flags & MF_SOLID)) continue;

    // Cylinder overlap check
    const blockDist = actor.radius + other.radius;
    if (Math.abs(newx - other.x) >= blockDist ||
        Math.abs(newy - other.y) >= blockDist) {
      continue;
    }

    // Blocked by another solid thing
    return false;
  }

  // Dropoff check: don't walk off tall edges (unless MF_FLOAT or MF_DROPOFF)
  if (!(actor.flags & MF_FLOAT) && !(actor.flags & MF_DROPOFF)) {
    if (tmFloorZ - tmDropoffZ > MAXSTEPHEIGHT) {
      return false;
    }
  }

  // Gravity check: can the actor reach the floor?
  if (!(actor.flags & MF_FLOAT) && tmFloorZ - actor.z > MAXSTEPHEIGHT) {
    return false;
  }

  // Flying: check if movement would be ok height-wise
  if (actor.flags & MF_FLOAT) {
    if (actor.z < tmFloorZ) {
      floatok = true;
    } else if (actor.z + actor.height > tmCeilingZ) {
      floatok = true;
    }
  }

  return true;
}

/**
 * P_Move — move the actor one step in its movedir direction.
 * Returns true if the move was successful.
 */
export function P_Move(actor: MapObjState): boolean {
  if (actor.movedir === DI_NODIR) return false;

  const map = getCurrentMap();
  if (!map) return false;

  // Save old position for line-crossing detection
  const oldX = actor.x;
  const oldY = actor.y;

  const speed = actor.info ? actor.info.speed : 8;
  const tryx = actor.x + fixedMul(speed * FRACUNIT, xspeed[actor.movedir]);
  const tryy = actor.y + fixedMul(speed * FRACUNIT, yspeed[actor.movedir]);

  if (!P_TryMove(actor, tryx, tryy, map)) {
    // Can't move directly — try activating any special lines we touched
    if (spechit.length > 0) {
      // Monsters try to activate special lines they bumped into (doors mostly)
      for (let i = spechit.length - 1; i >= 0; i--) {
        monsterUseSpecialLine(spechit[i]);
      }
    }

    // If floating and the destination height was ok, adjust vertically
    if ((actor.flags & MF_FLOAT) && floatok) {
      if (actor.z < tmFloorZ) {
        actor.z += FLOATSPEED;
      } else {
        actor.z -= FLOATSPEED;
      }
      return true;
    }

    return false;
  }

  // Move successful
  actor.x = tryx;
  actor.y = tryy;

  // Update floor/ceiling
  actor.floorz = tmFloorZ;
  actor.ceilingz = tmCeilingZ;

  // Non-floating: always snap to floor (handles both step-up and step-down)
  if (!(actor.flags & MF_FLOAT)) {
    actor.z = actor.floorz;
  }

  // Float adjust: smoothly move toward target z
  if ((actor.flags & MF_FLOAT) && actor.target) {
    const dist = Math.abs(actor.x - actor.target.x) + Math.abs(actor.y - actor.target.y);
    // delta = target z + half height offset - our z
    const delta = actor.target.z + (actor.height >> 1) - actor.z;

    if (delta < 0 && dist < -(delta * 3)) {
      actor.z -= FLOATSPEED;
    } else if (delta > 0 && dist < (delta * 3)) {
      actor.z += FLOATSPEED;
    }
  }

  // Check if monster crossed a teleport line (walk triggers)
  checkMonsterLineCrossings(actor, oldX, oldY, map);

  return true;
}

/**
 * Check if a monster crossed any walk-trigger linedefs during its move.
 * Primarily handles teleport lines (39, 97, 125, 126).
 * Reference: P_CrossSpecialLine in p_spec.c
 */
function checkMonsterLineCrossings(
  actor: MapObjState, oldX: number, oldY: number, map: GameMap
): void {
  if (actor.x === oldX && actor.y === oldY) return;

  const radius = actor.radius || (20 << FRACBITS);

  for (const ld of map.linedefs) {
    if (ld.special === 0) continue;

    const v1 = map.vertices[ld.v1];
    const v2 = map.vertices[ld.v2];

    // Quick distance rejection
    const midx = (v1.x + v2.x) >> 1;
    const midy = (v1.y + v2.y) >> 1;
    if (Math.abs(midx - actor.x) > radius * 4 ||
        Math.abs(midy - actor.y) > radius * 4) continue;

    // Check if the monster crossed from one side to the other
    const ldx = v2.x - v1.x;
    const ldy = v2.y - v1.y;

    const oldCross = ((oldX - v1.x) / FRACUNIT) * (ldy / FRACUNIT) -
                     ((oldY - v1.y) / FRACUNIT) * (ldx / FRACUNIT);
    const newCross = ((actor.x - v1.x) / FRACUNIT) * (ldy / FRACUNIT) -
                     ((actor.y - v1.y) / FRACUNIT) * (ldx / FRACUNIT);

    const oldSide = oldCross <= 0 ? 1 : 0;
    const newSide = newCross <= 0 ? 1 : 0;

    if (oldSide !== newSide) {
      crossSpecialLine(ld, newSide, actor);
    }
  }
}

/**
 * P_TryWalk — attempt to walk in the given direction.
 * If successful, sets movecount to a random value (for patrol wandering).
 */
function P_TryWalk(actor: MapObjState): boolean {
  if (!P_Move(actor)) return false;
  actor.movecount = P_Random() & 15;
  return true;
}

/**
 * P_NewChaseDir — compute a new direction for the actor to chase its target.
 * This is the core pathfinding algorithm from DOOM — it tries to move
 * diagonally toward the target, then cardinal directions, with randomization.
 */
export function P_NewChaseDir(actor: MapObjState): void {
  if (!actor.target) return;

  const olddir = actor.movedir;
  const turnaround = opposite[olddir];

  const deltax = actor.target.x - actor.x;
  const deltay = actor.target.y - actor.y;

  // Determine preferred X and Y directions
  let d1: number, d2: number;
  let tdir: number;

  if (deltax > 10 * FRACUNIT) {
    d1 = DI_EAST;
  } else if (deltax < -10 * FRACUNIT) {
    d1 = DI_WEST;
  } else {
    d1 = DI_NODIR;
  }

  if (deltay < -10 * FRACUNIT) {
    d2 = DI_SOUTH;
  } else if (deltay > 10 * FRACUNIT) {
    d2 = DI_NORTH;
  } else {
    d2 = DI_NODIR;
  }

  // Try diagonal first
  if (d1 !== DI_NODIR && d2 !== DI_NODIR) {
    const diagIdx = ((deltay < 0) ? 2 : 0) + ((deltax > 0) ? 1 : 0);
    actor.movedir = diags[diagIdx];
    if (actor.movedir !== turnaround && P_TryWalk(actor)) return;
  }

  // Try direct directions, with randomization for variety
  if (P_Random() > 200 || Math.abs(deltay) > Math.abs(deltax)) {
    // Swap preference
    const temp = d1;
    d1 = d2;
    d2 = temp;
  }

  if (d1 !== DI_NODIR && d1 !== turnaround) {
    actor.movedir = d1;
    if (P_TryWalk(actor)) return;
  }

  if (d2 !== DI_NODIR && d2 !== turnaround) {
    actor.movedir = d2;
    if (P_TryWalk(actor)) return;
  }

  // Try the old direction
  if (olddir !== DI_NODIR) {
    actor.movedir = olddir;
    if (P_TryWalk(actor)) return;
  }

  // Randomly determine search direction
  if (P_Random() & 1) {
    for (tdir = DI_EAST; tdir <= DI_SOUTHEAST; tdir++) {
      if (tdir !== turnaround) {
        actor.movedir = tdir;
        if (P_TryWalk(actor)) return;
      }
    }
  } else {
    for (tdir = DI_SOUTHEAST; tdir >= DI_EAST; tdir--) {
      if (tdir !== turnaround) {
        actor.movedir = tdir;
        if (P_TryWalk(actor)) return;
      }
    }
  }

  // As a last resort, try turnaround
  if (turnaround !== DI_NODIR) {
    actor.movedir = turnaround;
    if (P_TryWalk(actor)) return;
  }

  // Completely stuck
  actor.movedir = DI_NODIR;
  actor.movecount = 0;
}

/**
 * P_CheckMeleeRange — is the actor close enough to melee attack?
 * Distance must be < MELEERANGE (64 units) + target.radius.
 */
export function P_CheckMeleeRange(actor: MapObjState): boolean {
  if (!actor.target) return false;
  const target = actor.target;

  const dist = approxDist(actor.x - target.x, actor.y - target.y);
  if (dist >= (64 * FRACUNIT) + target.radius - (20 * FRACUNIT)) {
    return false;
  }

  // Must have line of sight
  const map = getCurrentMap();
  if (!map) return false;

  return P_CheckSight(actor, target, map);
}

/**
 * P_CheckMissileRange — should the actor fire a ranged attack?
 * Returns false if too close (use melee), too far, or random check fails.
 */
export function P_CheckMissileRange(actor: MapObjState): boolean {
  if (!actor.target) return false;
  const map = getCurrentMap();
  if (!map) return false;

  if (!P_CheckSight(actor, actor.target, map)) return false;

  // If MF_JUSTHIT, attack now! (infighting response)
  if (actor.flags & MF_JUSTHIT) {
    actor.flags &= ~MF_JUSTHIT;
    return true;
  }

  // Don't attack during reactiontime
  if (actor.reactiontime > 0) return false;

  let dist = approxDist(actor.x - actor.target.x, actor.y - actor.target.y);
  dist = (dist >> FRACBITS) - 64;  // in map units, minus 64

  // No melee state → always try ranged (but halve effective distance)
  if (!actor.info || !actor.info.hasMeleeState) {
    dist -= 128;
  }

  if (dist < 0) dist = 0;

  // Per-monster distance adjustments (from DOOM p_enemy.c, exact ordering)
  const mt = actor.mobjType;

  // Arch-vile: max range 14*64 = 896
  if (mt === MT.MT_VILE && dist > 14 * 64) return false;

  // Revenant: won't fire if under 196 (prefers fist attack), halve dist
  if (mt === MT.MT_UNDEAD) {
    if (dist < 196) return false;
    dist >>= 1;
  }

  // Cyberdemon, Spider, Lost Soul: halve effective distance (fire more aggressively)
  if (mt === MT.MT_CYBORG || mt === MT.MT_SPIDER || mt === MT.MT_SKULL) {
    dist >>= 1;
  }

  // General cap: no monster fires less than P_Random() < 200
  if (dist > 200) dist = 200;

  // Cyberdemon-specific: even more aggressive cap
  if (mt === MT.MT_CYBORG && dist > 160) dist = 160;

  // Random chance based on distance — higher dist = less likely to fire
  if (P_Random() < dist) return false;

  return true;
}

// ---- Helper functions ----

/** Box crosses line check (P_BoxOnLineSide = -1 means crossing) */
function boxCrossesLine(
  box: { top: number; bottom: number; left: number; right: number },
  lx: number, ly: number, ldx: number, ldy: number,
): boolean {
  // Test all four corners of the box against the line
  const corners = [
    ptOnSide(box.left, box.top, lx, ly, ldx, ldy),
    ptOnSide(box.right, box.top, lx, ly, ldx, ldy),
    ptOnSide(box.left, box.bottom, lx, ly, ldx, ldy),
    ptOnSide(box.right, box.bottom, lx, ly, ldx, ldy),
  ];

  // If all corners on same side, box doesn't cross
  const first = corners[0];
  for (let i = 1; i < 4; i++) {
    if (corners[i] !== first) return true; // crossing
  }
  return false;
}

/** Which side of a line is a point on? Returns 0 or 1 */
function ptOnSide(
  x: number, y: number,
  lx: number, ly: number, ldx: number, ldy: number,
): number {
  const dx = (x - lx);
  const dy = (y - ly);
  // Cross product (avoid FRACUNIT overflow by shifting)
  const left = (dy >> FRACBITS) * (ldx >> FRACBITS);
  const right = (dx >> FRACBITS) * (ldy >> FRACBITS);
  return left > right ? 0 : 1;
}

/** Approximate distance (DOOM's P_AproxDistance) */
function approxDist(dx: number, dy: number): number {
  dx = Math.abs(dx);
  dy = Math.abs(dy);
  if (dx < dy) return dx + dy - (dx >> 1);
  return dx + dy - (dy >> 1);
}
