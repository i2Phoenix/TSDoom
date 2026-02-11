// ============================================================
// Low-Level Drawing Primitives
// Reference: r_draw.c — column drawing, span drawing
// ============================================================

import { FRACBITS, FRACUNIT, fixedMul } from '../math';
import { gBuffer, SurfaceType } from './gbuffer';

// Screen dimensions — mutable, changed via setResolution()
export let SCREENWIDTH = 320;
export let SCREENHEIGHT = 200;

// Output: RGBA pixel buffer for Canvas ImageData
export let rgbaBuffer = new Uint32Array(SCREENWIDTH * SCREENHEIGHT);

// Unified per-pixel depth buffer (projection scale; 0 = nothing / infinitely far).
// Higher value = closer to camera. Written by walls, floors, ceilings, sprites.
// Read for Z-testing (floors vs walls, sprites vs walls) and for debug visualization.
//
// Convention for sprite Z-testing:
//   Bit 30 (ZFLAG_WALL) marks wall pixels. Sprites only Z-test against wall pixels,
//   not floors/ceilings. This prevents sprites from "sinking into" floors that are
//   geometrically closer to the camera than the sprite.
//   Depth value = zBuffer[i] & Z_DEPTH_MASK.
export let zBuffer = new Int32Array(SCREENWIDTH * SCREENHEIGHT);

export const ZFLAG_WALL = 0x40000000;    // bit 30: this pixel is a wall
export const Z_DEPTH_MASK = 0x3FFFFFFF;  // bits 0-29: actual depth value

/** Change the render resolution and reallocate buffers */
export function setResolution(width: number, height: number): void {
  SCREENWIDTH = width;
  SCREENHEIGHT = height;
  rgbaBuffer = new Uint32Array(width * height);
  zBuffer = new Int32Array(width * height);
}

// Column drawing parameters (set before calling drawColumn)
export const dc = {
  colormap: null as Uint32Array | null,  // light-level lookup (palette idx -> RGBA)
  x: 0,
  yl: 0,        // top of column to draw
  yh: 0,        // bottom of column
  textureMid: 0, // fixed_t: texture y offset base
  iscale: 0,    // fixed_t: inverse scale (texels per screen pixel)
  source: null as Uint8Array | null, // column pixel data
  sourceLength: 0,
  centery: 100,  // set by renderer (viewheight / 2)
  // Deferred rendering context (set by renderer for G-Buffer writes)
  colormapIdx: 0,      // light level index (0-63)
  surfaceType: SurfaceType.WALL as SurfaceType,
  worldX: 0,           // fixed_t — world X of this column
  worldY: 0,           // fixed_t — world Y of this column
  worldTopZ: 0,        // fixed_t — world Z at top of column
  worldBottomZ: 0,     // fixed_t — world Z at bottom of column
};

// Span drawing parameters
export const ds = {
  colormap: null as Uint32Array | null,
  y: 0,
  x1: 0,
  x2: 0,
  xfrac: 0,     // fixed_t
  yfrac: 0,
  xstep: 0,     // fixed_t
  ystep: 0,
  source: null as Uint8Array | null,
};

// Current Z-scale for depth buffer writes (set by renderer before draw calls)
export let zScale = 0;
export function setZScale(s: number): void { zScale = s; }

/** Draw a textured vertical column (walls) */
export function drawColumn(): void {
  const { colormap, x, yl, yh, textureMid, iscale, source, sourceLength } = dc;
  if (!colormap || !source || yl > yh) return;
  
  const count = yh - yl + 1;
  if (count <= 0) return;

  let dest = yl * SCREENWIDTH + x;
  let frac = textureMid + (yl - dc.centery) * iscale;
  const z = (zScale & Z_DEPTH_MASK) | ZFLAG_WALL; // wall pixel with depth

  for (let i = 0; i < count; i++) {
    let texY = (frac >> FRACBITS) & 0x7F;
    if (sourceLength > 0) {
      texY = texY % sourceLength;
      if (texY < 0) texY += sourceLength;
    }
    
    const pixel = source[texY] || 0;
    rgbaBuffer[dest] = colormap[pixel];
    zBuffer[dest] = z;
    
    dest += SCREENWIDTH;
    frac += iscale;
  }
}

