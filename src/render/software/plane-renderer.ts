// ============================================================
// PlaneRenderer — Visplane Management & Floor/Ceiling Drawing
// Extracted from renderer.ts (R_FindPlane, R_CheckPlane,
// R_MakeSpans / R_DrawPlanes)
// ============================================================

import {
  FRACBITS, FRACUNIT, fixedDiv, fixedMul,
  ANGLETOFINESHIFT, FINEANGLES, FINEMASK,
  finesine, finecosine,
} from '../../../game/math';
import {
  SCREENWIDTH, SCREENHEIGHT, rgbaBuffer, zBuffer,
  ZFLAG_WALL, Z_DEPTH_MASK,
} from './draw';
import { gBuffer, SurfaceType } from './gbuffer';
import { getAnimatedFlat } from '../../../game/animations';
import type { Sector } from '../../map';
import type { RenderContext, Visplane } from './render-context';
import {
  SKY_FLAT_NAME, LIGHTLEVELS, LIGHTSEGSHIFT,
  MAXLIGHTZ, LIGHTZSHIFT,
} from './render-context';

/**
 * Manages visplanes (floor/ceiling spans) and draws them.
 */
export class PlaneRenderer {
  // ---- Visplane lookup ----

  /**
   * Find an existing matching visplane or create a new one.
   * Equivalent to R_FindPlane.
   */
  findOrCreate(ctx: RenderContext, sector: Sector, isCeiling: boolean): Visplane {
    const height = isCeiling ? sector.ceilingHeight : sector.floorHeight;
    const picnum = isCeiling ? sector.ceilingPic : sector.floorPic;
    const lightlevel = sector.lightLevel;

    const isSky = ctx.texData.flatList[picnum]?.name === SKY_FLAT_NAME;
    const matchHeight = isSky ? 0 : height;
    const matchLight = isSky ? 0 : lightlevel;

    for (const vp of ctx.visplanes) {
      if (vp.height === matchHeight && vp.picnum === picnum &&
          vp.lightlevel === matchLight && vp.isCeiling === isCeiling) {
        return vp;
      }
    }

    const vp = ctx.allocVisplane();
    vp.height = matchHeight;
    vp.picnum = picnum;
    vp.lightlevel = matchLight;
    vp.isCeiling = isCeiling;
    vp.minx = SCREENWIDTH;
    vp.maxx = -1;
    vp.top.fill(0x7FFF);
    vp.bottom.fill(-1);
    ctx.visplanes.push(vp);
    return vp;
  }

  /**
   * Check if we can extend the visplane to cover [start, stop].
   * If there's a conflict, allocate a new one. Equivalent to R_CheckPlane.
   */
  check(ctx: RenderContext, vp: Visplane, start: number, stop: number): Visplane {
    if (start < vp.minx || stop > vp.maxx) {
      const intrl = Math.max(start, vp.minx);
      const intrh = Math.min(stop, vp.maxx);

      let hasConflict = false;
      for (let x = intrl; x <= intrh; x++) {
        if (vp.top[x] !== 0x7FFF) { hasConflict = true; break; }
      }

      if (!hasConflict) {
        if (start < vp.minx) vp.minx = start;
        if (stop > vp.maxx) vp.maxx = stop;
        return vp;
      }
    } else {
      let hasConflict = false;
      for (let x = start; x <= stop; x++) {
        if (vp.top[x] !== 0x7FFF) { hasConflict = true; break; }
      }
      if (!hasConflict) return vp;
    }

    // Conflict: clone properties into new visplane
    const newVp = ctx.allocVisplane();
    newVp.height = vp.height;
    newVp.picnum = vp.picnum;
    newVp.lightlevel = vp.lightlevel;
    newVp.isCeiling = vp.isCeiling;
    newVp.minx = start;
    newVp.maxx = stop;
    newVp.top.fill(0x7FFF);
    newVp.bottom.fill(-1);
    ctx.visplanes.push(newVp);
    return newVp;
  }

  /**
   * Register a pixel span for a visplane.
   * Equivalent to R_MakeSpans writing to the current floor/ceiling visplane.
   */
  addPixel(ctx: RenderContext, isCeiling: boolean, x: number, top: number, bottom: number): void {
    if (top > bottom || x < 0 || x >= SCREENWIDTH) return;
    const vp = isCeiling ? ctx.curCeilingplane : ctx.curFloorplane;
    if (!vp) return;
    if (x < vp.minx) vp.minx = x;
    if (x > vp.maxx) vp.maxx = x;
    vp.top[x] = Math.max(0, top);
    vp.bottom[x] = Math.min(ctx.viewheight - 1, bottom);
  }

  // ---- Drawing ----

