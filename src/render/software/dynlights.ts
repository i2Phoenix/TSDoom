// ============================================================
// Dynamic Lights System
// Point lights from muzzle flashes, explosions, torches, etc.
// Implemented as a PostProcess pass reading G-Buffer worldXYZ.
// ============================================================

import { FRACBITS, FRACUNIT } from '../../../game/math';
import { SCREENWIDTH, SCREENHEIGHT, rgbaBuffer } from './draw';
import { gBuffer, SurfaceType } from './gbuffer';
import type { GBuffer } from './gbuffer';
import type { PostProcessPass } from './postprocess';
import type { MapThing } from '../../map';

// View position (set each frame from renderer for distance culling + psprite lighting)
let _viewx = 0;
let _viewy = 0;
let _viewz = 0;

/** Update view position for light culling (call before dynlights pass) */
export function setDynLightView(vx: number, vy: number, vz: number): void {
  _viewx = vx;
  _viewy = vy;
  _viewz = vz;
}

// ---- Light definition ----

export interface DynLight {
  x: number;         // fixed_t world position
  y: number;
  z: number;
  radius: number;    // fixed_t max range
  r: number;         // 0-255 light color
  g: number;
  b: number;
  intensity: number; // 0.0-1.0
  ttl: number;       // remaining ticks (-1 = permanent)
}

// ---- Active lights ----

const MAX_LIGHTS = 64;
const lights: DynLight[] = [];

/** Whether dynamic lights rendering is enabled */
export let dynLightsEnabled = true;
export function setDynLightsEnabled(v: boolean): void { dynLightsEnabled = v; }

/** Add a dynamic light source */
export function addDynLight(
  x: number, y: number, z: number,
  radius: number,
  r: number, g: number, b: number,
  intensity: number,
  ttl: number
): void {
  if (lights.length >= MAX_LIGHTS) {
    // Replace the oldest temporary light
    for (let i = 0; i < lights.length; i++) {
      if (lights[i].ttl > 0) {
        lights.splice(i, 1);
        break;
      }
    }
    if (lights.length >= MAX_LIGHTS) return;
  }
  lights.push({ x, y, z, radius, r, g, b, intensity, ttl });
}

// Base intensity and flicker state for permanent lights
const baseIntensity: Map<DynLight, number> = new Map();
const flickerTarget: Map<DynLight, number> = new Map();
const flickerTimer: Map<DynLight, number> = new Map();

/** Tick: decrement ttl, remove expired, flicker permanent lights */
export function updateDynLights(): void {
  for (let i = lights.length - 1; i >= 0; i--) {
    const l = lights[i];
    if (l.ttl > 0) {
      l.ttl--;
      // Fade out over last few ticks (only for longer-lived lights)
      if (l.ttl <= 3 && l.ttl > 0) {
        l.intensity *= 0.7;
      }
      if (l.ttl === 0) {
        lights.splice(i, 1);
        baseIntensity.delete(l);
      }
    } else if (l.ttl === -1) {
      // Permanent light: smooth fire flicker
      if (!baseIntensity.has(l)) {
        baseIntensity.set(l, l.intensity);
        flickerTarget.set(l, l.intensity);
        flickerTimer.set(l, 0);
      }
      const base = baseIntensity.get(l)!;
      let timer = flickerTimer.get(l)! - 1;
      if (timer <= 0) {
        // Pick new target intensity every 4-12 ticks (~0.1-0.3 sec)
        flickerTarget.set(l, base * (0.85 + Math.random() * 0.3));
        timer = 4 + ((Math.random() * 8) | 0);
      }
      flickerTimer.set(l, timer);
      // Smooth interpolation toward target
      const target = flickerTarget.get(l)!;
      l.intensity += (target - l.intensity) * 0.15;
    }
  }
}

/** Get all active lights (for debug/inspection) */
export function getActiveLights(): readonly DynLight[] {
  return lights;
}

/** Clear all lights (level change) */
export function clearDynLights(): void {
  lights.length = 0;
  baseIntensity.clear();
  flickerTarget.clear();
  flickerTimer.clear();
}

/** Remove a permanent light near a world position (for destroyed barrels, etc.) */
export function removeDynLightAt(x: number, y: number, tolerance: number = 4 * FRACUNIT): void {
  for (let i = lights.length - 1; i >= 0; i--) {
    const l = lights[i];
    if (l.ttl !== -1) continue; // only permanent lights
    const dx = Math.abs(l.x - x);
    const dy = Math.abs(l.y - y);
    if (dx <= tolerance && dy <= tolerance) {
      lights.splice(i, 1);
      return;
    }
  }
}

// ============================================================
// Static lights from map things (torches, lamps, candles, etc.)
// ============================================================

