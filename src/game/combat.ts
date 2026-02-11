// ============================================================
// Combat System — Hitscan, Damage, Explosions
// Reference: p_map.c (P_AimLineAttack, P_LineAttack, PTR_ShootTraverse)
//            p_pspr.c (P_BulletSlope, P_GunShot)
//            p_inter.c (P_DamageMobj, P_RadiusAttack)
// ============================================================

import {
  FRACBITS, FRACUNIT, ANGLETOFINESHIFT, FINEMASK,
  finesine, finecosine, fixedMul, fixedDiv, pointToAngle,
} from '../math';
import { GameMap, ML_TWOSIDED } from '../map';
import { addDynLight } from '../render/dynlights';
import { P_Random } from './random';
import {
  MapObjState, getMapObjects, damageMobj, isBarrel,
  MF_SHOOTABLE, MF_NOBLOOD,
} from './mobj';
import { spawnPuff, spawnBlood, spawnBarrelExplosion } from './vfx';
import { Player } from './player';

// ---- Constants (from p_local.h) ----
const MELEERANGE    = 64 * FRACUNIT;
const MISSILERANGE  = 32 * 64 * FRACUNIT;  // 2048 map units
const PLAYERRADIUS = 16;  // player collision radius in map units

// Module-level player reference for splash damage
let combatPlayer: Player | null = null;

/** Set the player reference for combat splash damage */
export function setCombatPlayer(p: Player): void {
  combatPlayer = p;
}

// ---- Module state (mirrors DOOM's globals in p_map.c) ----
let linetarget: MapObjState | null = null;
let aimslope = 0;
let currentMap: GameMap | null = null;

/** Set the map reference for combat operations */
export function setCombatMap(map: GameMap): void {
  currentMap = map;
}

// ============================================================
// Line–wall intersection test
// Returns the fraction (0..1 in fixed-point) along the ray
// where it hits the linedef, or -1 if no hit.
// ============================================================

function lineIntersectFrac(
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

function traceWalls(
  x1: number, y1: number,
  dx: number, dy: number,
  slope: number,
  shootz: number,
): number {
  if (!currentMap) return FRACUNIT;

  let bestFrac = FRACUNIT;

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
      continue;
    }

    // Two-sided — check if the shot passes through the opening
    const front = line.frontsector;
    const back = line.backsector;
    if (!front || !back) {
      bestFrac = frac;
      continue;
    }

    const opentop = Math.min(front.ceilingHeight, back.ceilingHeight);
    const openbottom = Math.max(front.floorHeight, back.floorHeight);

    if (openbottom >= opentop) {
      // Closed — blocks
      bestFrac = frac;
      continue;
    }

    // Check if the shot z at this point passes through the opening
    const dist = frac; // frac is 0..FRACUNIT
    const hitZ = shootz + fixedMul(slope, dist);

    if (hitZ < openbottom || hitZ > opentop) {
      bestFrac = frac;
    }
    // Otherwise shot passes through
  }

  return bestFrac;
}

// ============================================================
// P_AimLineAttack — autoaim
// Finds the closest shootable thing along the ray and returns
// the slope to aim at it. Sets linetarget.
// ============================================================