/** Draw a solid-color vertical column (for untextured walls) */
export function drawColumnSolid(color: number): void {
  const { x, yl, yh } = dc;
  const count = yh - yl + 1;
  if (count <= 0) return;

  let dest = yl * SCREENWIDTH + x;
  const z = (zScale & Z_DEPTH_MASK) | ZFLAG_WALL;
  for (let i = 0; i < count; i++) {
    rgbaBuffer[dest] = color;
    zBuffer[dest] = z;
    dest += SCREENWIDTH;
  }
}

/** Draw a textured horizontal span (for floors/ceilings) */
export function drawSpan(): void {
  const { colormap, y, x1, x2, source } = ds;
  if (!colormap || !source) return;
  
  const count = x2 - x1 + 1;
  if (count <= 0) return;

  let dest = y * SCREENWIDTH + x1;
  let xfrac = ds.xfrac;
  let yfrac = ds.yfrac;

  for (let i = 0; i < count; i++) {
    // 64x64 flat texture
    const spot = ((yfrac >> 10) & 0xFC0) | ((xfrac >> FRACBITS) & 63);
    const pixel = source[spot & 4095];
    rgbaBuffer[dest] = colormap[pixel];
    
    dest++;
    xfrac += ds.xstep;
    yfrac += ds.ystep;
  }
}

/** Clear screen to black and reset depth buffer */
export function clearScreen(): void {
  rgbaBuffer.fill(0xFF000000); // opaque black
  zBuffer.fill(0);             // no depth (infinitely far)
}

/** Draw a vertical column of a single palette color (for fuzz/spectre) */
export function drawFuzzColumn(): void {
  const { x, yl, yh } = dc;
  const count = yh - yl + 1;
  if (count <= 0) return;

  let dest = yl * SCREENWIDTH + x;
  const z = (zScale & Z_DEPTH_MASK) | ZFLAG_WALL;
  for (let i = 0; i < count; i++) {
    const existing = rgbaBuffer[dest];
    const r = ((existing & 0xFF) >> 1);
    const g = (((existing >> 8) & 0xFF) >> 1);
    const b = (((existing >> 16) & 0xFF) >> 1);
    rgbaBuffer[dest] = (255 << 24) | (b << 16) | (g << 8) | r;
    zBuffer[dest] = z;
    dest += SCREENWIDTH;
  }
}

// ============================================================
// Deferred Drawing Primitives (G-Buffer output)
// Write material data instead of final RGBA.
// ============================================================

/** Deferred: draw a textured wall column to G-Buffer */
export function drawColumnDeferred(): void {
  const { x, yl, yh, textureMid, iscale, source, sourceLength,
          colormapIdx, surfaceType, worldX, worldY, worldTopZ, worldBottomZ } = dc;
  if (!source || yl > yh) return;

  const count = yh - yl + 1;
  if (count <= 0) return;

  const g = gBuffer;
  let dest = yl * SCREENWIDTH + x;
  let frac = textureMid + (yl - dc.centery) * iscale;
  const z = (zScale & Z_DEPTH_MASK) | ZFLAG_WALL;

  // Z interpolation: top -> bottom of column
  const zRange = worldBottomZ - worldTopZ;
  const zStep = count > 1 ? (zRange / (count - 1)) | 0 : 0;
  let wz = worldTopZ;

  for (let i = 0; i < count; i++) {
    let texY = (frac >> FRACBITS) & 0x7F;
    if (sourceLength > 0) {
      texY = texY % sourceLength;
      if (texY < 0) texY += sourceLength;
    }

    const pixel = source[texY] || 0;

    // Write to G-Buffer
    g.paletteIdx[dest] = pixel;
    g.lightLevel[dest] = colormapIdx;
    g.worldX[dest] = worldX;
    g.worldY[dest] = worldY;
    g.worldZ[dest] = wz;
    g.flags[dest] = surfaceType;

    // Keep zBuffer for occlusion (sprites need it)
    zBuffer[dest] = z;

    dest += SCREENWIDTH;
    frac += iscale;
    wz += zStep;
  }
}