/** Thing types that emit light, with color and radius */
const LIGHT_THINGS: Record<number, { r: number; g: number; b: number; radius: number }> = {
  // Tall torches
  44:  { r: 64, g: 96, b: 255, radius: 128 },   // Tall blue torch
  45:  { r: 64, g: 255, b: 64, radius: 128 },    // Tall green torch
  46:  { r: 255, g: 96, b: 48, radius: 128 },     // Tall red torch
  // Short torches
  55:  { r: 64, g: 96, b: 255, radius: 96 },      // Short blue torch
  56:  { r: 64, g: 255, b: 64, radius: 96 },       // Short green torch
  57:  { r: 255, g: 96, b: 48, radius: 96 },        // Short red torch
  // Other light sources
  34:  { r: 255, g: 200, b: 100, radius: 48 },     // Candle
  35:  { r: 255, g: 200, b: 100, radius: 96 },     // Candelabra
  2028: { r: 160, g: 200, b: 255, radius: 96 },    // Column (tech light)
  48:  { r: 160, g: 200, b: 255, radius: 80 },     // Tech column
  // Barrel (green glow — removed on explosion)
  2035: { r: 64, g: 255, b: 64, radius: 96 },
};

/**
 * Spawn permanent lights from map things (torches, lamps, etc.)
 * Call once after map load.
 */
export function spawnStaticLights(things: readonly MapThing[], pointInSubsector: (x: number, y: number) => { sector?: { floorHeight: number } | null }): void {
  let count = 0;
  for (const thing of things) {
    const def = LIGHT_THINGS[thing.type];
    if (!def) continue;

    const tx = thing.x << FRACBITS;
    const ty = thing.y << FRACBITS;
    // Get floor height for Z position
    const ss = pointInSubsector(tx, ty);
    const floorZ = ss.sector ? ss.sector.floorHeight : 0;
    // Light Z depends on thing type:
    // Barrels: top of barrel (42 units) — glow from the green slime on top
    // Tall torches: near the flame (60 units up)
    // Short torches: flame height (~40 units)
    // Candles/candelabra: low (20-30 units)
    let lightHeight = 40;
    if (thing.type === 2035) lightHeight = 44;        // Barrel — top
    else if (thing.type === 44 || thing.type === 45 || thing.type === 46) lightHeight = 60;  // Tall torches
    else if (thing.type === 34) lightHeight = 16;     // Candle — low
    else if (thing.type === 35) lightHeight = 30;     // Candelabra
    const tz = floorZ + (lightHeight << FRACBITS);

    addDynLight(
      tx, ty, tz,
      def.radius * FRACUNIT,
      def.r, def.g, def.b,
      0.25, // subtle ambient glow
      -1    // permanent
    );
    count++;
  }
  if (count > 0) {
    console.log(`[dynlights] ${count} static lights spawned from map things`);
  }
}

// ============================================================
// PostProcess Pass: Dynamic Lights
// Optimized: per-light accumulation buffer avoids full-screen
// iteration for every light. Only pixels within world-space
// radius are touched.
// ============================================================

// Half-resolution accumulation buffers (reused each frame)
let halfW = 0;
let halfH = 0;
let halfR: Float32Array | null = null;
let halfG: Float32Array | null = null;
let halfB: Float32Array | null = null;

/** Max distance from camera for a light to be visible (in map units) */
const MAX_LIGHT_VIEW_DIST = 1024;
const MAX_LIGHT_VIEW_DIST_SQ = MAX_LIGHT_VIEW_DIST * MAX_LIGHT_VIEW_DIST;

/**
 * Dynamic lights post-process pass.
 * Optimized: half-res + camera distance culling + per-pixel early out.
 */
