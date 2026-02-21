// ============================================================
// Projectile System — Rockets, Plasma, BFG
// Reference: p_mobj.c (P_SpawnMissile, P_MobjThinker for missiles)
// ============================================================

import {
  FRACBITS, FRACUNIT, ANGLETOFINESHIFT, FINEMASK, ANG180,
  finesine, finecosine, fixedMul, fixedDiv, pointToAngle,
} from './math';
import { ML_TWOSIDED, type GameMap } from './map-types';
import {
  MapObjState, getMapObjects, damageMobj, isBarrel,
  MF_SHOOTABLE, MF_NOBLOOD,
} from './mobj';
import {
  P_AimLineAttack, P_RadiusAttack, getBulletSlope,
  lineIntersectFrac, getLinetarget,
} from './combat';
import {
  spawnRocketExplosion, spawnPlasmaHit, spawnBfgHit,
  spawnPuff, spawnBlood,
} from './vfx';
import { spawnBarrelExplosion } from './vfx';
import { P_Random } from './random';
import { FX_DynLight } from './effects';
import { Player } from './player';
import { GameInstance } from './game-instance';

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
  // Doom II monster projectiles
  revenantTracer,   // FATB — Revenant homing missile
  mancubusFireball, // MANF — Mancubus fat shot
  arachnotronPlasma, // APLS — Arachnotron plasma bolt
}

// ---- Per-type configuration (from mobjinfo[] in info.c) ----
// Dynamic light descriptor (radius in map units, RGB 0-255, intensity 0-1, duration in tics)
interface DynLightDef {
  radius: number;   // map units (will be multiplied by FRACUNIT)
  r: number;
  g: number;
  b: number;
  intensity: number;
  duration: number;
}

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
  // Dynamic lights (null = no light for that phase)
  spawnLight: DynLightDef | null;     // muzzle flash when spawned
  flyLight: DynLightDef | null;       // per-tic glow while in flight
  explodeLight: DynLightDef | null;   // flash on impact/explosion
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
    numFrames: 1,
    fullbright: true,
    spawnLight: { radius: 96, r: 255, g: 200, b: 80, intensity: 0.5, duration: 3 },
    flyLight: { radius: 160, r: 255, g: 180, b: 60, intensity: 0.7, duration: 2 },
    explodeLight: { radius: 192, r: 255, g: 160, b: 48, intensity: 0.6, duration: 10 },
  },
  [ProjectileType.plasma]: {
    speed: 25 * FRACUNIT,
    damage: 5,
    radius: 13 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 0,
    sprite: 'PLSS',
    deathSprite: 'PLSE',
    numFrames: 2,
    fullbright: true,
    spawnLight: { radius: 64, r: 80, g: 80, b: 255, intensity: 0.4, duration: 2 },
    flyLight: { radius: 96, r: 100, g: 100, b: 255, intensity: 0.55, duration: 2 },
    explodeLight: { radius: 96, r: 80, g: 80, b: 255, intensity: 0.4, duration: 5 },
  },
  [ProjectileType.bfg]: {
    speed: 25 * FRACUNIT,
    damage: 100,
    radius: 13 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 0,  // BFG uses tracers, not radius
    sprite: 'BFS1',
    deathSprite: 'BFE1',
    numFrames: 2,
    fullbright: true,
    spawnLight: { radius: 128, r: 80, g: 255, b: 80, intensity: 0.6, duration: 4 },
    flyLight: { radius: 192, r: 100, g: 255, b: 100, intensity: 0.7, duration: 2 },
    explodeLight: { radius: 256, r: 80, g: 255, b: 80, intensity: 0.8, duration: 15 },
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
    spawnLight: { radius: 64, r: 255, g: 128, b: 32, intensity: 0.5, duration: 2 },
    flyLight: { radius: 80, r: 255, g: 128, b: 32, intensity: 0.5, duration: 2 },
    explodeLight: null,
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
    spawnLight: { radius: 64, r: 255, g: 64, b: 64, intensity: 0.5, duration: 2 },
    flyLight: { radius: 80, r: 255, g: 64, b: 64, intensity: 0.5, duration: 2 },
    explodeLight: null,
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
    spawnLight: { radius: 80, r: 64, g: 255, b: 64, intensity: 0.5, duration: 2 },
    flyLight: { radius: 96, r: 64, g: 255, b: 64, intensity: 0.5, duration: 2 },
    explodeLight: null,
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
    spawnLight: { radius: 96, r: 255, g: 200, b: 80, intensity: 0.5, duration: 3 },
    flyLight: { radius: 160, r: 255, g: 180, b: 60, intensity: 0.7, duration: 2 },
    explodeLight: { radius: 192, r: 255, g: 160, b: 48, intensity: 0.6, duration: 10 },
  },
  // --- Doom II monster projectiles ---
  [ProjectileType.revenantTracer]: {
    speed: 10 * FRACUNIT,
    damage: 10,
    radius: 11 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 0,
    sprite: 'FATB',
    deathSprite: 'FBXP',
    numFrames: 2,
    fullbright: true,
    spawnLight: { radius: 64, r: 255, g: 160, b: 64, intensity: 0.4, duration: 2 },
    flyLight: { radius: 80, r: 255, g: 160, b: 64, intensity: 0.5, duration: 2 },
    explodeLight: null,
  },
  [ProjectileType.mancubusFireball]: {
    speed: 20 * FRACUNIT,
    damage: 8,
    radius: 6 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 0,
    sprite: 'MANF',
    deathSprite: 'MISL',
    numFrames: 2,
    fullbright: true,
    spawnLight: { radius: 64, r: 255, g: 128, b: 32, intensity: 0.5, duration: 2 },
    flyLight: { radius: 96, r: 255, g: 128, b: 32, intensity: 0.6, duration: 2 },
    explodeLight: { radius: 128, r: 255, g: 128, b: 32, intensity: 0.5, duration: 6 },
  },
  [ProjectileType.arachnotronPlasma]: {
    speed: 25 * FRACUNIT,
    damage: 5,
    radius: 13 * FRACUNIT,
    height: 8 * FRACUNIT,
    explosionRadius: 0,
    sprite: 'APLS',
    deathSprite: 'APBX',
    numFrames: 2,
    fullbright: true,
    spawnLight: { radius: 64, r: 80, g: 255, b: 80, intensity: 0.4, duration: 2 },
    flyLight: { radius: 80, r: 80, g: 255, b: 80, intensity: 0.5, duration: 2 },
    explodeLight: { radius: 80, r: 80, g: 255, b: 80, intensity: 0.4, duration: 4 },
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
  sourceAngle?: number; // shooter angle at time of firing (BAM, for BFG tracers)
  tracerTarget?: MapObjState; // homing target (Revenant tracer)
}

