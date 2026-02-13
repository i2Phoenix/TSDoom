// ============================================================
// Visual Effects System — Puffs, Blood, Explosions
// Spawns temporary sprite effects at hit locations.
// Reference: p_mobj.c (P_SpawnPuff, P_SpawnBlood)
// ============================================================

import { FRACBITS, FRACUNIT } from './math';
import { GameMap } from '../src/map';
import { P_Random } from './random';
import { FX_DynLight } from './effects';

// ---- Frame data from info.c ----
// Frame number with bit 15 set = fullbright
const FF_FULLBRIGHT = 0x8000;

interface VfxFrame {
  sprite: string;
  frame: number;     // frame index (bit 15 = fullbright)
  tics: number;      // duration in game tics
}

// Puff: S_PUFF1..S_PUFF4
const PUFF_FRAMES: VfxFrame[] = [
  { sprite: 'PUFF', frame: 0 | FF_FULLBRIGHT, tics: 4 },
  { sprite: 'PUFF', frame: 1, tics: 4 },
  { sprite: 'PUFF', frame: 2, tics: 4 },
  { sprite: 'PUFF', frame: 3, tics: 4 },
];

// Puff for melee hits: start at frame 2 (S_PUFF3) — no initial flash
const PUFF_MELEE_FRAMES: VfxFrame[] = [
  { sprite: 'PUFF', frame: 2, tics: 4 },
  { sprite: 'PUFF', frame: 3, tics: 4 },
];

// Blood: S_BLOOD1..S_BLOOD3 (frames go 2→1→0)
const BLOOD_FRAMES: VfxFrame[] = [
  { sprite: 'BLUD', frame: 2, tics: 8 },
  { sprite: 'BLUD', frame: 1, tics: 8 },
  { sprite: 'BLUD', frame: 0, tics: 8 },
];

// Barrel explosion: S_BEXP..S_BEXP5 (all fullbright)
// NOTE: A_Explode triggers on frame index 3 (S_BEXP4) — handled externally
const BARREL_EXPLODE_FRAMES: VfxFrame[] = [
  { sprite: 'BEXP', frame: 0 | FF_FULLBRIGHT, tics: 5 },
  { sprite: 'BEXP', frame: 1 | FF_FULLBRIGHT, tics: 5 },
  { sprite: 'BEXP', frame: 2 | FF_FULLBRIGHT, tics: 5 },
  { sprite: 'BEXP', frame: 3 | FF_FULLBRIGHT, tics: 10 },
  { sprite: 'BEXP', frame: 4 | FF_FULLBRIGHT, tics: 10 },
];

// The tick index at which barrel A_Explode fires (start of frame 3)
const BARREL_EXPLODE_TICK = 5 + 5 + 5; // after first 3 frames

// ---- VFX Effect instance ----
export interface VfxEffect {
  x: number;       // fixed_t world position
  y: number;
  z: number;
  frames: VfxFrame[];
  frameIndex: number;
  ticsLeft: number; // tics remaining in current frame
  done: boolean;
  // Barrel-specific: callback to fire explosion at the right tick
  onExplodeTick?: number;
  explodeCallback?: () => void;
  totalTics: number; // total tics elapsed
}

// ---- Active effects list ----
const activeEffects: VfxEffect[] = [];

/** Spawn a bullet puff at a wall hit position */
export function spawnPuff(x: number, y: number, z: number, melee: boolean): void {
  const frames = melee ? PUFF_MELEE_FRAMES : PUFF_FRAMES;
  // Vertical jitter like original: z += (P_Random()-P_Random())<<10
  const jitterZ = z + ((P_Random() - P_Random()) << 10);

  console.log(`[vfx] spawnPuff at (${x >> FRACBITS}, ${y >> FRACBITS}, ${jitterZ >> FRACBITS}) melee=${melee}`);

  const effect: VfxEffect = {
    x, y,
    z: jitterZ + FRACUNIT, // puff rises (momz = FRACUNIT)
    frames,
    frameIndex: 0,
    ticsLeft: (frames[0].tics - (P_Random() & 3)) || 1,
    done: false,
    totalTics: 0,
  };
  activeEffects.push(effect);

  // Small flash at bullet impact point
  if (!melee) {
    FX_DynLight(x, y, jitterZ, 48 * FRACUNIT, 255, 200, 100, 0.3, 2);
  }
}

