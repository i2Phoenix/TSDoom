// ============================================================
// Screen-Space Ambient Occlusion (SSAO)
// Simplified for software renderer: uses zBuffer depth to detect
// edges and concavities, darkens pixels in corners/crevices.
// ============================================================

import { zBuffer, Z_DEPTH_MASK, ZFLAG_WALL } from './draw';
import { SurfaceType } from './gbuffer';
import type { GBuffer } from './gbuffer';
import type { PostProcessPass } from './postprocess';

/** Whether SSAO is enabled */
export let ssaoEnabled = true;
export function setSsaoEnabled(v: boolean): void { ssaoEnabled = v; }

// SSAO parameters
const SSAO_RADIUS = 3;          // sample radius in pixels
const SSAO_STRENGTH = 0.4;      // max darkening factor (0=none, 1=full black)
const SSAO_DEPTH_THRESHOLD = 8; // minimum depth difference to count as occlusion

// Sample offsets (8 directions at radius distance, plus closer samples)
const SAMPLES = [
  [-2, 0], [2, 0], [0, -2], [0, 2],     // cardinal
  [-1, -1], [1, -1], [-1, 1], [1, 1],   // diagonal close
  [-3, 0], [3, 0], [0, -3], [0, 3],     // cardinal far
];
const NUM_SAMPLES = SAMPLES.length;

// Reusable occlusion buffer (half-res for performance)
let occBuf: Float32Array | null = null;
let occW = 0;
let occH = 0;

/**
 * SSAO post-process pass.
 * Computes occlusion at half resolution, then applies darkening
 * to the full-res rgbaBuffer.
 */
export const ssaoPass: PostProcessPass = (
  rgba: Uint32Array,
  gb: GBuffer,
  width: number,
  height: number
): void => {
  if (!ssaoEnabled) return;

  // Half-res for performance
  const hw = (width + 1) >> 1;
  const hh = (height + 1) >> 1;

  if (occW !== hw || occH !== hh) {
    occW = hw;
    occH = hh;
    occBuf = new Float32Array(hw * hh);
  }

  const flagsBuf = gb.flags;

  // Pass 1: compute occlusion at half-res
  for (let hy = 1; hy < hh - 1; hy++) {
    const srcY = hy << 1;
    for (let hx = 1; hx < hw - 1; hx++) {
      const srcX = hx << 1;
      const srcIdx = srcY * width + srcX;

      const f = flagsBuf[srcIdx];
      if (f === SurfaceType.NONE || f === SurfaceType.SKY || f === SurfaceType.PSPRITE) {
        occBuf![hy * hw + hx] = 0;
        continue;
      }

      // Center depth (higher = closer to camera)
      const centerZ = zBuffer[srcIdx] & Z_DEPTH_MASK;
      if (centerZ === 0) {
        occBuf![hy * hw + hx] = 0;
        continue;
      }

      // Count how many samples are at significantly different depth
      let occlusion = 0;
      for (let s = 0; s < NUM_SAMPLES; s++) {
        const sx = srcX + SAMPLES[s][0] * SSAO_RADIUS;
        const sy = srcY + SAMPLES[s][1] * SSAO_RADIUS;
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) {
          // Edge of screen counts as occluded
          occlusion += 0.5;
          continue;
        }

        const sampleIdx = sy * width + sx;
        const sf = flagsBuf[sampleIdx];
        if (sf === SurfaceType.NONE || sf === SurfaceType.SKY) continue;

        const sampleZ = zBuffer[sampleIdx] & Z_DEPTH_MASK;
        // If neighbor is closer (higher Z), this pixel is in a crevice
        const diff = sampleZ - centerZ;
        if (diff > SSAO_DEPTH_THRESHOLD) {
          // Closer neighbor = this pixel is recessed
          occlusion += Math.min(1.0, diff / (SSAO_DEPTH_THRESHOLD * 8));
        }
      }

      // Normalize: 0 = no occlusion, 1 = fully occluded
      occBuf![hy * hw + hx] = Math.min(1.0, occlusion / NUM_SAMPLES);
    }
  }

  // Clear edges
  for (let hx = 0; hx < hw; hx++) { occBuf![hx] = 0; occBuf![(hh - 1) * hw + hx] = 0; }
  for (let hy = 0; hy < hh; hy++) { occBuf![hy * hw] = 0; occBuf![hy * hw + hw - 1] = 0; }

  // Pass 2: apply occlusion darkening to full-res (upscale 2x2 blocks)
  for (let hy = 0; hy < hh; hy++) {
    const baseY = hy << 1;
    for (let hx = 0; hx < hw; hx++) {
      const occ = occBuf![hy * hw + hx];
      if (occ <= 0.01) continue;

      const darken = 1.0 - occ * SSAO_STRENGTH;
      const baseX = hx << 1;

      for (let by = 0; by < 2 && baseY + by < height; by++) {
        for (let bx = 0; bx < 2 && baseX + bx < width; bx++) {
          const fi = (baseY + by) * width + (baseX + bx);
          const f = flagsBuf[fi];
          if (f === SurfaceType.NONE || f === SurfaceType.SKY || f === SurfaceType.PSPRITE) continue;

          const px = rgba[fi];
          const r = ((px & 0xFF) * darken) | 0;
          const g = (((px >> 8) & 0xFF) * darken) | 0;
          const b = (((px >> 16) & 0xFF) * darken) | 0;
          rgba[fi] = (255 << 24) | (b << 16) | (g << 8) | r;
        }
      }
    }
  }
};
