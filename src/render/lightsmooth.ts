// ============================================================
// Smooth Sector Light Transitions
// Softens hard light boundaries between sectors.
// PostProcess pass: detects light-level edges in G-Buffer
// and applies a small blur to smooth them.
// ============================================================

import type { GBuffer } from './gbuffer';
import { SurfaceType } from './gbuffer';
import type { PostProcessPass } from './postprocess';

/** Whether light smoothing is enabled */
export let lightSmoothEnabled = true;
export function setLightSmoothEnabled(v: boolean): void { lightSmoothEnabled = v; }

/**
 * Light smoothing post-process pass.
 * For pixels where neighboring lightLevel differs by a threshold,
 * blend the pixel color with its neighbors (3x1 horizontal blur).
 * Only blurs across light boundaries, not texture edges.
 */
export const lightSmoothPass: PostProcessPass = (
  rgba: Uint32Array,
  gb: GBuffer,
  width: number,
  height: number
): void => {
  if (!lightSmoothEnabled) return;

  const lightBuf = gb.lightLevel;
  const flagsBuf = gb.flags;
  const THRESHOLD = 3; // minimum lightLevel difference to blur

  // Horizontal pass: blend with left/right neighbors at light boundaries
  // Work on a copy to avoid cascading blur
  const len = width * height;
  // Reuse a static buffer to avoid allocations
  if (blurBuf.length !== len) {
    blurBuf = new Uint32Array(len);
  }
  blurBuf.set(rgba);

  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = rowOff + x;
      const f = flagsBuf[i];
      if (f === SurfaceType.NONE || f === SurfaceType.SKY || f === SurfaceType.PSPRITE) continue;

      const ll = lightBuf[i];
      const llL = lightBuf[i - 1];
      const llR = lightBuf[i + 1];

      // Only blur if there's a significant light difference with a neighbor
      const diffL = Math.abs(ll - llL);
      const diffR = Math.abs(ll - llR);
      if (diffL < THRESHOLD && diffR < THRESHOLD) continue;

      // Check neighbors are valid surfaces
      const fL = flagsBuf[i - 1];
      const fR = flagsBuf[i + 1];
      if (fL === SurfaceType.NONE || fL === SurfaceType.SKY) continue;
      if (fR === SurfaceType.NONE || fR === SurfaceType.SKY) continue;

      // 3-tap weighted average: [0.25, 0.5, 0.25]
      const pxC = blurBuf[i];
      const pxL = blurBuf[i - 1];
      const pxR = blurBuf[i + 1];

      const r = ((pxC & 0xFF) * 2 + (pxL & 0xFF) + (pxR & 0xFF)) >> 2;
      const g = (((pxC >> 8) & 0xFF) * 2 + ((pxL >> 8) & 0xFF) + ((pxR >> 8) & 0xFF)) >> 2;
      const b = (((pxC >> 16) & 0xFF) * 2 + ((pxL >> 16) & 0xFF) + ((pxR >> 16) & 0xFF)) >> 2;

      rgba[i] = (255 << 24) | (b << 16) | (g << 8) | r;
    }
  }
};

let blurBuf = new Uint32Array(0);
