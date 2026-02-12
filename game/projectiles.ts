// ============================================================
// Projectile System — Rockets, Plasma, BFG
// Reference: p_mobj.c (P_SpawnMissile, P_MobjThinker for missiles)
// ============================================================

import {
  FRACBITS, FRACUNIT, ANGLETOFINESHIFT, FINEMASK,
  finesine, finecosine, fixedMul, fixedDiv, pointToAngle,
} from './math';
import { GameMap, ML_TWOSIDED } from '../src/map';
import {
  MapObjState, getMapObjects, damageMobj, isBarrel,
  MF_SHOOTABLE, MF_NOBLOOD,
} from './mobj';
import {
  P_AimLineAttack, P_RadiusAttack, getBulletSlope,
  lineIntersectFrac,
} from './combat';
import {
  spawnRocketExplosion, spawnPlasmaHit, spawnBfgHit,
  spawnPuff, spawnBlood,
} from './vfx';
import { spawnBarrelExplosion } from './vfx';
import { P_Random } from './random';
import { FX_DynLight } from './effects';
import { Player } from './player';
import { getWorld } from './world';

// ---- Projectile types ----
export enum ProjectileType {
  rocket,
  plasma,
  bfg,
  // Monster projectiles
  impFireball,    // BAL1 — Imp / Troop
  cacoFireball,   // BAL2 — Cacodemon / Head
  baronFireball,  // BAL7 — Baron of Hell / Hell Knight
  cyberdemonRocket, // same as rocket but from cyberdemon
}

// ---- Per-type configuration (from mobjinfo[] in info.c) ----
export interface ProjectileInfo {
  speed: number;        // fixed_t per tick
  damage: number;       // base damage (rolled: damage * (1 + rand%8))
  radius: number;       // fixed_t collision radius
  height: number;       // fixed_t collision height
  explosionRadius: number; // splash damage radius (0 = none)
  sprite: string;       // 4-char sprite name for in-flight
  deathSprite: string;  // sprite for explosion/hit
  numFrames: number;    // number of in-flight animation frames
  fullbright: boolean;  // render fullbright
}

const PROJECTILE_INFO: Record<ProjectileType, ProjectileInfo> = {
  [ProjectileType.rocket]: {
    speed: 20 * FRACUNIT,
    damage: 20,
    radius: 11 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 128,
    sprite: 'MISL',
    deathSprite: 'MISL',
    numFrames: 1,       // frame A only in flight
    fullbright: true,
  },
  [ProjectileType.plasma]: {
    speed: 25 * FRACUNIT,
    damage: 5,
    radius: 13 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 0,
    sprite: 'PLSS',
    deathSprite: 'PLSE',
    numFrames: 2,       // frames A/B alternate
    fullbright: true,
  },
  [ProjectileType.bfg]: {
    speed: 25 * FRACUNIT,
    damage: 100,
    radius: 13 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 0,  // BFG uses tracers, not radius
    sprite: 'BFS1',
    deathSprite: 'BFE1',
    numFrames: 2,       // frames A/B alternate
    fullbright: true,
  },
  // --- Monster projectiles ---
  [ProjectileType.impFireball]: {
    speed: 10 * FRACUNIT,
    damage: 3,
    radius: 6 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 0,
    sprite: 'BAL1',
    deathSprite: 'BAL1',
    numFrames: 2,
    fullbright: true,
  },
  [ProjectileType.cacoFireball]: {
    speed: 10 * FRACUNIT,
    damage: 5,
    radius: 6 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 0,
    sprite: 'BAL2',
    deathSprite: 'BAL2',
    numFrames: 2,
    fullbright: true,
  },
  [ProjectileType.baronFireball]: {
    speed: 15 * FRACUNIT,
    damage: 8,
    radius: 6 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 0,
    sprite: 'BAL7',
    deathSprite: 'BAL7',
    numFrames: 2,
    fullbright: true,
  },
  [ProjectileType.cyberdemonRocket]: {
    speed: 20 * FRACUNIT,
    damage: 20,
    radius: 11 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 128,
    sprite: 'MISL',
    deathSprite: 'MISL',
    numFrames: 1,
    fullbright: true,
  },
};