// ---- Module state (delegated to GameInstance) ----

const PLAYERRADIUS = 16; // map units

// ============================================================
// Spawn a player projectile
// Reference: P_SpawnMissile (p_mobj.c)
// ============================================================

export function spawnPlayerProjectile(
  px: number, py: number, pz: number,
  angle: number, aimSlope: number,
  type: ProjectileType,
  gi: GameInstance,
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
    sourceAngle: angle,
  };

  gi.activeProjectiles.push(proj);

  // Muzzle flash dynamic light (table-driven)
  const sl = info.spawnLight;
  if (sl) {
    FX_DynLight(x, y, z, sl.radius * FRACUNIT, sl.r, sl.g, sl.b, sl.intensity, sl.duration);
  }
}

// ============================================================
// Spawn a monster projectile
// Reference: P_SpawnMissile (p_mobj.c)
// ============================================================

export function spawnMonsterProjectile(
  source: MapObjState,
  target: MapObjState,
  type: ProjectileType,
  gi: GameInstance,
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

  gi.activeProjectiles.push(proj);

  // Set tracer target for homing missiles (Revenant)
  if (type === ProjectileType.revenantTracer) {
    proj.tracerTarget = target;
  }

  // Spawn dynamic light (table-driven)
  const msl = info.spawnLight;
  if (msl) {
    FX_DynLight(x, y, z, msl.radius * FRACUNIT, msl.r, msl.g, msl.b, msl.intensity, msl.duration);
  }
}

/**
 * Spawn a monster projectile with an angular offset (BAM).
 * Used by Mancubus for spread-fire patterns.
 */
