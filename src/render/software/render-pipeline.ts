// ============================================================
// RenderPipeline — Orchestrates the Software Rendering Pipeline
// Composes all extracted stages into a coherent frame loop.
// Replaces the old 2300-line monolithic renderer.ts.
// ============================================================

import type { GameMap } from '../../map';
import type { TextureData } from '../../textures';
import type { PaletteData } from '../../palette';
import type { WAD } from '../../wad';
import { RenderContext, type RenderMode } from './render-context';
import { ViewSetup } from './view-setup';
import { BSPTraverser } from './bsp-traverser';
import { WallRenderer } from './wall-renderer';
import { PlaneRenderer } from './plane-renderer';
import { SpriteRenderer } from './sprite-renderer';
import { WeaponOverlay } from './weapon-overlay';
import { SpriteData } from './sprites';
import { initGBuffer, gBuffer, SurfaceType } from './gbuffer';
import {
  SCREENWIDTH, SCREENHEIGHT, rgbaBuffer, zBuffer, Z_DEPTH_MASK,
  clearScreen, dc,
} from './draw';
import type { GameInstance } from '../../../game/game-instance';
import { FRACBITS } from '../../../game/math';

// ---- Fuzz effect (classic DOOM R_DrawFuzzColumn) ----
const FUZZOFFSET = [
   1, -1,  1, -1,  1,  1, -1,
   1,  1, -1,  1,  1,  1, -1,
   1,  1,  1, -1, -1, -1, -1,
   1, -1, -1,  1,  1,  1,  1, -1,
   1, -1,  1,  1, -1, -1,  1,
   1, -1, -1, -1, -1,  1,  1,
   1,  1, -1,  1,  1, -1,
];

/**
 * RenderPipeline composes all rendering stages.
 * The WallRenderer implements SegCollector, serving as the
 * bridge between BSP traversal and wall/sprite rendering.
 */
export class RenderPipeline {
  readonly view: ViewSetup;
  readonly bsp: BSPTraverser;
  readonly walls: WallRenderer;
  readonly planes: PlaneRenderer;
  readonly sprites: SpriteRenderer;
  readonly weapon: WeaponOverlay;
  readonly ctx: RenderContext;

  constructor() {
    this.ctx = new RenderContext();
    this.view = new ViewSetup();
    this.bsp = new BSPTraverser();
    this.planes = new PlaneRenderer();
    this.sprites = new SpriteRenderer();
    this.walls = new WallRenderer(this.planes, this.sprites);
    this.weapon = new WeaponOverlay();
  }

  // ---- Initialization (once per level load) ----

  init(map: GameMap, texData: TextureData, palData: PaletteData, wad?: WAD): void {
    const ctx = this.ctx;
    ctx.map = map;
    ctx.texData = texData;
    ctx.palData = palData;
    if (wad) ctx.wad = wad;
    ctx.numColormaps = palData.numColormaps;
    ctx.skytexture = texData.textureMap.get('SKY1') ?? 0;

    initGBuffer(SCREENWIDTH, SCREENHEIGHT);
    ctx.initVisplanePool();

    if (ctx.wad) ctx.spriteData = new SpriteData(ctx.wad, texData);

    // Recompute resolution-dependent view params (yslope, arrays, etc.)
    this.view.init(ctx);
    dc.centery = ctx.centery;
  }

  // ---- Per-frame rendering ----

  renderFrame(gi: GameInstance): void {
    const ctx = this.ctx;
    ctx.gi = gi;

    // Pass 1: Clear
    clearScreen();
    gBuffer.clear();
    ctx.resetFrame();

    // Update dc.centery from pitch-adjusted centeryfrac (for wall texture mapping)
    dc.centery = ctx.centeryfrac >> FRACBITS;

    // Build subsector → sprite maps (runtime positions)
    this.sprites.buildSubsectorMaps(ctx);

    // Pass 2: BSP traversal (wall segs + sprite projection)
    this.bsp.traverse(ctx, this.walls);

    // Pass 3: Visplanes (floors/ceilings)
    this.planes.drawAll(ctx);

    // Pass 4: Masked midtextures (fences, grates)
    this.walls.drawMaskedMidTextures(ctx);

    // Pass 5: Sprites (sorted back-to-front)
    this.sprites.drawAll(ctx);

    ctx.debugFrame++;
  }