export function getProjectileInfo(type: ProjectileType): ProjectileInfo {
  return PROJECTILE_INFO[type];
}

// ---- Runtime projectile state ----
export interface Projectile {
  x: number;      // fixed_t
  y: number;      // fixed_t
  z: number;      // fixed_t
  momx: number;   // fixed_t per tick
  momy: number;   // fixed_t per tick
  momz: number;   // fixed_t per tick
  type: ProjectileType;
  info: ProjectileInfo;
  tic: number;    // age in tics (for animation)
  removed: boolean;
  source?: MapObjState; // who fired this (to prevent self-hit)
  isMonsterProjectile?: boolean; // true if fired by a monster (can hit player)
}

// ---- Module state ----
const activeProjectiles: Projectile[] = [];

const PLAYERRADIUS = 16; // map units

// ============================================================
// Spawn a player projectile
// Reference: P_SpawnMissile (p_mobj.c)
// ============================================================

export function spawnPlayerProjectile(
  px: number, py: number, pz: number,
  angle: number, aimSlope: number,
  type: ProjectileType
): void {
  const info = PROJECTILE_INFO[type];

  // Direction from player angle
  const an = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
  const momx = fixedMul(info.speed, finecosine(an));
  const momy = fixedMul(info.speed, finesine[an]);
  const momz = fixedMul(info.speed, aimSlope);

  // Spawn 4 units ahead of player and at gun height (32 units above floor)
  const spawnDist = 4 * FRACUNIT;
  const x = px + fixedMul(spawnDist, finecosine(an));
  const y = py + fixedMul(spawnDist, finesine[an]);
  const z = pz; // viewz is already at eye level; DOOM spawns at z=shooter.z+32

  const proj: Projectile = {
    x, y, z,
    momx, momy, momz,
    type,
    info,
    tic: 0,
    removed: false,
  };

  activeProjectiles.push(proj);

  // Muzzle flash dynamic light
  if (type === ProjectileType.rocket) {
    FX_DynLight(x, y, z, 96 * FRACUNIT, 255, 200, 80, 0.5, 3);
  } else if (type === ProjectileType.plasma) {
    FX_DynLight(x, y, z, 64 * FRACUNIT, 80, 80, 255, 0.4, 2);
  } else if (type === ProjectileType.bfg) {
    FX_DynLight(x, y, z, 128 * FRACUNIT, 80, 255, 80, 0.6, 4);
  }
}

// ============================================================
// Spawn a monster projectile
// Reference: P_SpawnMissile (p_mobj.c)
// ============================================================

export function spawnMonsterProjectile(
  source: MapObjState,
  target: MapObjState,
  type: ProjectileType
): void {
  const info = PROJECTILE_INFO[type];
  if (!info) return;

  // Direction from source to target
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const angle = pointToAngle(0, 0, dx, dy);
  const an = (angle >>> ANGLETOFINESHIFT) & FINEMASK;

  // Horizontal velocity
  const momx = fixedMul(info.speed, finecosine(an));
  const momy = fixedMul(info.speed, finesine[an]);

  // Vertical aim: aim at target midpoint from source midpoint
  const hdist = Math.sqrt(
    (dx / FRACUNIT) * (dx / FRACUNIT) + (dy / FRACUNIT) * (dy / FRACUNIT)
  );
  const dz = (target.z + (target.height >> 1)) - (source.z + 32 * FRACUNIT);
  const momz = hdist > 0
    ? Math.round((dz / FRACUNIT) / hdist * (info.speed / FRACUNIT)) * FRACUNIT
    : 0;

  // Spawn 4 units ahead, 32 units above feet
  const x = source.x + fixedMul(4 * FRACUNIT, finecosine(an));
  const y = source.y + fixedMul(4 * FRACUNIT, finesine[an]);
  const z = source.z + 32 * FRACUNIT;

  const proj: Projectile = {
    x, y, z,
    momx, momy, momz,
    type,
    info,
    tic: 0,
    removed: false,
    source,
    isMonsterProjectile: true,
  };

  activeProjectiles.push(proj);

  // Dynamic light for monster fireballs
  if (type === ProjectileType.impFireball) {
    FX_DynLight(x, y, z, 64 * FRACUNIT, 255, 128, 32, 0.5, 2);
  } else if (type === ProjectileType.cacoFireball) {
    FX_DynLight(x, y, z, 64 * FRACUNIT, 255, 64, 64, 0.5, 2);
  } else if (type === ProjectileType.baronFireball) {
    FX_DynLight(x, y, z, 80 * FRACUNIT, 64, 255, 64, 0.5, 2);
  } else if (type === ProjectileType.cyberdemonRocket) {
    FX_DynLight(x, y, z, 96 * FRACUNIT, 255, 200, 80, 0.5, 3);
  }
}