export function spawnMonsterProjectileAngled(
  source: MapObjState,
  target: MapObjState,
  type: ProjectileType,
  angleOffset: number,
  gi: GameInstance,
): void {
  const info = PROJECTILE_INFO[type];
  if (!info) return;

  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const baseAngle = pointToAngle(0, 0, dx, dy);
  const angle = (baseAngle + angleOffset) >>> 0;
  const an = (angle >>> ANGLETOFINESHIFT) & FINEMASK;

  const momx = fixedMul(info.speed, finecosine(an));
  const momy = fixedMul(info.speed, finesine[an]);

  const hdist = Math.max(1, Math.sqrt(
    (dx / FRACUNIT) * (dx / FRACUNIT) + (dy / FRACUNIT) * (dy / FRACUNIT)
  ));
  const dz = (target.z + (target.height >> 1)) - (source.z + 32 * FRACUNIT);
  const momz = Math.round((dz / FRACUNIT) / hdist * (info.speed / FRACUNIT)) * FRACUNIT;

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

  gi.activeProjectiles.push(proj);

  const msl = info.spawnLight;
  if (msl) {
    FX_DynLight(x, y, z, msl.radius * FRACUNIT, msl.r, msl.g, msl.b, msl.intensity, msl.duration);
  }
}

// ============================================================
// Update all projectiles (called once per game tic)
// Reference: P_MobjThinker for missiles (p_mobj.c)
// ============================================================

export function updateProjectiles(gi: GameInstance): void {
  const projectileMap = gi.world?.map;
  if (!projectileMap) return;

  const activeProjectiles = gi.activeProjectiles;
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
    if (checkWallCollision(proj, newX, newY, newZ, gi)) {
      explodeProjectile(proj, proj.x, proj.y, proj.z, gi);
      continue;
    }

    // --- Check thing collision ---
    if (checkThingCollision(proj, newX, newY, newZ, gi)) {
      continue; // explode already called inside
    }

    // --- Check player collision (not own rocket at point-blank range) ---
    const projectilePlayer = gi.world?.player;
    if (projectilePlayer && projectilePlayer.health > 0) {
      if (checkPlayerCollision(proj, newX, newY, newZ, gi)) {
        continue; // explode already called inside
      }
    }

    // --- Check floor/ceiling collision ---
    const ss = projectileMap.pointInSubsector(newX, newY);
    if (ss.sector) {
      const floorZ = ss.sector.floorHeight;
      const ceilZ = ss.sector.ceilingHeight;
      if (newZ <= floorZ || newZ + proj.info.height >= ceilZ) {
        explodeProjectile(proj, newX, newY, newZ <= floorZ ? floorZ : ceilZ, gi);
        continue;
      }
    }

    // Update position
    proj.x = newX;
    proj.y = newY;
    proj.z = newZ;

    // ---- A_Tracer: Revenant homing missile logic ----
    // Reference: p_enemy.c A_Tracer — homes every other tic
    if (proj.type === ProjectileType.revenantTracer && (proj.tic & 1)) {
      tracerHome(proj, gi);
    }

    // Flying dynamic light (table-driven)
    const fl = proj.info.flyLight;
    if (fl) {
      FX_DynLight(proj.x, proj.y, proj.z, fl.radius * FRACUNIT, fl.r, fl.g, fl.b, fl.intensity, fl.duration);
    }

    // Safety: remove after ~10 seconds (350 tics) to prevent leaks
    if (proj.tic > 350) {
      proj.removed = true;
    }
  }
}

// ============================================================
// Wall collision check (blockmap-accelerated)
// Reference: P_BlockLinesIterator + PIT_CheckLine (p_map.c)
// ============================================================

function checkWallCollision(proj: Projectile, newX: number, newY: number, newZ: number, gi: GameInstance): boolean {
  const projectileMap = gi.world?.map;
  if (!projectileMap) return false;

  const dx = newX - proj.x;
  const dy = newY - proj.y;

  // Build bounding box from old → new position, expanded by projectile radius
  const r = proj.info.radius;
  const top = Math.max(proj.y, newY) + r;
  const bottom = Math.min(proj.y, newY) - r;
  const left = Math.min(proj.x, newX) - r;
  const right = Math.max(proj.x, newX) + r;

  let blocked = false;

  projectileMap.forEachBlockLine(top, bottom, left, right, (line) => {
    const v1 = projectileMap.vertices[line.v1];
    const v2 = projectileMap.vertices[line.v2];
    const lx1 = v1.x;
    const ly1 = v1.y;
    const ldx = v2.x - v1.x;
    const ldy = v2.y - v1.y;

    const frac = lineIntersectFrac(proj.x, proj.y, dx, dy, lx1, ly1, ldx, ldy);
    if (frac < 0 || frac > FRACUNIT) return true; // no intersection, continue

    // One-sided line → always blocks
    if (!(line.flags & ML_TWOSIDED)) {
      blocked = true;
      return false; // stop iteration
    }

    // Two-sided — check if the projectile passes through the opening
    const front = line.frontsector;
    const back = line.backsector;
    if (!front || !back) {
      blocked = true;
      return false;
    }

    const opentop = Math.min(front.ceilingHeight, back.ceilingHeight);
    const openbottom = Math.max(front.floorHeight, back.floorHeight);

    if (openbottom >= opentop) {
      blocked = true;
      return false; // closed
    }

    // Check if projectile z passes through the opening
    const hitZ = proj.z + fixedMul(proj.momz, frac);
    if (hitZ < openbottom || hitZ + proj.info.height > opentop) {
      blocked = true;
      return false;
    }
    // Otherwise passes through
    return true;
  }, gi);

  return blocked;
}

