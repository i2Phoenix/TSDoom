// ============================================================
// Screen Wipe/Melt Effect (from f_wipe.c)
// DOOM's iconic column-based screen melt transition.
//
// Each column slides down at a staggered, random speed,
// revealing the new screen underneath.
// ============================================================

import { SCREENWIDTH, SCREENHEIGHT, rgbaBuffer } from './draw';

// Wipe state
let wipeActive = false;
let wipeStartBuffer: Uint32Array | null = null; // snapshot of old screen
let wipeEndBuffer: Uint32Array | null = null;   // snapshot of new screen
let columnY: number[] = [];                      // per-column melt progress (in pixels)

/**
 * Start a screen wipe transition.
 * Captures the current screen as the "start" (old) screen.
 * Call wipeEndCapture() after rendering the new scene, then tick with wipeTick().
 */
export function wipeStartCapture(): void {
  wipeStartBuffer = new Uint32Array(rgbaBuffer.length);
  wipeStartBuffer.set(rgbaBuffer);
}

/**
 * Capture the "end" (new) screen and initialize column positions.
 * Must be called after rendering the new scene into rgbaBuffer.
 */
export function wipeEndCapture(): void {
  wipeEndBuffer = new Uint32Array(rgbaBuffer.length);
  wipeEndBuffer.set(rgbaBuffer);

  // Initialize per-column random start positions (y < 0 means delay)
  // Matches DOOM's wipe_initMelt
  const w = SCREENWIDTH;
  columnY = new Array(w);
  columnY[0] = -(Math.random() * 16) | 0;
  for (let i = 1; i < w; i++) {
    const r = ((Math.random() * 3) | 0) - 1; // -1, 0, or 1
    columnY[i] = columnY[i - 1] + r;
    if (columnY[i] > 0) columnY[i] = 0;
    else if (columnY[i] === -16) columnY[i] = -15;
  }

  wipeActive = true;
}

/** Returns true if a wipe is currently in progress */
export function isWipeActive(): boolean {
  return wipeActive;
}

/**
 * Advance the wipe by one tick and composite the result into rgbaBuffer.
 * Returns true when the wipe is complete.
 */
export function wipeTick(): boolean {
  if (!wipeActive || !wipeStartBuffer || !wipeEndBuffer) return true;

  const w = SCREENWIDTH;
  const h = SCREENHEIGHT;
  let done = true;

  // Advance each column (matches DOOM's wipe_doMelt)
  // Process multiple ticks per call for faster wipe (DOOM runs this per-frame)
  const TICKS_PER_CALL = 3;
  for (let t = 0; t < TICKS_PER_CALL; t++) {
    for (let i = 0; i < w; i++) {
      if (columnY[i] < 0) {
        columnY[i]++;
        done = false;
      } else if (columnY[i] < h) {
        const dy = (columnY[i] < 16) ? columnY[i] + 1 : 8;
        columnY[i] += dy;
        if (columnY[i] > h) columnY[i] = h;
        done = false;
      }
    }
  }

  // Composite: for each column, draw end screen on top, start screen shifted down
  for (let x = 0; x < w; x++) {
    const meltY = columnY[x];
    for (let y = 0; y < h; y++) {
      const destIdx = y * w + x;
      if (y < meltY) {
        // Top part — pixels from the END (new) screen
        rgbaBuffer[destIdx] = wipeEndBuffer[destIdx];
      } else {
        // Bottom part — shifted pixels from the START (old) screen
        const srcY = y - meltY;
        if (srcY >= 0 && srcY < h) {
          rgbaBuffer[destIdx] = wipeStartBuffer[srcY * w + x];
        } else {
          rgbaBuffer[destIdx] = wipeEndBuffer[destIdx];
        }
      }
    }
  }

  if (done) {
    // Wipe complete — clean up
    wipeActive = false;
    wipeStartBuffer = null;
    wipeEndBuffer = null;
    columnY = [];
  }

  return done;
}