// ============================================================
// Update all projectiles (called once per game tic)
// Reference: P_MobjThinker for missiles (p_mobj.c)
// ============================================================

export function updateProjectiles(): void {
  const projectileMap = getWorld().map;
  if (!projectileMap) return;

  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    const proj = activeProjectiles[i];
    if (proj.removed) {
      activeProjectiles.splice(i, 1);
      continue;
    }

    proj.tic++;

    // Move projectile
    const newX = proj.x + proj.momx;
    const newY = proj.y + proj.momy;
    const newZ = proj.z + proj.momz;

    // --- Check wall collision ---
    if (checkWallCollision(proj, newX, newY, newZ)) {
      explodeProjectile(proj, proj.x, proj.y, proj.z);
      continue;
    }

    // --- Check thing collision ---
    if (checkThingCollision(proj, newX, newY, newZ)) {
      continue; // explode already called inside
    }

    // --- Check player collision (not own rocket at point-blank range) ---
    const projectilePlayer = getWorld().player;
    if (projectilePlayer && projectilePlayer.health > 0) {
      if (checkPlayerCollision(proj, newX, newY, newZ)) {
        continue; // explode already called inside
      }
    }

    // --- Check floor/ceiling collision ---
    const ss = projectileMap.pointInSubsector(newX, newY);
    if (ss.sector) {
      const floorZ = ss.sector.floorHeight;
      const ceilZ = ss.sector.ceilingHeight;
      if (newZ <= floorZ || newZ + proj.info.height >= ceilZ) {
        explodeProjectile(proj, newX, newY, newZ <= floorZ ? floorZ : ceilZ);
        continue;
      }
    }

    // Update position
    proj.x = newX;
    proj.y = newY;
    proj.z = newZ;

    // Flying dynamic light for rockets
    if (proj.type === ProjectileType.rocket) {
      FX_DynLight(proj.x, proj.y, proj.z, 160 * FRACUNIT, 255, 180, 60, 0.7, 2);
    } else if (proj.type === ProjectileType.plasma) {
      FX_DynLight(proj.x, proj.y, proj.z, 96 * FRACUNIT, 100, 100, 255, 0.55, 2);
    } else if (proj.type === ProjectileType.bfg) {
      FX_DynLight(proj.x, proj.y, proj.z, 192 * FRACUNIT, 100, 255, 100, 0.7, 2);
    } else if (proj.type === ProjectileType.impFireball) {
      FX_DynLight(proj.x, proj.y, proj.z, 80 * FRACUNIT, 255, 128, 32, 0.5, 2);
    } else if (proj.type === ProjectileType.cacoFireball) {
      FX_DynLight(proj.x, proj.y, proj.z, 80 * FRACUNIT, 255, 64, 64, 0.5, 2);
    } else if (proj.type === ProjectileType.baronFireball) {
      FX_DynLight(proj.x, proj.y, proj.z, 96 * FRACUNIT, 64, 255, 64, 0.5, 2);
    } else if (proj.type === ProjectileType.cyberdemonRocket) {
      FX_DynLight(proj.x, proj.y, proj.z, 160 * FRACUNIT, 255, 180, 60, 0.7, 2);
    }

    // Safety: remove after ~10 seconds (350 tics) to prevent leaks
    if (proj.tic > 350) {
      proj.removed = true;
    }
  }
}

