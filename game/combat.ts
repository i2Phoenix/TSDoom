// ============================================================
// Combat System — Hitscan, Damage, Explosions
// Reference: p_map.c (P_AimLineAttack, P_LineAttack, PTR_ShootTraverse)
//            p_pspr.c (P_BulletSlope, P_GunShot)
//            p_inter.c (P_DamageMobj, P_RadiusAttack)
// ============================================================

import {
  FRACBITS, FRACUNIT, ANGLETOFINESHIFT, FINEMASK,
  finesine, finecosine, fixedMul, fixedDiv, pointToAngle,
} from './math';
import { ML_TWOSIDED, type GameMap, type LineDef } from './map-types';
import { FX_DynLight, FX_Sound } from './effects';
import { GameInstance } from './game-instance';
import { P_Random } from './random';
import {
  MapObjState, getMapObjects, damageMobj, isBarrel,
  MF_SHOOTABLE, MF_NOBLOOD,
} from './mobj';
import { spawnPuff, spawnBlood, spawnBarrelExplosion } from './vfx';
import { Player } from './player';

import { Sfx } from './sounds';
import { shootSpecialLine } from './specials';
import { getFreelook } from './settings';

import { MELEERANGE, MISSILERANGE } from './constants';
const PLAYERRADIUS = 16;  // player collision radius in map units

// ---- Module state (delegated to GameInstance.combat) ----

// ============================================================
// Line–wall intersection test
// Returns the fraction (0..1 in fixed-point) along the ray
// where it hits the linedef, or -1 if no hit.
// ============================================================

export function lineIntersectFrac(
  x1: number, y1: number,  // ray start (fixed_t)
  dx: number, dy: number,  // ray delta (fixed_t)
  lx1: number, ly1: number, // line start (fixed_t)
  ldx: number, ldy: number  // line delta (fixed_t)
): number {
  // Solve parametric intersection of ray vs line segment
  // ray: P = (x1,y1) + t*(dx,dy)
  // line: Q = (lx1,ly1) + s*(ldx,ldy)
  // Using cross products in integer arithmetic
  const denom = (dx >> FRACBITS) * (ldy >> FRACBITS) - (dy >> FRACBITS) * (ldx >> FRACBITS);
  if (denom === 0) return -1; // parallel

  const nx = (lx1 - x1) >> FRACBITS;
  const ny = (ly1 - y1) >> FRACBITS;

  const t_num = nx * (ldy >> FRACBITS) - ny * (ldx >> FRACBITS);
  const s_num = nx * (dy >> FRACBITS) - ny * (dx >> FRACBITS);

  // Check both ray parameter t and line parameter s are in [0, 1]
  if (denom > 0) {
    if (t_num < 0 || t_num > denom) return -1;
    if (s_num < 0 || s_num > denom) return -1;
  } else {
    if (t_num > 0 || t_num < denom) return -1;
    if (s_num > 0 || s_num < denom) return -1;
  }

  // Return t as a fixed-point fraction
  return ((t_num * FRACUNIT) / denom) | 0;
}

// ============================================================
// Check if a ray is blocked by walls (linedefs)
// Returns the fraction at which the ray is blocked, or
// FRACUNIT if it reaches full range unblocked.
// ============================================================

export function traceWalls(
  x1: number, y1: number,
  dx: number, dy: number,
  slope: number,
  shootz: number,
  range: number = MISSILERANGE,
  gi: GameInstance,
): { frac: number; hitLine: LineDef | null } {
  const currentMap = gi.currentMap;
  if (!currentMap) return { frac: FRACUNIT, hitLine: null };

  let bestFrac = FRACUNIT;
  let hitLine: LineDef | null = null;

  for (const line of currentMap.linedefs) {
    const v1 = currentMap.vertices[line.v1];
    const v2 = currentMap.vertices[line.v2];
    const lx1 = v1.x;
    const ly1 = v1.y;
    const ldx = v2.x - v1.x;
    const ldy = v2.y - v1.y;

    const frac = lineIntersectFrac(x1, y1, dx, dy, lx1, ly1, ldx, ldy);
    if (frac < 0 || frac >= bestFrac) continue;

    // One-sided line → always blocks
    if (!(line.flags & ML_TWOSIDED)) {
      bestFrac = frac;
      hitLine = line;
      continue;
    }

    // Two-sided — check if the shot passes through the opening
    const front = line.frontsector;
    const back = line.backsector;
    if (!front || !back) {
      bestFrac = frac;
      hitLine = line;
      continue;
    }

    const opentop = Math.min(front.ceilingHeight, back.ceilingHeight);
    const openbottom = Math.max(front.floorHeight, back.floorHeight);

    if (openbottom >= opentop) {
      // Closed — blocks
      bestFrac = frac;
      hitLine = line;
      continue;
    }

    // Check if the shot z at this point passes through the opening
    // hitZ = shootz + slope * actualDistance, where actualDistance = frac * range
    const hitZ = shootz + fixedMul(slope, fixedMul(frac, range));

    if (hitZ < openbottom || hitZ > opentop) {
      bestFrac = frac;
      hitLine = line;
    }
    // Otherwise shot passes through
  }

  return { frac: bestFrac, hitLine };
}