export const dynamicLightsPass: PostProcessPass = (
  rgba: Uint32Array,
  gb: GBuffer,
  width: number,
  height: number
): void => {
  if (!dynLightsEnabled || lights.length === 0) return;

  // Cull lights by distance to camera
  const vx = _viewx >> FRACBITS;
  const vy = _viewy >> FRACBITS;
  const visibleLights: DynLight[] = [];
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    const cdx = (l.x >> FRACBITS) - vx;
    const cdy = (l.y >> FRACBITS) - vy;
    if (cdx * cdx + cdy * cdy < MAX_LIGHT_VIEW_DIST_SQ) {
      visibleLights.push(l);
    }
  }
  if (visibleLights.length === 0) return;

  // Half-res dimensions
  const hw = (width + 1) >> 1;
  const hh = (height + 1) >> 1;
  const hlen = hw * hh;

  // Allocate/resize half-res buffers
  if (halfW !== hw || halfH !== hh) {
    halfW = hw;
    halfH = hh;
    halfR = new Float32Array(hlen);
    halfG = new Float32Array(hlen);
    halfB = new Float32Array(hlen);
  }
  halfR!.fill(0);
  halfG!.fill(0);
  halfB!.fill(0);

  const flagsBuf = gb.flags;
  const wxBuf = gb.worldX;
  const wyBuf = gb.worldY;
  const wzBuf = gb.worldZ;

  // Pass 1: accumulate at half-res
  for (let li = 0; li < visibleLights.length; li++) {
    const l = visibleLights[li];
    const lx = l.x;
    const ly = l.y;
    const lz = l.z;
    const radiusMap = (l.radius >> FRACBITS) | 0;
    const radiusSq = radiusMap * radiusMap;
    const lr = l.r * l.intensity;
    const lg = l.g * l.intensity;
    const lb = l.b * l.intensity;
    const invRadius = 1.0 / radiusMap;

    for (let hy = 0; hy < hh; hy++) {
      const srcY = hy << 1;
      const rowBase = srcY * width;

      for (let hx = 0; hx < hw; hx++) {
        const srcIdx = rowBase + (hx << 1);
        const sf = flagsBuf[srcIdx];
        if (sf === SurfaceType.NONE || sf === SurfaceType.SKY || sf === SurfaceType.PSPRITE) continue;

        // Skip self-illumination: if this is a SPRITE pixel at the light's
        // own position, don't light it (prevents torch/barrel self-glow)
        if (sf === SurfaceType.SPRITE) {
          const sdx = Math.abs((wxBuf[srcIdx] - lx) >> FRACBITS);
          const sdy = Math.abs((wyBuf[srcIdx] - ly) >> FRACBITS);
          if (sdx < 4 && sdy < 4) continue;
        }

        const dx = ((wxBuf[srcIdx] - lx) >> FRACBITS) | 0;
        if (dx > radiusMap || dx < -radiusMap) continue;
        const dy = ((wyBuf[srcIdx] - ly) >> FRACBITS) | 0;
        if (dy > radiusMap || dy < -radiusMap) continue;

        const distSqXY = dx * dx + dy * dy;
        if (distSqXY >= radiusSq) continue;

        const dz = ((wzBuf[srcIdx] - lz) >> FRACBITS) | 0;
        const distSq = distSqXY + dz * dz;
        if (distSq >= radiusSq) continue;

        const dist = Math.sqrt(distSq);
        let att = 1.0 - dist * invRadius;
        att = att * att; // quadratic falloff

        // Vertical asymmetry for permanent lights (torches/candles):
        // pixels ABOVE the light get full brightness,
        // pixels BELOW get attenuated (light shines upward like fire)
        if (l.ttl === -1 && dz < 0) {
          // dz < 0 means pixel Z is below the light source Z
          const downDist = -dz;
          const downFade = 1.0 - Math.min(1.0, downDist / (radiusMap * 0.4));
          att *= downFade * downFade;
        }

        const hi = hy * hw + hx;
        halfR![hi] += lr * att;
        halfG![hi] += lg * att;
        halfB![hi] += lb * att;
      }
    }
  }

  // Compute uniform light at player position (for weapon/psprite tinting)
  let pspR = 0, pspG = 0, pspB = 0;
  {
    const pvx = _viewx;
    const pvy = _viewy;
    const pvz = _viewz;
    for (let li = 0; li < visibleLights.length; li++) {
      const l = visibleLights[li];
      const dx = ((pvx - l.x) >> FRACBITS) | 0;
      const dy = ((pvy - l.y) >> FRACBITS) | 0;
      const radiusMap = (l.radius >> FRACBITS) | 0;
      const distSq = dx * dx + dy * dy;
      const radiusSq = radiusMap * radiusMap;
      if (distSq >= radiusSq) continue;
      const dist = Math.sqrt(distSq);
      const att = 1.0 - dist / radiusMap;
      const att2 = att * att * l.intensity;
      pspR += l.r * att2;
      pspG += l.g * att2;
      pspB += l.b * att2;
    }
  }
  const hasPspLight = pspR > 0 || pspG > 0 || pspB > 0;
  const ipspR = pspR | 0;
  const ipspG = pspG | 0;
  const ipspB = pspB | 0;

  // Pass 2: upscale to full-res + apply psprite light
  for (let hy = 0; hy < hh; hy++) {
    const hiRow = hy * hw;
    const baseY = hy << 1;

    for (let hx = 0; hx < hw; hx++) {
      const hi = hiRow + hx;
      const ar = halfR![hi];
      const ag = halfG![hi];
      const ab = halfB![hi];
      const hasLight = ar > 0 || ag > 0 || ab > 0;
      if (!hasLight && !hasPspLight) continue;

      const iar = ar | 0;
      const iag = ag | 0;
      const iab = ab | 0;
      const baseX = hx << 1;

      // Apply to 2x2 block
      for (let by = 0; by < 2 && baseY + by < height; by++) {
        const rowOff = (baseY + by) * width + baseX;
        for (let bx = 0; bx < 2 && baseX + bx < width; bx++) {
          const fi = rowOff + bx;
          const f = flagsBuf[fi];
          if (f === SurfaceType.NONE || f === SurfaceType.SKY) continue;

          // PSPRITE gets uniform player-position light, not per-pixel
          const addR = f === SurfaceType.PSPRITE ? ipspR : iar;
          const addG = f === SurfaceType.PSPRITE ? ipspG : iag;
          const addB = f === SurfaceType.PSPRITE ? ipspB : iab;
          if (addR <= 0 && addG <= 0 && addB <= 0) continue;

          const px = rgba[fi];
          const fr = Math.min(255, (px & 0xFF) + addR);
          const fg = Math.min(255, ((px >> 8) & 0xFF) + addG);
          const fb = Math.min(255, ((px >> 16) & 0xFF) + addB);
          rgba[fi] = (255 << 24) | (fb << 16) | (fg << 8) | fr;
        }
      }
    }
  }
};