  // ---- G-Buffer Resolve (deferred → final RGBA) ----

  resolve(): void {
    this.resolveGBuffer();
    this.resolveFuzzPixels();
    if (this.ctx.renderMode === 'depth') {
      this.renderDepthOverlay();
    }
  }

  /**
   * Resolve G-Buffer to rgbaBuffer (Pass 2 of deferred rendering).
   * Reads paletteIdx + lightLevel from G-Buffer, applies colormap
   * with extralight offset, writes final RGBA.
   */
  private resolveGBuffer(): void {
    const len = SCREENWIDTH * SCREENHEIGHT;
    const g = gBuffer;
    const ctx = this.ctx;
    const lightShift = ctx.extralight * 4;

    for (let i = 0; i < len; i++) {
      const surface = g.flags[i];
      if (surface === SurfaceType.NONE || surface === SurfaceType.SKY) continue;

      const paletteIdx = g.paletteIdx[i];
      let lightLvl = g.lightLevel[i] - lightShift;
      if (lightLvl < 0) lightLvl = 0;
      const colormap = ctx.palData.getColormapLookup(lightLvl);
      rgbaBuffer[i] = colormap[paletteIdx];
    }
  }

  /**
   * Resolve fuzz (Spectre/invisibility) pixels — Pass 2b.
   * Must be called AFTER resolveGBuffer so that surrounding pixels
   * have valid RGBA values to sample from.
   */
  private resolveFuzzPixels(): void {
    const len = SCREENWIDTH * SCREENHEIGHT;
    const g = gBuffer;
    const ctx = this.ctx;

    for (let i = 0; i < len; i++) {
      if (g.flags[i] !== SurfaceType.FUZZ) continue;

      const offset = FUZZOFFSET[ctx.fuzzpos] * SCREENWIDTH;
      ctx.fuzzpos = (ctx.fuzzpos + 1) % FUZZOFFSET.length;

      let srcIdx = i + offset;
      if (srcIdx < 0) srcIdx = 0;
      if (srcIdx >= len) srcIdx = len - 1;

      const existing = rgbaBuffer[srcIdx];
      const r = ((existing & 0xFF) >> 1);
      const g2 = (((existing >> 8) & 0xFF) >> 1);
      const b = (((existing >> 16) & 0xFF) >> 1);
      rgbaBuffer[i] = (255 << 24) | (b << 16) | (g2 << 8) | r;
    }
  }

  /** Convert Z-buffer to grayscale image for depth visualization mode */
  private renderDepthOverlay(): void {
    const size = SCREENWIDTH * this.ctx.viewheight;
    let maxZ = 1;
    for (let i = 0; i < size; i++) {
      const d = zBuffer[i] & Z_DEPTH_MASK;
      if (d > maxZ) maxZ = d;
    }
    for (let i = 0; i < size; i++) {
      const z = zBuffer[i] & Z_DEPTH_MASK;
      if (z === 0) {
        rgbaBuffer[i] = 0xFF000000;
      } else {
        const b = Math.min(255, (z * 255 / maxZ) | 0);
        rgbaBuffer[i] = 0xFF000000 | (b << 16) | (b << 8) | b;
      }
    }
  }

  // ---- Render mode ----

  cycleRenderMode(): void {
    this.ctx.renderMode = this.ctx.renderMode === 'normal' ? 'depth' : 'normal';
  }

  getRenderMode(): RenderMode {
    return this.ctx.renderMode;
  }

  // ---- Light tables ----

  rebuildLightTables(): void {
    if (!this.ctx.palData) return;
    this.ctx.numColormaps = this.ctx.palData.numColormaps;
    this.view.initLightTables(this.ctx);
  }

  // ---- Resolution change ----

  setResolution(): void {
    this.view.init(this.ctx);
    dc.centery = this.ctx.centery;
    initGBuffer(SCREENWIDTH, SCREENHEIGHT);
  }
}