// ============================================================
// Collect wall intercepts for autoaim slope narrowing
// Returns sorted (by frac) array of { frac, opentop, openbottom }
// for two-sided linedefs, and the fraction of the first
// one-sided blocking wall.
// Reference: PTR_AimTraverse in p_map.c
// ============================================================

interface AimIntercept {
  frac: number;
  opentop: number;
  openbottom: number;
  floorDiffers: boolean;
  ceilDiffers: boolean;
}

function collectAimIntercepts(
  x1: number, y1: number,
  dx: number, dy: number,
  gi: GameInstance,
): { intercepts: AimIntercept[]; solidFrac: number } {
  const currentMap = gi.currentMap;
  if (!currentMap) return { intercepts: [], solidFrac: FRACUNIT };

  const intercepts: AimIntercept[] = [];
  let solidFrac = FRACUNIT;

  for (const line of currentMap.linedefs) {
    const v1 = currentMap.vertices[line.v1];
    const v2 = currentMap.vertices[line.v2];
    const lx1 = v1.x;
    const ly1 = v1.y;
    const ldx = v2.x - v1.x;
    const ldy = v2.y - v1.y;

    const frac = lineIntersectFrac(x1, y1, dx, dy, lx1, ly1, ldx, ldy);
    if (frac < 0 || frac >= solidFrac) continue;

    // One-sided line → solid wall, blocks everything beyond
    if (!(line.flags & ML_TWOSIDED)) {
      if (frac < solidFrac) solidFrac = frac;
      continue;
    }

    const front = line.frontsector;
    const back = line.backsector;
    if (!front || !back) {
      if (frac < solidFrac) solidFrac = frac;
      continue;
    }

    const opentop = Math.min(front.ceilingHeight, back.ceilingHeight);
    const openbottom = Math.max(front.floorHeight, back.floorHeight);

    if (openbottom >= opentop) {
      // Closed two-sided line — acts as solid
      if (frac < solidFrac) solidFrac = frac;
      continue;
    }

    intercepts.push({
      frac,
      opentop,
      openbottom,
      floorDiffers: front.floorHeight !== back.floorHeight,
      ceilDiffers: front.ceilingHeight !== back.ceilingHeight,
    });
  }

  // Sort by frac (nearest first) — matches DOOM's P_PathTraverse ordering
  intercepts.sort((a, b) => a.frac - b.frac);

  return { intercepts, solidFrac };
}

// ============================================================
// P_AimLineAttack — autoaim
// Finds the closest shootable thing along the ray and returns
// the slope to aim at it. Sets linetarget.
//
// This is a faithful port of PTR_AimTraverse from p_map.c:
//   - Two-sided linedefs NARROW the topslope/bottomslope
//   - The narrowed slopes determine which things are aimable
//   - First hit (nearest) thing wins
// ============================================================