  /**
   * Draw all visplanes: floors, ceilings, and sky.
   */
  drawAll(ctx: RenderContext): void {
    ctx.ensurePlaneRowTables();

    for (const vp of ctx.visplanes) {
      if (vp.maxx < vp.minx) continue;

      const flatName = ctx.texData.flatList[vp.picnum]?.name;
      if (flatName === SKY_FLAT_NAME) {
        this.drawSky(ctx, vp);
        continue;
      }

      const animatedPicnum = getAnimatedFlat(vp.picnum, ctx.gi);
      const flat = ctx.texData.flatList[animatedPicnum];
      if (!flat) continue;

      const planeheight = Math.abs(vp.height - ctx.viewz);
      const lightnum = Math.max(0, Math.min(LIGHTLEVELS - 1, (vp.lightlevel >> LIGHTSEGSHIFT) | 0));
      const surfaceType = vp.isCeiling ? SurfaceType.CEILING : SurfaceType.FLOOR;
      const flatData = flat.data;
      const vpHeight = vp.height;
      const g = gBuffer;

      // Precompute per-row values
      let globalMinY = ctx.viewheight;
      let globalMaxY = 0;
      for (let x = vp.minx; x <= vp.maxx; x++) {
        if (vp.top[x] <= vp.bottom[x]) {
          if (vp.top[x] < globalMinY) globalMinY = vp.top[x];
          if (vp.bottom[x] > globalMaxY) globalMaxY = vp.bottom[x];
        }
      }
      if (globalMinY > globalMaxY) continue;
      if (globalMinY < 0) globalMinY = 0;
      if (globalMaxY >= ctx.viewheight) globalMaxY = ctx.viewheight - 1;

      // Pitch shear offset for yslope lookup
      const pitchShearPx = Math.round(ctx.viewpitch * (ctx.viewheight >> 1) / FRACUNIT);

      for (let y = globalMinY; y <= globalMaxY; y++) {
        const dy = y - ctx.centery - pitchShearPx;
        if (dy === 0) {
          ctx.planeRowValid[y] = 0;
          continue;
        }
        // Use unshifted y for yslope lookup (table is relative to base center)
        const yslopeIdx = y - pitchShearPx;
        let yslopeVal: number;
        if (yslopeIdx >= 0 && yslopeIdx < ctx.viewheight) {
          yslopeVal = ctx.yslope[yslopeIdx] || 0;
        } else {
          // Compute yslope dynamically for rows beyond precomputed table (pitch shear extends view)
          let dynDy = (((yslopeIdx - ctx.viewheight / 2) * FRACUNIT + (FRACUNIT >> 1)) | 0);
          dynDy = Math.abs(dynDy);
          if (dynDy < 1) dynDy = 1;
          yslopeVal = fixedDiv((ctx.viewwidth / 2) * FRACUNIT, dynDy);
        }
        const distance = Math.abs(fixedMul(planeheight, yslopeVal));
        if (distance === 0) {
          ctx.planeRowValid[y] = 0;
          continue;
        }
        ctx.planeRowValid[y] = 1;
        ctx.planeRowDistance[y] = distance;
        ctx.planeRowFloorScale[y] = fixedDiv(ctx.projection, distance);
        let zIdx = (distance >>> LIGHTZSHIFT) | 0;
        if (zIdx >= MAXLIGHTZ) zIdx = MAXLIGHTZ - 1;
        ctx.planeRowColormapIdx[y] = ctx.zlight[lightnum]?.[zIdx] ?? 0;
      }

      // Column iteration
      for (let x = vp.minx; x <= vp.maxx; x++) {
        const t = vp.top[x];
        const b = vp.bottom[x];
        if (t > b) continue;

        const distscaleX = ctx.distscale[x] || FRACUNIT;
        const viewAngleFine = ((ctx.viewangle + (ctx.xtoviewangle[x] || 0)) >>> ANGLETOFINESHIFT) & FINEMASK;
        const cosVal = finecosine(viewAngleFine);
        const sinVal = finesine[viewAngleFine] || 0;

        for (let y = t; y <= b; y++) {
          if (y < 0 || y >= ctx.viewheight || !ctx.planeRowValid[y]) continue;

          const distance = ctx.planeRowDistance[y];
          const floorScale = ctx.planeRowFloorScale[y];

          const dest = y * SCREENWIDTH + x;
          const existingZ = zBuffer[dest];
          if ((existingZ & ZFLAG_WALL) && (existingZ & Z_DEPTH_MASK) > floorScale) continue;

          const length = fixedMul(distance, distscaleX);
          const xfrac = ctx.viewx + fixedMul(cosVal, length);
          const yfrac = -ctx.viewy - fixedMul(sinVal, length);

          const tx = ((xfrac >> FRACBITS) & 63);
          const ty = ((yfrac >> FRACBITS) & 63);
          const pixel = flatData[(ty * 64 + tx) & 4095] || 0;

          g.paletteIdx[dest] = pixel;
          g.lightLevel[dest] = ctx.planeRowColormapIdx[y];
          g.worldX[dest] = xfrac;
          g.worldY[dest] = -yfrac;
          g.worldZ[dest] = vpHeight;
          g.flags[dest] = surfaceType;
          zBuffer[dest] = floorScale;
        }
      }
    }
  }

  private drawSky(ctx: RenderContext, vp: Visplane): void {
    const skyTex = ctx.texData.textures[ctx.skytexture];
    const lookup = ctx.palData.getColormapLookup(0);
    // Pitch offset: sky scrolls vertically with freelook
    const pitchShearPx = Math.round(ctx.viewpitch * (ctx.viewheight >> 1) / FRACUNIT);

    for (let x = vp.minx; x <= vp.maxx; x++) {
      const t = vp.top[x];
      const b = vp.bottom[x];
      if (t > b) continue;

      if (skyTex) {
        const angle = ((ctx.viewangle + ctx.xtoviewangle[x]) >>> 0);
        const col = ((angle >>> ANGLETOFINESHIFT) * skyTex.width / FINEANGLES) | 0;
        const texCol = skyTex.columns[((col % skyTex.width) + skyTex.width) % skyTex.width];
        if (texCol) {
          for (let y = t; y <= b; y++) {
            if (y >= 0 && y < ctx.viewheight) {
              const texY = (((y - pitchShearPx) * skyTex.height / ctx.viewheight) | 0) % skyTex.height;
              const pixel = texCol[(texY + skyTex.height) % skyTex.height] || 0;
              rgbaBuffer[y * SCREENWIDTH + x] = lookup[pixel];
            }
          }
          continue;
        }
      }

      for (let y = t; y <= b; y++) {
        if (y >= 0 && y < ctx.viewheight) {
          rgbaBuffer[y * SCREENWIDTH + x] = 0xFF200020;
        }
      }
    }
  }
}