// ============================================================
// Wall collision check
// Simplified version of traceWalls adapted for projectile movement
// ============================================================

function checkWallCollision(proj: Projectile, newX: number, newY: number, newZ: number): boolean {
  const projectileMap = getWorld().map;
  if (!projectileMap) return false;

  const dx = newX - proj.x;
  const dy = newY - proj.y;

  for (const line of projectileMap.linedefs) {
    const v1 = projectileMap.vertices[line.v1];
    const v2 = projectileMap.vertices[line.v2];
    const lx1 = v1.x;
    const ly1 = v1.y;
    const ldx = v2.x - v1.x;
    const ldy = v2.y - v1.y;

    const frac = lineIntersectFrac(proj.x, proj.y, dx, dy, lx1, ly1, ldx, ldy);
    if (frac < 0 || frac > FRACUNIT) continue;

    // One-sided line → always blocks
    if (!(line.flags & ML_TWOSIDED)) {
      return true;
    }

    // Two-sided — check if the projectile passes through the opening
    const front = line.frontsector;
    const back = line.backsector;
    if (!front || !back) {
      return true;
    }

    const opentop = Math.min(front.ceilingHeight, back.ceilingHeight);
    const openbottom = Math.max(front.floorHeight, back.floorHeight);

    if (openbottom >= opentop) {
      return true; // closed
    }

    // Check if projectile z passes through the opening
    const hitZ = proj.z + fixedMul(proj.momz, frac);
    if (hitZ < openbottom || hitZ + proj.info.height > opentop) {
      return true;
    }
    // Otherwise passes through
  }

  return false;
}

// ============================================================
// Thing collision check (cylindrical)
// Reference: PIT_CheckThing (p_map.c)
// ============================================================

function checkThingCollision(proj: Projectile, newX: number, newY: number, newZ: number): boolean {
  const mapObjs = getMapObjects();

  for (const obj of mapObjs) {
    if (obj.removed) continue;
    if (!(obj.flags & MF_SHOOTABLE)) continue;

    // Cylindrical collision: XY distance < sum of radii
    const blockDist = obj.radius + proj.info.radius;
    const dx = Math.abs(newX - obj.x);
    const dy = Math.abs(newY - obj.y);

    if (dx >= blockDist || dy >= blockDist) continue;

    // Don't hit the source (self-hit prevention)
    if (proj.source && obj === proj.source) continue;

    // Z overlap check
    if (newZ > obj.z + obj.height) continue; // projectile above thing
    if (newZ + proj.info.height < obj.z) continue; // projectile below thing

    // Hit! Apply damage
    const damage = proj.info.damage * ((P_Random() % 8) + 1);
    const killed = damageMobj(obj, damage, proj.source);

    // Spawn hit effect
    if (obj.flags & MF_NOBLOOD) {
      spawnPuff(newX, newY, newZ, false);
    } else {
      spawnBlood(newX, newY, newZ, damage);
    }

    // Barrel chain explosion
    if (killed && isBarrel(obj.type)) {
      spawnBarrelExplosion(obj.x, obj.y, obj.z, () => {
        P_RadiusAttack(obj.x, obj.y, obj.z, 128);
      });
    }

    // Explode for rockets (splash damage)
    explodeProjectile(proj, newX, newY, newZ);
    return true;
  }

  return false;
}

// ============================================================
// Player collision check
// Projectiles from the player don't directly hit the player,
// but rockets do splash damage via P_RadiusAttack
// ============================================================