export function P_AimLineAttack(
  shooterX: number, shooterY: number, shooterZ: number,
  angle: number,
  range: number,
  gi: GameInstance,
): number {
  const cc = gi.combat;
  cc.linetarget = null;
  cc.aimslope = 0;

  const an = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
  const dx = fixedMul(range, finecosine(an));
  const dy = fixedMul(range, finesine[an]);
  // shootz: callers pass viewz (= z + 41), we don't add extra offset
  // Original DOOM: shootz = t1->z + (t1->height>>1) + 8*FRACUNIT = z + 36
  // Our viewz is z + 41 which is close enough (5 units higher)
  const shootz = shooterZ;

  // Aim slope limits — can't shoot outside view angles
  // (from p_map.c: topslope = 100*FRACUNIT/160)
  let topslope = ((100 * FRACUNIT) / 160) | 0;
  let bottomslope = ((-100 * FRACUNIT) / 160) | 0;

  // Collect all wall intercepts for slope narrowing
  const { intercepts, solidFrac } = collectAimIntercepts(
    shooterX, shooterY, dx, dy, gi
  );

  // Build sorted list of all things along the ray
  interface ThingHit {
    obj: MapObjState;
    frac: number;
    dot: number;
  }
  const thingHits: ThingHit[] = [];

  const mapObjs = getMapObjects(gi);
  for (const obj of mapObjs) {
    if (obj.removed) continue;
    if (!(obj.flags & MF_SHOOTABLE)) continue;

    const tdx = obj.x - shooterX;
    const tdy = obj.y - shooterY;

    // Project onto ray direction to get distance along ray
    const dot = fixedMul(tdx, finecosine(an)) + fixedMul(tdy, finesine[an]);
    if (dot <= 0 || dot > range) continue;

    // Check perpendicular distance (how far off the ray)
    const perp = Math.abs(fixedMul(tdx, finesine[an]) - fixedMul(tdy, finecosine(an)));
    if (perp > obj.radius) continue;

    const thingFrac = fixedDiv(dot, range);
    if (thingFrac >= solidFrac) continue;

    thingHits.push({ obj, frac: thingFrac, dot });
  }

  // Sort things by distance (nearest first)
  thingHits.sort((a, b) => a.frac - b.frac);

  // Now process intercepts and things in order (merged traversal),
  // matching DOOM's P_PathTraverse with PT_ADDLINES|PT_ADDTHINGS
  let lineIdx = 0;
  let thingIdx = 0;

  while (lineIdx < intercepts.length || thingIdx < thingHits.length) {
    // Determine which comes next: a line intercept or a thing?
    const lineFrac = lineIdx < intercepts.length ? intercepts[lineIdx].frac : FRACUNIT + 1;
    const thingFrac = thingIdx < thingHits.length ? thingHits[thingIdx].frac : FRACUNIT + 1;

    if (lineFrac <= thingFrac) {
      // Process line intercept — narrow the aim slopes
      // (PTR_AimTraverse line handling)
      const li = intercepts[lineIdx];
      lineIdx++;

      const dist = fixedMul(range, li.frac);
      if (dist <= 0) continue;

      // Narrow bottomslope based on floor height difference
      if (li.floorDiffers) {
        const slope = fixedDiv(li.openbottom - shootz, dist);
        if (slope > bottomslope) {
          bottomslope = slope;
        }
      }

      // Narrow topslope based on ceiling height difference
      if (li.ceilDiffers) {
        const slope = fixedDiv(li.opentop - shootz, dist);
        if (slope < topslope) {
          topslope = slope;
        }
      }

      // If slopes have crossed, no more aiming is possible
      if (topslope <= bottomslope) {
        return 0;
      }
    } else {
      // Process thing — check if it's aimable with current slopes
      // (PTR_AimTraverse thing handling)
      const th = thingHits[thingIdx];
      thingIdx++;

      const dist = th.dot;
      if (dist <= 0) continue;

      let thingtopslope = fixedDiv(th.obj.z + th.obj.height - shootz, dist);
      const thingbottomslope = fixedDiv(th.obj.z - shootz, dist);

      // Check if thing is outside the current aim window
      if (thingtopslope < bottomslope) continue;  // shot over the thing
      if (thingbottomslope > topslope) continue;   // shot under the thing

      // This thing can be hit! Clamp slopes to aim window
      if (thingtopslope > topslope) {
        thingtopslope = topslope;
      }
      let clampedBottom = thingbottomslope;
      if (clampedBottom < bottomslope) {
        clampedBottom = bottomslope;
      }

      cc.aimslope = ((thingtopslope + clampedBottom) / 2) | 0;
      cc.linetarget = th.obj;
      return cc.aimslope;  // don't go any farther
    }
  }

  return 0;
}

// ============================================================
// P_LineAttack — fire a shot along a ray
// If damage > 0, applies damage to the first thing hit.
// ============================================================