// ============================================================
// Thing collision check (cylindrical)
// Reference: PIT_CheckThing (p_map.c)
// ============================================================

function checkThingCollision(proj: Projectile, newX: number, newY: number, newZ: number, gi: GameInstance): boolean {
  const mapObjs = getMapObjects(gi);

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
    const damage = proj.info.damage * ((P_Random(gi) % 8) + 1);
    const killed = damageMobj(obj, damage, proj.source, gi);

    // Spawn hit effect
    if (obj.flags & MF_NOBLOOD) {
      spawnPuff(newX, newY, newZ, false, gi);
    } else {
      spawnBlood(newX, newY, newZ, damage, gi);
    }

    // Barrel chain explosion
    if (killed && isBarrel(obj.type)) {
      spawnBarrelExplosion(obj.x, obj.y, obj.z, () => {
        P_RadiusAttack(obj.x, obj.y, obj.z, 128, gi);
      }, gi);
    }

    // Explode for rockets (splash damage)
    explodeProjectile(proj, newX, newY, newZ, gi);
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
  newX: number, newY: number, newZ: number,
  gi: GameInstance,
): boolean {
  // Only monster projectiles can hit the player
  if (!proj.isMonsterProjectile) return false;
  const projectilePlayer = gi.world?.player;
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
  const damage = proj.info.damage * ((P_Random(gi) % 8) + 1);
  projectilePlayer.takeDamage(damage);

  // Spawn blood
  spawnBlood(newX, newY, newZ + (pHeight >> 1), damage, gi);

  // Explode
  explodeProjectile(proj, newX, newY, newZ, gi);
  return true;
}

// ============================================================
// Explode a projectile
// ============================================================

function explodeProjectile(proj: Projectile, hitX: number, hitY: number, hitZ: number, gi: GameInstance): void {
  proj.removed = true;

  // Spawn visual explosion effect
  switch (proj.type) {
    case ProjectileType.rocket:
    case ProjectileType.cyberdemonRocket:
      spawnRocketExplosion(hitX, hitY, hitZ, gi);
      P_RadiusAttack(hitX, hitY, hitZ, proj.info.explosionRadius, gi);
      break;
    case ProjectileType.plasma:
      spawnPlasmaHit(hitX, hitY, hitZ, gi);
      break;
    case ProjectileType.bfg:
      spawnBfgHit(hitX, hitY, hitZ, gi);
      fireBfgTracers(hitX, hitY, hitZ, proj, gi);
      break;
  }

  // Explosion dynamic light (table-driven)
  const el = proj.info.explodeLight;
  if (el) {
    FX_DynLight(hitX, hitY, hitZ, el.radius * FRACUNIT, el.r, el.g, el.b, el.intensity, el.duration);
  }
}

// ============================================================
// BFG Tracers — faithful port of A_BFGSpray from p_enemy.c
// Fires 40 rays in a ±45° cone from the shooter's angle.
// Each ray uses P_AimLineAttack for autoaim + line-of-sight.
// Damage per hit: 15 * (1..8) = 15-120.
// ============================================================

