// ============================================================
// G-Buffer for Deferred Software Rendering
// Stores per-pixel material data from Pass 1 (geometry).
// Pass 2 (lighting resolve) reads this to produce final RGBA.
// ============================================================

/** Surface type flags */
export const enum SurfaceType {
  NONE    = 0,  // not drawn (background / cleared)
  WALL    = 1,
  FLOOR   = 2,
  CEILING = 3,
  SPRITE  = 4,
  SKY     = 5,
  PSPRITE = 6,  // weapon overlay — lit uniformly by player-position light
  FUZZ    = 7,  // spectre / partial invisibility fuzz effect
}

/**
 * G-Buffer — per-pixel geometry data.
 * Written by deferred draw functions (Pass 1).
 * Read by resolveGBuffer (Pass 2) and post-process passes.
 */
export class GBuffer {
  width = 0;
  height = 0;

  /** Palette index (0-255) — which texture pixel */
  paletteIdx!: Uint8Array;

  /** Colormap/light level (0-63) — sector + distance based */
  lightLevel!: Uint8Array;

  /** World X position (fixed_t) */
  worldX!: Int32Array;

  /** World Y position (fixed_t) */
  worldY!: Int32Array;

  /** World Z position (fixed_t) */
  worldZ!: Int32Array;

  /** Surface type (SurfaceType enum) */
  flags!: Uint8Array;

  constructor(w: number, h: number) {
    this.resize(w, h);
  }

  /** Allocate/reallocate all buffers */
  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    const size = w * h;
    this.paletteIdx = new Uint8Array(size);
    this.lightLevel = new Uint8Array(size);
    this.worldX = new Int32Array(size);
    this.worldY = new Int32Array(size);
    this.worldZ = new Int32Array(size);
    this.flags = new Uint8Array(size);
  }

  /**
   * Clear for new frame. Only flags needs clearing — resolve and
   * dynlights check flags before reading other buffers, and all
   * buffers are overwritten when flags is set to a surface type.
   */
  clear(): void {
    this.flags.fill(SurfaceType.NONE);
  }
}

/** Global G-Buffer instance (created on init, resized with resolution) */
export let gBuffer: GBuffer = new GBuffer(320, 200);

/** Initialize or resize the global G-Buffer */
export function initGBuffer(w: number, h: number): void {
  if (gBuffer.width !== w || gBuffer.height !== h) {
    gBuffer.resize(w, h);
  }
}