/** Spawn blood splatter at a thing hit position */
export function spawnBlood(x: number, y: number, z: number, _damage: number): void {
  const jitterZ = z + ((P_Random() - P_Random()) << 10);
  console.log(`[vfx] spawnBlood at (${x >> FRACBITS}, ${y >> FRACBITS}, ${jitterZ >> FRACBITS})`);
  const effect: VfxEffect = {
    x, y,
    z: jitterZ,
    frames: BLOOD_FRAMES,
    frameIndex: 0,
    ticsLeft: (BLOOD_FRAMES[0].tics - (P_Random() & 3)) || 1,
    done: false,
    totalTics: 0,
  };
  activeEffects.push(effect);
}

/**
 * Spawn barrel explosion animation at the barrel's position.
 * explodeCallback fires at the correct tick to trigger P_RadiusAttack.
 */
export function spawnBarrelExplosion(
  x: number, y: number, z: number,
  explodeCallback: () => void
): void {
  console.log(`[vfx] spawnBarrelExplosion at (${x >> FRACBITS}, ${y >> FRACBITS}, ${z >> FRACBITS})`);
  const effect: VfxEffect = {
    x, y, z,
    frames: BARREL_EXPLODE_FRAMES,
    frameIndex: 0,
    ticsLeft: BARREL_EXPLODE_FRAMES[0].tics,
    done: false,
    onExplodeTick: BARREL_EXPLODE_TICK,
    explodeCallback,
    totalTics: 0,
  };
  activeEffects.push(effect);
}

/** Tick all active effects — call once per game tic */
export function updateVfx(): void {
  for (let i = activeEffects.length - 1; i >= 0; i--) {
    const e = activeEffects[i];
    e.totalTics++;

    // Puff rises (momz = FRACUNIT per tic)
    if (e.frames === PUFF_FRAMES || e.frames === PUFF_MELEE_FRAMES) {
      e.z += FRACUNIT;
    }
    // Blood rises faster (momz = 2*FRACUNIT)
    if (e.frames === BLOOD_FRAMES) {
      e.z += 2 * FRACUNIT;
    }

    // Check barrel explosion callback
    if (e.onExplodeTick !== undefined && e.totalTics === e.onExplodeTick && e.explodeCallback) {
      e.explodeCallback();
      e.explodeCallback = undefined; // fire only once
    }

    e.ticsLeft--;
    if (e.ticsLeft <= 0) {
      e.frameIndex++;
      if (e.frameIndex >= e.frames.length) {
        e.done = true;
      } else {
        e.ticsLeft = e.frames[e.frameIndex].tics;
      }
    }

    if (e.done) {
      activeEffects.splice(i, 1);
    }
  }
}

/** Get all active VFX effects (for the renderer) */
export function getActiveVfx(): ReadonlyArray<VfxEffect> {
  return activeEffects;
}

/** Clear all effects (on level change) */
export function clearVfx(): void {
  activeEffects.length = 0;
}

/** Get the current sprite/frame for a VFX effect */
export function getVfxSprite(e: VfxEffect): { sprite: string; frame: number } {
  const f = e.frames[e.frameIndex];
  return {
    sprite: f.sprite,
    frame: f.frame & ~FF_FULLBRIGHT, // strip fullbright for frame index
  };
}

// ---- Rocket explosion: MISL frames B/C/D (S_EXPLODE1..3) ----
const ROCKET_EXPLODE_FRAMES: VfxFrame[] = [
  { sprite: 'MISL', frame: 1 | FF_FULLBRIGHT, tics: 8 },
  { sprite: 'MISL', frame: 2 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'MISL', frame: 3 | FF_FULLBRIGHT, tics: 4 },
];

/** Spawn rocket explosion VFX */
export function spawnRocketExplosion(x: number, y: number, z: number): void {
  const effect: VfxEffect = {
    x, y, z,
    frames: ROCKET_EXPLODE_FRAMES,
    frameIndex: 0,
    ticsLeft: ROCKET_EXPLODE_FRAMES[0].tics,
    done: false,
    totalTics: 0,
  };
  activeEffects.push(effect);
  FX_DynLight(x, y, z, 160 * FRACUNIT, 255, 180, 60, 0.5, 8);
}

// ---- Plasma hit: PLSE frames A/B/C/D/E (S_PLASEXP..5) ----
const PLASMA_HIT_FRAMES: VfxFrame[] = [
  { sprite: 'PLSE', frame: 0 | FF_FULLBRIGHT, tics: 4 },
  { sprite: 'PLSE', frame: 1 | FF_FULLBRIGHT, tics: 4 },
  { sprite: 'PLSE', frame: 2 | FF_FULLBRIGHT, tics: 4 },
  { sprite: 'PLSE', frame: 3 | FF_FULLBRIGHT, tics: 4 },
  { sprite: 'PLSE', frame: 4 | FF_FULLBRIGHT, tics: 4 },
];