function checkPlayerCollision(
  proj: Projectile,
  newX: number, newY: number, newZ: number
): boolean {
  // Only monster projectiles can hit the player
  if (!proj.isMonsterProjectile) return false;
  const projectilePlayer = getWorld().player;
  if (!projectilePlayer || projectilePlayer.health <= 0) return false;

  const pdist = proj.info.radius + (PLAYERRADIUS * FRACUNIT);
  const dx = Math.abs(newX - projectilePlayer.x);
  const dy = Math.abs(newY - projectilePlayer.y);
  if (dx >= pdist || dy >= pdist) return false;

  // Z overlap
  const pz = projectilePlayer.z;
  const pHeight = 56 * FRACUNIT;
  if (newZ > pz + pHeight) return false;
  if (newZ + proj.info.height < pz) return false;

  // Hit! Apply damage
  const damage = proj.info.damage * ((P_Random() % 8) + 1);
  projectilePlayer.takeDamage(damage);

  // Spawn blood
  spawnBlood(newX, newY, newZ + (pHeight >> 1), damage);

  // Explode
  explodeProjectile(proj, newX, newY, newZ);
  return true;
}

// ============================================================
// Explode a projectile
// ============================================================

function explodeProjectile(proj: Projectile, hitX: number, hitY: number, hitZ: number): void {
  proj.removed = true;

  switch (proj.type) {
    case ProjectileType.rocket:
      spawnRocketExplosion(hitX, hitY, hitZ);
      // Splash damage — damages everything in radius including player
      P_RadiusAttack(hitX, hitY, hitZ, proj.info.explosionRadius);
      // Explosion light
      FX_DynLight(hitX, hitY, hitZ, 192 * FRACUNIT, 255, 160, 48, 0.6, 10);
      break;

    case ProjectileType.plasma:
      spawnPlasmaHit(hitX, hitY, hitZ);
      FX_DynLight(hitX, hitY, hitZ, 96 * FRACUNIT, 80, 80, 255, 0.4, 5);
      break;

    case ProjectileType.bfg:
      spawnBfgHit(hitX, hitY, hitZ);
      // BFG tracers: after explosion, fire 40 invisible autoaim rays
      // (simplified: just deal massive damage to things in LOS)
      fireBfgTracers(hitX, hitY, hitZ);
      FX_DynLight(hitX, hitY, hitZ, 256 * FRACUNIT, 80, 255, 80, 0.8, 15);
      break;
  }
}

// ============================================================
// BFG Tracers — simplified version
// Original fires 40 rays in a ±45° cone from the player
// ============================================================

function fireBfgTracers(hitX: number, hitY: number, hitZ: number): void {
  // Simplified: damage all shootable things within 512 units that are visible
  const mapObjs = getMapObjects();
  const range = 512 * FRACUNIT;

  for (const obj of mapObjs) {
    if (obj.removed) continue;
    if (!(obj.flags & MF_SHOOTABLE)) continue;

    const dx = Math.abs(obj.x - hitX);
    const dy = Math.abs(obj.y - hitY);
    const dist = Math.max(dx, dy);

    if (dist > range) continue;

    // BFG tracer damage: 15 * (1 + rand%8) per tracer, simplified
    const damage = 15 * ((P_Random() % 8) + 1);
    damageMobj(obj, damage);

    // Green flash on target
    FX_DynLight(obj.x, obj.y, obj.z + (obj.height >> 1), 64 * FRACUNIT, 80, 255, 80, 0.3, 3);
  }
}

// ============================================================
// Accessors
// ============================================================

/** Get all active projectiles (for renderer) */
export function getActiveProjectiles(): ReadonlyArray<Projectile> {
  return activeProjectiles;
}

/** Clear all projectiles (on level change) */
export function clearProjectiles(): void {
  activeProjectiles.length = 0;
}

/** Get the current animation frame for a projectile */
export function getProjectileSprite(proj: Projectile): { sprite: string; frame: number } {
  return {
    sprite: proj.info.sprite,
    frame: proj.tic % proj.info.numFrames,
  };
}