export function P_LineAttack(
  shooterX: number, shooterY: number, shooterZ: number,
  angle: number,
  range: number,
  slope: number,
  damage: number,
  gi: GameInstance,
): void {
  const an = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
  const dx = fixedMul(range, finecosine(an));
  const dy = fixedMul(range, finesine[an]);
  const shootz = shooterZ;

  // Get wall block distance
  const { frac: wallFrac, hitLine: wallHitLine } = traceWalls(shooterX, shooterY, dx, dy, slope, shootz, range, gi);

  // Check thing hits (find closest within wall block distance)
  let bestFrac = wallFrac;
  let hitTarget: MapObjState | null = null;

  const mapObjs = getMapObjects(gi);
  for (const obj of mapObjs) {
    if (obj.removed) continue;
    if (!(obj.flags & MF_SHOOTABLE)) continue;

    const tdx = obj.x - shooterX;
    const tdy = obj.y - shooterY;

    // Distance along ray
    const dot = fixedMul(tdx, finecosine(an)) + fixedMul(tdy, finesine[an]);
    if (dot <= 0 || dot > range) continue;

    // Perpendicular distance
    const perp = Math.abs(fixedMul(tdx, finesine[an]) - fixedMul(tdy, finecosine(an)));
    if (perp > obj.radius) continue;

    // Fraction along ray
    const thingFrac = fixedDiv(dot, range);
    if (thingFrac >= bestFrac) continue;

    // Vertical check
    const hitZ = shootz + fixedMul(slope, fixedMul(thingFrac, range));
    if (hitZ < obj.z || hitZ > obj.z + obj.height) continue;

    bestFrac = thingFrac;
    hitTarget = obj;
  }

  if (hitTarget && damage > 0) {
    gi.combat.linetarget = hitTarget;
    console.log(`[combat] Hit type=${hitTarget.type} health=${hitTarget.health} damage=${damage}`);
    const killed = damageMobj(hitTarget, damage, null, gi);
    console.log(`[combat] killed=${killed} isBarrel=${isBarrel(hitTarget.type)} health_after=${hitTarget.health}`);

    // Spawn blood/puff at hit location
    const hitX = shooterX + fixedMul(bestFrac, dx);
    const hitY = shooterY + fixedMul(bestFrac, dy);
    const hitZ = shootz + fixedMul(slope, fixedMul(bestFrac, range));

    if (hitTarget.flags & MF_NOBLOOD) {
      spawnPuff(hitX, hitY, hitZ, false, gi);
    } else {
      spawnBlood(hitX, hitY, hitZ, damage, gi);
    }

    // If it was a barrel and it died, trigger explosion animation
    if (killed && isBarrel(hitTarget.type)) {
      console.log(`[combat] Spawning barrel explosion VFX`);
      spawnBarrelExplosion(hitTarget.x, hitTarget.y, hitTarget.z, () => {
        P_RadiusAttack(hitTarget.x, hitTarget.y, hitTarget.z, 128, gi);
      }, gi);
    }
  } else if (bestFrac < FRACUNIT) {
    // Hit a wall — spawn puff slightly BACK from wall surface
    // (like original DOOM: 4 units back along trace to stay in front subsector)
    const pullback = 4 * FRACUNIT;
    const traceLen = fixedMul(bestFrac, range);
    const adjustedLen = traceLen > pullback ? traceLen - pullback : 0;
    const adjFrac = range > 0 ? fixedDiv(adjustedLen, range) : 0;
    const hitX = shooterX + fixedMul(adjFrac, dx);
    const hitY = shooterY + fixedMul(adjFrac, dy);
    const hitZ = shootz + fixedMul(slope, adjustedLen);
    const isMelee = range <= MELEERANGE + FRACUNIT;
    spawnPuff(hitX, hitY, hitZ, isMelee, gi);

    // P_ShootSpecialLine — trigger gun-activated linedefs
    if (wallHitLine && wallHitLine.special) {
      shootSpecialLine(wallHitLine, gi);
    }
  }
}

// ============================================================
// P_BulletSlope — autoaim for hitscan weapons
// Three-pass autoaim: center, +5°, -5°
// (from p_pspr.c)
// ============================================================