export function P_AimLineAttack(
  shooterX: number, shooterY: number, shooterZ: number,
  angle: number,
  range: number
): number {
  linetarget = null;
  aimslope = 0;

  const an = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
  const dx = fixedMul(range, finecosine(an));
  const dy = fixedMul(range, finesine[an]);
  const shootz = shooterZ + (8 * FRACUNIT);  // eye height offset

  // Top/bottom slope limits (from p_map.c: 100*FRACUNIT/160)
  const topLimit = ((100 * FRACUNIT) / 160) | 0;
  const bottomLimit = ((-100 * FRACUNIT) / 160) | 0;

  // Get the wall-block fraction
  const wallFrac = traceWalls(shooterX, shooterY, dx, dy, 0, shootz);

  // Check things
  let bestDist = range + 1;
  let bestTarget: MapObjState | null = null;
  let bestSlope = 0;

  const mapObjs = getMapObjects();
  for (const obj of mapObjs) {
    if (obj.removed) continue;
    if (!(obj.flags & MF_SHOOTABLE)) continue;

    // Quick distance check
    const tdx = obj.x - shooterX;
    const tdy = obj.y - shooterY;

    // Project onto ray direction to get distance along ray
    const dot = fixedMul(tdx, finecosine(an)) + fixedMul(tdy, finesine[an]);
    if (dot <= 0 || dot > range) continue;

    // Check perpendicular distance (how far off the ray)
    const perp = Math.abs(fixedMul(tdx, finesine[an]) - fixedMul(tdy, finecosine(an)));
    // Must be within thing radius
    if (perp > obj.radius) continue;

    // Check it's not behind a wall
    const thingFrac = fixedDiv(dot, range);
    if (thingFrac >= wallFrac) continue;

    // Check vertical slope to thing top and bottom
    const dist = dot;
    const thingTopSlope = fixedDiv(obj.z + obj.height - shootz, dist);
    const thingBottomSlope = fixedDiv(obj.z - shootz, dist);

    // Must be within aim limits
    if (thingTopSlope < bottomLimit) continue;  // thing is too low
    if (thingBottomSlope > topLimit) continue;   // thing is too high

    // This thing can be hit! Is it the closest?
    if (dist < bestDist) {
      bestDist = dist;
      bestTarget = obj;
      // Aim at the center of the thing
      bestSlope = ((thingTopSlope + thingBottomSlope) / 2) | 0;
    }
  }

  if (bestTarget) {
    linetarget = bestTarget;
    aimslope = bestSlope;
    return aimslope;
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
  damage: number
): void {
  const an = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
  const dx = fixedMul(range, finecosine(an));
  const dy = fixedMul(range, finesine[an]);
  const shootz = shooterZ + (8 * FRACUNIT);

  // Get wall block distance
  const wallFrac = traceWalls(shooterX, shooterY, dx, dy, slope, shootz);

  // Check thing hits (find closest within wall block distance)
  let bestFrac = wallFrac;
  let hitTarget: MapObjState | null = null;

  const mapObjs = getMapObjects();
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
    linetarget = hitTarget;
    console.log(`[combat] Hit type=${hitTarget.type} health=${hitTarget.health} damage=${damage}`);
    const killed = damageMobj(hitTarget, damage);
    console.log(`[combat] killed=${killed} isBarrel=${isBarrel(hitTarget.type)} health_after=${hitTarget.health}`);

    // Spawn blood/puff at hit location
    const hitX = shooterX + fixedMul(bestFrac, dx);
    const hitY = shooterY + fixedMul(bestFrac, dy);
    const hitZ = shootz + fixedMul(slope, fixedMul(bestFrac, range));

    if (hitTarget.flags & MF_NOBLOOD) {
      spawnPuff(hitX, hitY, hitZ, false);
    } else {
      spawnBlood(hitX, hitY, hitZ, damage);
    }

    // If it was a barrel and it died, trigger explosion animation
    if (killed && isBarrel(hitTarget.type)) {
      console.log(`[combat] Spawning barrel explosion VFX`);
      spawnBarrelExplosion(hitTarget.x, hitTarget.y, hitTarget.z, () => {
        P_RadiusAttack(hitTarget.x, hitTarget.y, hitTarget.z, 128);
      });
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
    spawnPuff(hitX, hitY, hitZ, isMelee);
  }
}

// ============================================================
// P_BulletSlope — autoaim for hitscan weapons
// Three-pass autoaim: center, +5°, -5°
// (from p_pspr.c)
// ============================================================

let bulletslope = 0;

export function P_BulletSlope(
  x: number, y: number, z: number, angle: number
): void {
  // Try center first
  bulletslope = P_AimLineAttack(x, y, z, angle, 16 * 64 * FRACUNIT);

  if (!linetarget) {
    // Try +5 degrees (1<<26 ≈ 5.625°)
    const an1 = (angle + (1 << 26)) >>> 0;
    bulletslope = P_AimLineAttack(x, y, z, an1, 16 * 64 * FRACUNIT);

    if (!linetarget) {
      // Try -5 degrees
      const an2 = (angle - (2 << 26)) >>> 0;
      bulletslope = P_AimLineAttack(x, y, z, an2, 16 * 64 * FRACUNIT);
    }
  }
}

/** Get current bulletslope value */
export function getBulletSlope(): number {
  return bulletslope;
}

// ============================================================
// P_GunShot — fire a single bullet
// (from p_pspr.c)
// ============================================================

export function P_GunShot(
  x: number, y: number, z: number,
  angle: number,
  accurate: boolean
): void {
  const damage = 5 * ((P_Random() % 3) + 1);
  let shotAngle = angle;

  if (!accurate) {
    shotAngle = (shotAngle + ((P_Random() - P_Random()) << 18)) >>> 0;
  }

  P_LineAttack(x, y, z, shotAngle, MISSILERANGE, bulletslope, damage);

  // Muzzle flash dynamic light (yellow-white, short)
  addDynLight(x, y, z, 96 * FRACUNIT, 255, 224, 128, 0.5, 3);
}

// ============================================================
// P_RadiusAttack — splash damage
// Damages all shootable things within `damage` units
// (from p_map.c)
// ============================================================

export function P_RadiusAttack(
  spotX: number, spotY: number, spotZ: number,
  damage: number
): void {
  // Explosion dynamic light (orange, moderate)
  addDynLight(spotX, spotY, spotZ, 192 * FRACUNIT, 255, 160, 48, 0.6, 10);

  const mapObjs = getMapObjects();

  for (const obj of mapObjs) {
    if (obj.removed) continue;
    if (!(obj.flags & MF_SHOOTABLE)) continue;

    const dx = Math.abs(obj.x - spotX) >> FRACBITS;
    const dy = Math.abs(obj.y - spotY) >> FRACBITS;
    const dist = Math.max(dx, dy) - (obj.radius >> FRACBITS);
    const finalDist = Math.max(0, dist);

    if (finalDist >= damage) continue; // out of range

    const appliedDamage = damage - finalDist;
    const killed = damageMobj(obj, appliedDamage);

    // Chain barrel explosions with VFX
    if (killed && isBarrel(obj.type)) {
      spawnBarrelExplosion(obj.x, obj.y, obj.z, () => {
        P_RadiusAttack(obj.x, obj.y, obj.z, 128);
      });
    }
  }

  // Also damage the player (original DOOM iterates ALL things including player)
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
export { MELEERANGE, MISSILERANGE, linetarget };
