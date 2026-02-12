// ============================================================
// Post-Process Pipeline
// Chain of screen-space effects applied after lighting resolve.
// Each pass reads/writes rgbaBuffer and may read G-Buffer.
// ============================================================

import { GBuffer } from './gbuffer';
import { profilerBegin, profilerEnd } from '../../game/profiler';

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
const passNames: string[] = [];

/** Add a post-process pass to the end of the chain */
export function addPostProcessPass(pass: PostProcessPass, name?: string): void {
  passes.push(pass);
  passNames.push(name || pass.name || `pass${passes.length}`);
}

/** Remove a post-process pass */
export function removePostProcessPass(pass: PostProcessPass): void {
  const idx = passes.indexOf(pass);
  if (idx !== -1) {
    passes.splice(idx, 1);
    passNames.splice(idx, 1);
  }
}

/** Run all registered post-process passes */
export function runPostProcess(
  rgba: Uint32Array,
  gb: GBuffer,
  width: number,
  height: number
): void {
  for (let i = 0; i < passes.length; i++) {
    profilerBegin(`  ${passNames[i]}`);
    passes[i](rgba, gb, width, height);
    profilerEnd(`  ${passNames[i]}`);
  }
}