/** Spawn plasma impact VFX */
export function spawnPlasmaHit(x: number, y: number, z: number): void {
  const effect: VfxEffect = {
    x, y, z,
    frames: PLASMA_HIT_FRAMES,
    frameIndex: 0,
    ticsLeft: PLASMA_HIT_FRAMES[0].tics,
    done: false,
    totalTics: 0,
  };
  activeEffects.push(effect);
  FX_DynLight(x, y, z, 96 * FRACUNIT, 80, 80, 255, 0.4, 5);
}

// ---- BFG hit: BFE1 frames A/B/C/D/E/F (S_BFGLAND..6) ----
const BFG_HIT_FRAMES: VfxFrame[] = [
  { sprite: 'BFE1', frame: 0 | FF_FULLBRIGHT, tics: 8 },
  { sprite: 'BFE1', frame: 1 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'BFE1', frame: 2 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'BFE1', frame: 3 | FF_FULLBRIGHT, tics: 4 },
  { sprite: 'BFE1', frame: 4 | FF_FULLBRIGHT, tics: 4 },
  { sprite: 'BFE1', frame: 5 | FF_FULLBRIGHT, tics: 4 },
];

/** Spawn BFG impact VFX */
export function spawnBfgHit(x: number, y: number, z: number): void {
  const effect: VfxEffect = {
    x, y, z,
    frames: BFG_HIT_FRAMES,
    frameIndex: 0,
    ticsLeft: BFG_HIT_FRAMES[0].tics,
    done: false,
    totalTics: 0,
  };
  activeEffects.push(effect);
  FX_DynLight(x, y, z, 192 * FRACUNIT, 80, 255, 80, 0.7, 12);
}

// ---- Teleport fog: TFOG frames A→J (S_TFOG..S_TFOG10) ----
const TFOG_FRAMES: VfxFrame[] = [
  { sprite: 'TFOG', frame: 0 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'TFOG', frame: 1 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'TFOG', frame: 0 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'TFOG', frame: 1 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'TFOG', frame: 2 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'TFOG', frame: 3 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'TFOG', frame: 4 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'TFOG', frame: 5 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'TFOG', frame: 6 | FF_FULLBRIGHT, tics: 6 },
  { sprite: 'TFOG', frame: 7 | FF_FULLBRIGHT, tics: 6 },
];

/** Spawn teleport fog VFX (green flash) at a position */
export function spawnTeleportFog(x: number, y: number, z: number): void {
  const effect: VfxEffect = {
    x, y, z,
    frames: TFOG_FRAMES,
    frameIndex: 0,
    ticsLeft: TFOG_FRAMES[0].tics,
    done: false,
    totalTics: 0,
  };
  activeEffects.push(effect);
  // Green-tinted dynamic light for teleport flash
  FX_DynLight(x, y, z, 128 * FRACUNIT, 50, 255, 50, 0.6, 10);
}

// ---- Arch-vile fire: FIRE sprite (S_FIRE1..S_FIRE8, all fullbright) ----
const VILE_FIRE_FRAMES: VfxFrame[] = [
  { sprite: 'FIRE', frame: 0 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 1 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 2 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 3 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 4 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 5 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 6 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 7 | FF_FULLBRIGHT, tics: 2 },
  // Repeat cycle to last full attack duration (~70 tics)
  { sprite: 'FIRE', frame: 0 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 1 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 2 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 3 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 4 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 5 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 6 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 7 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 0 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 1 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 2 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 3 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 4 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 5 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 6 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 7 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 0 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 1 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 2 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 3 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 4 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 5 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 6 | FF_FULLBRIGHT, tics: 2 },
  { sprite: 'FIRE', frame: 7 | FF_FULLBRIGHT, tics: 2 },
];

/** Spawn Arch-vile fire VFX at a position (MT_FIRE visual) */
export function spawnVileFire(x: number, y: number, z: number): void {
  const effect: VfxEffect = {
    x, y, z,
    frames: VILE_FIRE_FRAMES,
    frameIndex: 0,
    ticsLeft: VILE_FIRE_FRAMES[0].tics,
    done: false,
    totalTics: 0,
  };
  activeEffects.push(effect);
  // Flickering orange/yellow fire light
  FX_DynLight(x, y, z, 128 * FRACUNIT, 255, 128, 32, 0.6, 64);
}