export function P_BulletSlope(
  x: number, y: number, z: number, angle: number,
  gi: GameInstance,
): void {
  const cc = gi.combat;

  if (getFreelook() && gi.world?.player) {
    // Freelook: fire along player's pitch direction, no autoaim
    // Convert pitch to slope: slope = pitch * (baseViewHeight/2) / (baseViewWidth/2)
    // Base DOOM: viewheight=168, viewwidth=320, so ratio = 84/160 = 0.525
    // This matches the Y-shearing screen offset to actual firing angle
    cc.bulletslope = Math.round(gi.world.player.pitch * 84 / 160);
    cc.linetarget = null;
    return;
  }

  // Classic mode: autoaim scanning
  // Try center first
  cc.bulletslope = P_AimLineAttack(x, y, z, angle, 16 * 64 * FRACUNIT, gi);

  if (!cc.linetarget) {
    // Try +5 degrees (1<<26 ≈ 5.625°)
    const an1 = (angle + (1 << 26)) >>> 0;
    cc.bulletslope = P_AimLineAttack(x, y, z, an1, 16 * 64 * FRACUNIT, gi);

    if (!cc.linetarget) {
      // Try -5 degrees
      const an2 = (angle - (2 << 26)) >>> 0;
      cc.bulletslope = P_AimLineAttack(x, y, z, an2, 16 * 64 * FRACUNIT, gi);
    }
  }
}

/** Get current bulletslope value */
export function getBulletSlope(gi: GameInstance): number {
  return gi.combat.bulletslope;
}

// ============================================================
// P_GunShot — fire a single bullet
// (from p_pspr.c)
// ============================================================

export function P_GunShot(
  x: number, y: number, z: number,
  angle: number,
  accurate: boolean,
  gi: GameInstance,
): void {
  const damage = 5 * ((P_Random(gi) % 3) + 1);
  let shotAngle = angle;

  if (!accurate) {
    shotAngle = (shotAngle + ((P_Random(gi) - P_Random(gi)) << 18)) >>> 0;
  }

  P_LineAttack(x, y, z, shotAngle, MISSILERANGE, gi.combat.bulletslope, damage, gi);

  // Muzzle flash dynamic light (yellow-white, short)
  FX_DynLight(x, y, z, 96 * FRACUNIT, 255, 224, 128, 0.5, 3);
}

// ============================================================
// P_RadiusAttack — splash damage
// Damages all shootable things within `damage` units
// (from p_map.c)
// ============================================================

export function P_RadiusAttack(
  spotX: number, spotY: number, spotZ: number,
  damage: number,
  gi: GameInstance,
): void {
  // Explosion dynamic light (orange, moderate)
  FX_DynLight(spotX, spotY, spotZ, 192 * FRACUNIT, 255, 160, 48, 0.6, 10);
  FX_Sound({ x: spotX, y: spotY }, Sfx.barexp);

  const mapObjs = getMapObjects(gi);

  for (const obj of mapObjs) {
    if (obj.removed) continue;
    if (!(obj.flags & MF_SHOOTABLE)) continue;

    const dx = Math.abs(obj.x - spotX) >> FRACBITS;
    const dy = Math.abs(obj.y - spotY) >> FRACBITS;
    const dist = Math.max(dx, dy) - (obj.radius >> FRACBITS);
    const finalDist = Math.max(0, dist);

    if (finalDist >= damage) continue; // out of range

    const appliedDamage = damage - finalDist;
    const killed = damageMobj(obj, appliedDamage, null, gi);

    // Chain barrel explosions with VFX
    if (killed && isBarrel(obj.type)) {
      spawnBarrelExplosion(obj.x, obj.y, obj.z, () => {
        P_RadiusAttack(obj.x, obj.y, obj.z, 128, gi);
      }, gi);
    }
  }

  // Also damage the player (original DOOM iterates ALL things including player)
  const combatPlayer = gi.world?.player;
  if (combatPlayer && combatPlayer.health > 0) {
    const pdx = Math.abs(combatPlayer.x - spotX) >> FRACBITS;
    const pdy = Math.abs(combatPlayer.y - spotY) >> FRACBITS;
    const playerDist = Math.max(pdx, pdy) - PLAYERRADIUS;
    const pFinalDist = Math.max(0, playerDist);

    if (pFinalDist < damage) {
      const playerDamage = damage - pFinalDist;
      console.log(`[combat] Barrel splash: dist=${pFinalDist} damage=${playerDamage} playerHealth=${combatPlayer.health}`);
      combatPlayer.takeDamage(playerDamage, spotX, spotY);
    }
  }
}

// ============================================================
// Exports for weapon actions
// ============================================================
/** Get current linetarget (set by P_AimLineAttack / P_LineAttack) */
export function getLinetarget(gi: GameInstance): MapObjState | null {
  return gi.combat.linetarget;
}
export { MELEERANGE, MISSILERANGE };