/**
 * Deferred: draw a masked (transparent) wall column to G-Buffer.
 * Skips pixels where mask[texY] === 0 (transparent parts of texture).
 * Used for midtextures on two-sided linedefs (fences, grates, bars).
 * Reference: R_DrawMaskedColumn in r_things.c
 */
export function drawMaskedColumnDeferred(mask: Uint8Array): void {
  const { x, yl, yh, textureMid, iscale, source, sourceLength,
          colormapIdx, surfaceType, worldX, worldY, worldTopZ, worldBottomZ } = dc;
  if (!source || yl > yh) return;

  const count = yh - yl + 1;
  if (count <= 0) return;

  const g = gBuffer;
  let dest = yl * SCREENWIDTH + x;
  let frac = textureMid + (yl - dc.centery) * iscale;
  const z = (zScale & Z_DEPTH_MASK) | ZFLAG_WALL;

  const zRange = worldBottomZ - worldTopZ;
  const zStep = count > 1 ? (zRange / (count - 1)) | 0 : 0;
  let wz = worldTopZ;

  for (let i = 0; i < count; i++) {
    let texY = (frac >> FRACBITS) & 0x7F;
    if (sourceLength > 0) {
      texY = texY % sourceLength;
      if (texY < 0) texY += sourceLength;
    }

    // Only draw opaque pixels (skip transparent)
    if (mask[texY]) {
      const pixel = source[texY] || 0;

      g.paletteIdx[dest] = pixel;
      g.lightLevel[dest] = colormapIdx;
      g.worldX[dest] = worldX;
      g.worldY[dest] = worldY;
      g.worldZ[dest] = wz;
      g.flags[dest] = surfaceType;
      zBuffer[dest] = z;
    }

    dest += SCREENWIDTH;
    frac += iscale;
    wz += zStep;
  }
}

/** Deferred: draw a solid-color column to G-Buffer (untextured walls) */
export function drawColumnSolidDeferred(paletteIdx: number): void {
  const { x, yl, yh, colormapIdx, surfaceType, worldX, worldY, worldTopZ, worldBottomZ } = dc;
  const count = yh - yl + 1;
  if (count <= 0) return;

  const g = gBuffer;
  let dest = yl * SCREENWIDTH + x;
  const z = (zScale & Z_DEPTH_MASK) | ZFLAG_WALL;
  const zRange = worldBottomZ - worldTopZ;
  const zStep = count > 1 ? (zRange / (count - 1)) | 0 : 0;
  let wz = worldTopZ;

  for (let i = 0; i < count; i++) {
    g.paletteIdx[dest] = paletteIdx;
    g.lightLevel[dest] = colormapIdx;
    g.worldX[dest] = worldX;
    g.worldY[dest] = worldY;
    g.worldZ[dest] = wz;
    g.flags[dest] = surfaceType;
    zBuffer[dest] = z;

    dest += SCREENWIDTH;
    wz += zStep;
  }
}

/**
 * Deferred: write a single floor/ceiling pixel to G-Buffer.
 * Called per-pixel from drawPlanes() in renderer.ts.
 */
export function writeGBufferFloorPixel(
  dest: number, pixel: number, lightLvl: number,
  wx: number, wy: number, wz: number,
  surface: SurfaceType
): void {
  const g = gBuffer;
  g.paletteIdx[dest] = pixel;
  g.lightLevel[dest] = lightLvl;
  g.worldX[dest] = wx;
  g.worldY[dest] = wy;
  g.worldZ[dest] = wz;
  g.flags[dest] = surface;
}

/**
 * Deferred: write a single sprite pixel to G-Buffer.
 * Called per-pixel from drawVisSprite() in renderer.ts.
 */
export function writeGBufferSpritePixel(
  dest: number, pixel: number, lightLvl: number,
  wx: number, wy: number, wz: number
): void {
  const g = gBuffer;
  g.paletteIdx[dest] = pixel;
  g.lightLevel[dest] = lightLvl;
  g.worldX[dest] = wx;
  g.worldY[dest] = wy;
  g.worldZ[dest] = wz;
  g.flags[dest] = SurfaceType.SPRITE;
}