function fireBfgTracers(hitX: number, hitY: number, hitZ: number, proj: Projectile, gi: GameInstance): void {
  const ANG90 = 0x40000000;
  const ANG45 = ANG90 >>> 1;
  const AIMRANGE = 16 * 64 * FRACUNIT; // 1024 map units
  const sourceAngle = proj.sourceAngle ?? 0;

  for (let i = 0; i < 40; i++) {
    // Distribute 40 rays evenly across ±45° cone
    const an = (sourceAngle - ANG45 + Math.round((ANG90 / 40) * i)) >>> 0;

    // P_AimLineAttack sets linetarget if a shootable thing is in LOS
    P_AimLineAttack(hitX, hitY, hitZ, an, AIMRANGE, gi);
    const target = getLinetarget(gi);
    if (!target) continue;

    // BFG tracer damage: 15 * (1..8)
    const damage = 15 * ((P_Random(gi) % 8) + 1);
    damageMobj(target, damage, proj.source, gi);

    // Spawn green flash on target (BFE2 sprite in original DOOM)
    spawnBfgHit(target.x, target.y, target.z + (target.height >> 1), gi);
  }
}

// ============================================================
// A_Tracer — Revenant homing missile logic
// Reference: p_enemy.c A_Tracer
// Adjusts projectile angle/momz toward tracerTarget each call.
// TRACEANGLE = ANG90/2/4 = 0x0C000000 ≈ 5.625°/tic
// ============================================================

const TRACEANGLE = 0x0C000000; // ~5.625° in BAM

function tracerHome(proj: Projectile, gi: GameInstance): void {
  const target = proj.tracerTarget;
  if (!target) return;

  // Stop homing if target is dead
  if (target.health <= 0) {
    proj.tracerTarget = undefined;
    return;
  }

  // Also home toward live player if tracerTarget is the player shim
  const playerRef = gi.world?.player;
  const tx = (playerRef && target.thingIndex === -1) ? playerRef.x : target.x;
  const ty = (playerRef && target.thingIndex === -1) ? playerRef.y : target.y;
  const tz = (playerRef && target.thingIndex === -1) ? playerRef.z : target.z;
  const tHeight = (playerRef && target.thingIndex === -1) ? 56 * FRACUNIT : target.height;

  // Calculate exact angle to target
  const exact = pointToAngle(proj.x, proj.y, tx, ty);

  // Current movement angle
  const projAngle = pointToAngle(0, 0, proj.momx, proj.momy);

  // Determine which way to turn (signed difference in BAM)
  const diff = ((exact - projAngle) | 0);

  let newAngle: number;
  if (diff > 0) {
    // Turn left (counter-clockwise)
    if ((diff >>> 0) > (ANG180 >>> 0)) {
      // Actually more than 180° — turn right instead
      newAngle = (projAngle - TRACEANGLE) >>> 0;
    } else {
      newAngle = (projAngle + TRACEANGLE) >>> 0;
    }
  } else {
    // Turn right (clockwise)
    if (((-diff) >>> 0) > (ANG180 >>> 0)) {
      // Actually more than 180° — turn left instead
      newAngle = (projAngle + TRACEANGLE) >>> 0;
    } else {
      newAngle = (projAngle - TRACEANGLE) >>> 0;
    }
  }

  // Update momentum from new angle (keep same speed)
  const an = (newAngle >>> ANGLETOFINESHIFT) & FINEMASK;
  proj.momx = fixedMul(proj.info.speed, finecosine(an));
  proj.momy = fixedMul(proj.info.speed, finesine[an]);

  // Vertical homing: adjust momz toward target midpoint
  const dx = tx - proj.x;
  const dy = ty - proj.y;
  const dist = Math.max(1, Math.sqrt(
    (dx / FRACUNIT) * (dx / FRACUNIT) +
    (dy / FRACUNIT) * (dy / FRACUNIT)
  ));
  // Target midpoint z
  const targetMidZ = tz + (tHeight >> 1);
  const slope = ((targetMidZ - proj.z) / dist) | 0;
  // Adjust momz gradually (DOOM: slope * speed / FRACUNIT)
  proj.momz = fixedMul(proj.info.speed, slope);
}

// ============================================================
// Accessors
// ============================================================

/** Get all active projectiles (for renderer) */
export function getActiveProjectiles(gi: GameInstance): ReadonlyArray<Projectile> {
  return gi.activeProjectiles;
}

/** Clear all projectiles (on level change) */
export function clearProjectiles(gi: GameInstance): void {
  gi.activeProjectiles.length = 0;
}

/** Get the current animation frame for a projectile */
export function getProjectileSprite(proj: Projectile): { sprite: string; frame: number } {
  return {
    sprite: proj.info.sprite,
    frame: proj.tic % proj.info.numFrames,
  };
}
