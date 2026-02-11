// ============================================================
// Post-Process Pipeline
// Chain of screen-space effects applied after lighting resolve.
// Each pass reads/writes rgbaBuffer and may read G-Buffer.
// ============================================================

import { GBuffer } from './gbuffer';

/**
 * A single post-process pass.
 * Receives the RGBA buffer, G-Buffer, and screen dimensions.
 * Modifies rgbaBuffer in-place.
 */
export type PostProcessPass = (
  rgba: Uint32Array,
  gBuffer: GBuffer,
  width: number,
  height: number
) => void;

/** Registered post-process passes (executed in order) */
const passes: PostProcessPass[] = [];

/** Add a post-process pass to the end of the chain */
export function addPostProcessPass(pass: PostProcessPass): void {
  passes.push(pass);
}

/** Remove a post-process pass */
export function removePostProcessPass(pass: PostProcessPass): void {
  const idx = passes.indexOf(pass);
  if (idx !== -1) passes.splice(idx, 1);
}

/** Run all registered post-process passes */
export function runPostProcess(
  rgba: Uint32Array,
  gb: GBuffer,
  width: number,
  height: number
): void {
  for (const pass of passes) {
    pass(rgba, gb, width, height);
  }
}

// ============================================================
// Built-in passes (future slots — not implemented yet)
// ============================================================

// Dynamic Lights pass:
// Reads gBuffer.worldX/Y/Z for each pixel, computes distance to
// active light sources (muzzle flash, explosions, torches),
// adds RGB contribution on top of base lighting.
// export const dynamicLightsPass: PostProcessPass = (rgba, gb, w, h) => { ... };

// Distance Fog pass:
// Reads gBuffer.worldX/Y/Z (or zBuffer depth), blends toward
// fog color based on distance from camera.
// export const fogPass: PostProcessPass = (rgba, gb, w, h) => { ... };

// Ambient Occlusion pass:
// Reads gBuffer.flags + depth to detect corners/edges,
// darkens pixels in concave areas.
// export const aoPass: PostProcessPass = (rgba, gb, w, h) => { ... };
