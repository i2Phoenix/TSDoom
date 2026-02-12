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
const SSAO_STRENGTH = 0.4;      // max darkening factor (0=none, 1=full black)
const SSAO_DEPTH_THRESHOLD = 8; // minimum depth difference to count as occlusion
const SSAO_MAX_DIFF = SSAO_DEPTH_THRESHOLD * 8;

// 8 sample offsets (cardinal + diagonal) — pre-scaled by radius 2
const SAMPLE_DX = [-2, 2, 0, 0, -2, 2, -2, 2];
const SAMPLE_DY = [0, 0, -2, 2, -2, -2, 2, 2];
const NUM_SAMPLES = 8;
// Reciprocal for normalising: 256 / NUM_SAMPLES
const INV_NUM_SAMPLES = (256 / NUM_SAMPLES) | 0;

// Reusable occlusion buffer (quarter-res for performance)
let occBuf: Uint8Array | null = null;
let occW = 0;
let occH = 0;

/**
 * SSAO post-process pass.
 * Computes occlusion at quarter resolution, then applies darkening
 * to the full-res rgbaBuffer.
 */
export const ssaoPass: PostProcessPass = (
  rgba: Uint32Array,
  gb: GBuffer,
  width: number,
  height: number
): void => {
  if (!ssaoEnabled) return;

  // Quarter-res (4x fewer pixels to process vs half-res)
  const qw = (width + 3) >> 2;
  const qh = (height + 3) >> 2;

  if (occW !== qw || occH !== qh) {
    occW = qw;
    occH = qh;
    occBuf = new Uint8Array(qw * qh);
  }

  const flagsBuf = gb.flags;
  const zBuf = zBuffer;
  const occ = occBuf!;

  // Pass 1: compute occlusion at quarter-res
  // Loop bounds padded inward to avoid per-sample bounds checking
  const pad = 3; // max sample offset relative to src coords
  const qxStart = Math.max(1, ((pad + 3) >> 2));
  const qxEnd = Math.min(qw - 1, ((width - 1 - pad) >> 2));
  const qyStart = Math.max(1, ((pad + 3) >> 2));
  const qyEnd = Math.min(qh - 1, ((height - 1 - pad) >> 2));

  // Clear border
  occ.fill(0);

  for (let qy = qyStart; qy <= qyEnd; qy++) {
    const srcY = qy << 2;
    const occRow = qy * qw;
    for (let qx = qxStart; qx <= qxEnd; qx++) {
      const srcX = qx << 2;
      const srcIdx = srcY * width + srcX;

      const f = flagsBuf[srcIdx];
      if (f === SurfaceType.NONE || f === SurfaceType.SKY || f === SurfaceType.PSPRITE) {
        // occ already 0 from fill
        continue;
      }

      // Center depth (higher = closer to camera)
      const centerZ = zBuf[srcIdx] & Z_DEPTH_MASK;
      if (centerZ === 0) continue;

      // Integer occlusion: accumulate in 0..256 range
      let occAcc = 0;
      for (let s = 0; s < NUM_SAMPLES; s++) {
        const sx = srcX + SAMPLE_DX[s];
        const sy = srcY + SAMPLE_DY[s];
        const sampleIdx = sy * width + sx;

        const sampleZ = zBuf[sampleIdx] & Z_DEPTH_MASK;
        const diff = sampleZ - centerZ;
        if (diff > SSAO_DEPTH_THRESHOLD) {
          // Clamp diff contribution to 256 (= fully occluded for this sample)
          occAcc += diff < SSAO_MAX_DIFF ? ((diff << 8) / SSAO_MAX_DIFF) | 0 : 256;
        }
      }

      // Normalize: multiply by INV_NUM_SAMPLES, shift to 0..255 range
      // occAcc is 0..NUM_SAMPLES*256, result is 0..255
      const norm = (occAcc * INV_NUM_SAMPLES) >> 8;
      occ[occRow + qx] = norm > 255 ? 255 : norm;
    }
  }

  // Pass 2: apply occlusion darkening to full-res (upscale 4x4 blocks)
  for (let qy = qyStart; qy <= qyEnd; qy++) {
    const baseY = qy << 2;
    const occRow = qy * qw;
    const maxBY = Math.min(4, height - baseY);
    for (let qx = qxStart; qx <= qxEnd; qx++) {
      const occVal = occ[occRow + qx];
      if (occVal < 3) continue; // skip negligible occlusion

      // Darken factor: 256 = no change, lower = darker
      // darken = 256 * (1.0 - (occVal/255) * SSAO_STRENGTH)
      const darken = 256 - ((occVal * (SSAO_STRENGTH * 256 / 255)) | 0);
      const baseX = qx << 2;
      const maxBX = Math.min(4, width - baseX);

      for (let by = 0; by < maxBY; by++) {
        const rowOff = (baseY + by) * width + baseX;
        for (let bx = 0; bx < maxBX; bx++) {
          const fi = rowOff + bx;
          const f = flagsBuf[fi];
          if (f === SurfaceType.NONE || f === SurfaceType.SKY || f === SurfaceType.PSPRITE) continue;

          const px = rgba[fi];
          const r = ((px & 0xFF) * darken) >> 8;
          const g = (((px >> 8) & 0xFF) * darken) >> 8;
          const b = (((px >> 16) & 0xFF) * darken) >> 8;
          rgba[fi] = 0xFF000000 | (b << 16) | (g << 8) | r;
        }
      }
    }
  }
};
