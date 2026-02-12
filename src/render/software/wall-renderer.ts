// ============================================================
// WallRenderer — Seg → Column Drawing
// Extracted from renderer.ts (R_StoreWallRange, R_RenderSegLoop,
// R_RenderMaskedSegRange)
// Implements SegCollector for BSPTraverser.
// ============================================================

import {
  FRACBITS, FRACUNIT, ANG90, ANG180,
  ANGLETOFINESHIFT, FINEANGLES, FINEMASK,
  fixedDiv, fixedMul,
  finesine, finecosine, finetangent,
} from '../../../game/math';
import { getAnimatedTexture } from '../../../game/animations';
import {
  SCREENWIDTH, dc, setZScale,
  drawColumnDeferred, drawMaskedColumnDeferred,
} from '../draw';
import { SurfaceType } from '../gbuffer';
import type { Seg, Sector } from '../../map';
import type { SegCollector } from './bsp-traverser';
import type { PlaneRenderer } from './plane-renderer';
import type { SpriteRenderer } from './sprite-renderer';
import type { RenderContext } from './render-context';
import {
  SKY_FLAT_NAME,
  LIGHTLEVELS, LIGHTSEGSHIFT,
  MAXLIGHTSCALE, LIGHTSCALESHIFT,
  MAXDRAWSEGS,
} from './render-context';

/**
 * WallRenderer draws wall columns and records drawsegs for
 * masked midtextures. Implements SegCollector so the BSPTraverser
 * can call storeWallRange directly.
 */
export class WallRenderer implements SegCollector {
  constructor(
    private planes: PlaneRenderer,
    private sprites: SpriteRenderer,
  ) {}

  // ---- SegCollector interface ----

  storeWallRange(start: number, stop: number, seg: Seg, ctx: RenderContext): void {
    if (start > stop) return;
    ctx.debugCounters.storeWallCalls++;

    const frontsector = seg.frontsector;
    const backsector = seg.backsector;

    // Normal angle and distance
    const rw_normalangle = (seg.angle + ANG90) >>> 0;

    // Perpendicular distance to the seg
    const dx = (seg.v1.x - ctx.viewx) || 0;
    const dy = (seg.v1.y - ctx.viewy) || 0;
    const hyp = Math.hypot(dx, dy) | 0;

    let offsetangle = ((rw_normalangle - ctx.rwAngle1) >>> 0);
    if (offsetangle > ANG180) offsetangle = ((-offsetangle) >>> 0);
    if (offsetangle > ANG90) offsetangle = ANG90;

    const distangle = ((ANG90 - offsetangle) >>> 0);
    const sinIdx = (distangle >>> ANGLETOFINESHIFT) & FINEMASK;
    const sinNorm = finesine[sinIdx] || 0;
    let rw_distance = sinNorm !== 0 ? Math.abs(fixedMul(hyp, sinNorm)) : (hyp || 1);
    if (rw_distance < 1) rw_distance = 1;

    // Scale at endpoints
    let rw_scale = this.scaleFromGlobalAngle(ctx, start, rw_normalangle, rw_distance);
    if (rw_scale < 64) rw_scale = 64;
    if (rw_scale > 64 * FRACUNIT) rw_scale = 64 * FRACUNIT;

    let rw_scalestep = 0;
    if (stop > start) {
      let scale2 = this.scaleFromGlobalAngle(ctx, stop, rw_normalangle, rw_distance);
      if (scale2 < 64) scale2 = 64;
      if (scale2 > 64 * FRACUNIT) scale2 = 64 * FRACUNIT;
      rw_scalestep = ((scale2 - rw_scale) / (stop - start)) | 0;
    }

    // World heights relative to view
    let worldtop = frontsector.ceilingHeight - ctx.viewz;
    const worldbottom = frontsector.floorHeight - ctx.viewz;

    // Setup textures
    const sidedef = seg.sidedef;
    let midtexture = 0;
    let toptexture = 0;
    let bottomtexture = 0;
    let markfloor = true;
    let markceiling = true;
    let rw_midtexturemid = 0;
    let rw_toptexturemid = 0;
    let rw_bottomtexturemid = 0;
    let worldhigh = 0;
    let worldlow = 0;

    const isSkyFront = ctx.texData.flatList[frontsector.ceilingPic]?.name === SKY_FLAT_NAME;

    if (!backsector) {
      // One-sided line
      midtexture = getAnimatedTexture(sidedef.midTexture);
      const tex = ctx.texData.textures[midtexture];
      const texH = tex ? tex.height << FRACBITS : 0;

      if (seg.linedef.flags & 16) { // ML_DONTPEGBOTTOM
        rw_midtexturemid = frontsector.floorHeight + texH - ctx.viewz;
      } else {
        rw_midtexturemid = worldtop;
      }
      rw_midtexturemid += sidedef.rowOffset;
    } else {
      // Two-sided line
      worldhigh = backsector.ceilingHeight - ctx.viewz;
      worldlow = backsector.floorHeight - ctx.viewz;

      const isSkyBack = ctx.texData.flatList[backsector.ceilingPic]?.name === SKY_FLAT_NAME;
      if (isSkyFront && isSkyBack) worldtop = worldhigh;

      if (worldhigh < worldtop) {
        toptexture = getAnimatedTexture(sidedef.topTexture);
        if (seg.linedef.flags & 8) { // ML_DONTPEGTOP
          rw_toptexturemid = worldtop;
        } else {
          const tex = ctx.texData.textures[toptexture];
          rw_toptexturemid = worldhigh + (tex ? tex.height << FRACBITS : 0);
        }
        rw_toptexturemid += sidedef.rowOffset;
      }

      if (worldlow > worldbottom) {
        bottomtexture = getAnimatedTexture(sidedef.bottomTexture);
        if (seg.linedef.flags & 16) { // ML_DONTPEGBOTTOM
          rw_bottomtexturemid = worldtop;
        } else {
          rw_bottomtexturemid = worldlow;
        }
        rw_bottomtexturemid += sidedef.rowOffset;
      }

      // Mark floor/ceiling
      if (worldlow !== worldbottom
          || backsector.floorPic !== frontsector.floorPic
          || backsector.lightLevel !== frontsector.lightLevel) {
        markfloor = true;
      } else {
        markfloor = false;
      }

      if (worldhigh !== worldtop
          || backsector.ceilingPic !== frontsector.ceilingPic
          || backsector.lightLevel !== frontsector.lightLevel) {
        markceiling = true;
      } else {
        markceiling = false;
      }

      // Closed door override
      if (backsector.ceilingHeight <= frontsector.floorHeight
          || backsector.floorHeight >= frontsector.ceilingHeight) {
        markceiling = markfloor = true;
      }
    }

    // Visibility culling
    if (frontsector.floorHeight >= ctx.viewz) {
      markfloor = false;
    }
    if (frontsector.ceilingHeight <= ctx.viewz && !isSkyFront) {
      markceiling = false;
    }

    // Light level
    const lightnum = Math.max(0, Math.min(LIGHTLEVELS - 1, (frontsector.lightLevel >> LIGHTSEGSHIFT) | 0));

    // Center angle for texture column mapping
    const rw_centerangle = (ANG90 + ctx.viewangle - rw_normalangle) >>> 0;

    // Base texture column offset
    const rwBaseOffset = this.calcTextureBaseOffset(ctx, seg, hyp, rw_normalangle);

    // Set up visplanes
    if (markceiling) {
      ctx.curCeilingplane = this.planes.check(ctx,
        this.planes.findOrCreate(ctx, frontsector, true), start, stop);
    } else {
      ctx.curCeilingplane = null;
    }
    if (markfloor) {
      ctx.curFloorplane = this.planes.check(ctx,
        this.planes.findOrCreate(ctx, frontsector, false), start, stop);
    } else {
      ctx.curFloorplane = null;
    }

    // Record drawseg for masked midtexture
    let maskedTexture = false;
    if (backsector && sidedef.midTexture !== 0) {
      maskedTexture = true;
    }

    let maskedTextureCol: Int16Array | null = null;
    if (maskedTexture) {
      maskedTextureCol = new Int16Array(SCREENWIDTH);
      maskedTextureCol.fill(0x7FFF);
    }

    // Render columns
    let scale = rw_scale;
    for (let x = start; x <= stop; x++) {
      this.renderColumn(
        ctx, x, seg, scale, frontsector, backsector,
        rwBaseOffset, rw_centerangle, rw_distance,
        midtexture, toptexture, bottomtexture,
        rw_midtexturemid, rw_toptexturemid, rw_bottomtexturemid,
        worldtop, worldbottom, worldhigh, worldlow,
        markfloor, markceiling, lightnum,
      );
      if (maskedTextureCol) {
        maskedTextureCol[x] = this.getTexColumn(ctx, x, rwBaseOffset, rw_centerangle, rw_distance);
      }
      scale += rw_scalestep;
    }

    // Store drawseg for masked midtexture
    if (maskedTexture && maskedTextureCol && ctx.drawsegs.length < MAXDRAWSEGS) {
      const sprTopClip = new Int16Array(SCREENWIDTH);
      const sprBottomClip = new Int16Array(SCREENWIDTH);
      sprTopClip.set(ctx.ceilingclip);
      sprBottomClip.set(ctx.floorclip);

      ctx.drawsegs.push({
        seg,
        x1: start,
        x2: stop,
        scale1: rw_scale,
        scale2: scale - rw_scalestep,
        scalestep: rw_scalestep,
        maskedTextureCol,
        sprTopClip,
        sprBottomClip,
      });
    }
  }

  visitSubsector(ssIdx: number, ctx: RenderContext): void {
    const ss = ctx.map.subsectors[ssIdx];
    if (ss?.sector && ctx.spriteData) {
      this.sprites.projectSubsector(ctx, ssIdx, ss.sector);
    }
  }

  // ---- Drawing passes (called after BSP traversal) ----

  /**
   * Draw masked midtextures (fences, grates, bars).
   * Reference: R_RenderMaskedSegRange in r_segs.c.
   */
  drawMaskedMidTextures(ctx: RenderContext): void {
    for (let dsIdx = ctx.drawsegs.length - 1; dsIdx >= 0; dsIdx--) {
      const ds = ctx.drawsegs[dsIdx];
      if (!ds.maskedTextureCol) continue;

      const seg = ds.seg;
      const frontsector = seg.frontsector;
      const backsector = seg.backsector;
      if (!backsector) continue;

      const texnum = getAnimatedTexture(seg.sidedef.midTexture);
      const tex = ctx.texData.textures[texnum];
      if (!tex) continue;

      const lightnum = Math.max(0, Math.min(LIGHTLEVELS - 1,
        (frontsector.lightLevel >> LIGHTSEGSHIFT) | 0));

      let textureMid: number;
      if (seg.linedef.flags & 16) { // ML_DONTPEGBOTTOM
        textureMid = Math.max(frontsector.floorHeight, backsector.floorHeight)
                     + (tex.height << FRACBITS) - ctx.viewz;
      } else {
        textureMid = Math.min(frontsector.ceilingHeight, backsector.ceilingHeight)
                     - ctx.viewz;
      }
      textureMid += seg.sidedef.rowOffset;

      let spryscale = ds.scale1;
      for (let x = ds.x1; x <= ds.x2; x++) {
        const textureColumn = ds.maskedTextureCol[x];
        if (textureColumn === 0x7FFF) {
          spryscale += ds.scalestep;
          continue;
        }

        if (spryscale < 64) spryscale = 64;
        const iscale = fixedDiv(FRACUNIT, spryscale);

        let lightIdx = (spryscale >> LIGHTSCALESHIFT) | 0;
        if (lightIdx >= MAXLIGHTSCALE) lightIdx = MAXLIGHTSCALE - 1;
        if (lightIdx < 0) lightIdx = 0;
        const colormapIdx = ctx.scalelight[lightnum]?.[lightIdx] ?? 0;

        const tcx = ((textureColumn % tex.width) + tex.width) % tex.width;

        const sprtopscreen = ctx.centeryfrac - fixedMul(textureMid, spryscale);
        const yl = ((sprtopscreen + FRACUNIT - 1) >> FRACBITS) | 0;
        const yh = ((sprtopscreen + fixedMul(tex.height << FRACBITS, spryscale) - 1) >> FRACBITS) | 0;

        const clipTop = ds.sprTopClip[x];
        const clipBottom = ds.sprBottomClip[x];

        const clippedYl = Math.max(yl, clipTop + 1);
        const clippedYh = Math.min(yh, clipBottom - 1);

        if (clippedYl <= clippedYh && x >= 0 && x < SCREENWIDTH) {
          setZScale(spryscale);

          const colAngle = (ctx.viewangle + (ctx.xtoviewangle[x] || 0)) >>> 0;
          const colAnIdx = (colAngle >>> ANGLETOFINESHIFT) & FINEMASK;
          const dist = spryscale > 0 ? fixedDiv(ctx.projection, spryscale) : (512 * FRACUNIT);

          dc.colormap = null;
          dc.x = x;
          dc.yl = clippedYl;
          dc.yh = clippedYh;
          dc.textureMid = textureMid;
          dc.iscale = iscale;
          dc.source = tex.columns[tcx];
          dc.sourceLength = tex.height;
          dc.colormapIdx = colormapIdx;
          dc.surfaceType = SurfaceType.WALL;
          dc.worldX = ctx.viewx + fixedMul(dist, finecosine(colAnIdx));
          dc.worldY = ctx.viewy + fixedMul(dist, finesine[colAnIdx]);
          dc.worldTopZ = Math.min(frontsector.ceilingHeight, backsector.ceilingHeight);
          dc.worldBottomZ = Math.max(frontsector.floorHeight, backsector.floorHeight);

          drawMaskedColumnDeferred(tex.columnMask[tcx]);
        }

        spryscale += ds.scalestep;
      }

      ds.maskedTextureCol = null;
    }
  }

  // ---- Private helpers ----

  private renderColumn(
    ctx: RenderContext,
    x: number, seg: Seg, scale: number,
    frontsector: Sector, backsector: Sector | null,
    baseOffset: number,
    rw_centerangle: number, rw_distance: number,
    midtexture: number, toptexture: number, bottomtexture: number,
    rw_midtexturemid: number, rw_toptexturemid: number, rw_bottomtexturemid: number,
    worldtop: number, worldbottom: number,
    worldhigh: number, worldlow: number,
    markfloor: boolean, markceiling: boolean,
    lightnum: number,
  ): void {
    if (x < 0 || x >= SCREENWIDTH) return;
    if (scale < 64) scale = 64;

    const iscale = fixedDiv(FRACUNIT, scale);

    let yl = ((ctx.centeryfrac - fixedMul(worldtop, scale) + FRACUNIT - 1) >> FRACBITS) | 0;
    let yh = ((ctx.centeryfrac - fixedMul(worldbottom, scale)) >> FRACBITS) | 0;

    if (yl < ctx.ceilingclip[x] + 1) yl = ctx.ceilingclip[x] + 1;
    if (yh > ctx.floorclip[x] - 1) yh = ctx.floorclip[x] - 1;

    // Light
    let lightIdx = (scale >> LIGHTSCALESHIFT) | 0;
    if (lightIdx >= MAXLIGHTSCALE) lightIdx = MAXLIGHTSCALE - 1;
    if (lightIdx < 0) lightIdx = 0;
    const colormapIdx = ctx.scalelight[lightnum]?.[lightIdx] ?? 0;
    const colormap = ctx.palData.getColormapLookup(colormapIdx);

    // Texture column
    const texCol = this.getTexColumn(ctx, x, baseOffset, rw_centerangle, rw_distance);

    setZScale(scale);

    // Compute world position for G-Buffer
    {
      const colAngle = (ctx.viewangle + (ctx.xtoviewangle[x] || 0)) >>> 0;
      const colAnIdx = (colAngle >>> ANGLETOFINESHIFT) & FINEMASK;
      const dist = scale > 0 ? fixedDiv(ctx.projection, scale) : (512 * FRACUNIT);
      dc.worldX = ctx.viewx + fixedMul(dist, finecosine(colAnIdx));
      dc.worldY = ctx.viewy + fixedMul(dist, finesine[colAnIdx]);
      dc.colormapIdx = colormapIdx;
      dc.surfaceType = SurfaceType.WALL;
    }

    if (!backsector) {
      // Mark visplanes
      if (markceiling) this.planes.addPixel(ctx, true, x, ctx.ceilingclip[x] + 1, Math.min(yl - 1, ctx.floorclip[x] - 1));
      if (markfloor) this.planes.addPixel(ctx, false, x, Math.max(yh + 1, ctx.ceilingclip[x] + 1), ctx.floorclip[x] - 1);

      // One-sided: draw mid texture
      if (yl <= yh && midtexture) {
        const tex = ctx.texData.textures[midtexture];
        if (tex) {
          const tcx = ((texCol % tex.width) + tex.width) % tex.width;
          dc.colormap = colormap;
          dc.x = x;
          dc.yl = yl;
          dc.yh = yh;
          dc.textureMid = rw_midtexturemid;
          dc.iscale = iscale;
          dc.source = tex.columns[tcx];
          dc.sourceLength = tex.height;
          dc.worldTopZ = frontsector.ceilingHeight;
          dc.worldBottomZ = frontsector.floorHeight;
          drawColumnDeferred();
        }
      }

      ctx.ceilingclip[x] = ctx.viewheight;
      ctx.floorclip[x] = -1;
    } else {
      // Two-sided
      let mid: number;

      // Ceiling visplane
      if (markceiling) {
        const top = ctx.ceilingclip[x] + 1;
        let bottom = yl - 1;
        if (bottom >= ctx.floorclip[x]) bottom = ctx.floorclip[x] - 1;
        if (top <= bottom) {
          this.planes.addPixel(ctx, true, x, top, bottom);
        }
      }

      // Floor visplane
      if (markfloor) {
        let top = yh + 1;
        const bottom = ctx.floorclip[x] - 1;
        if (top <= ctx.ceilingclip[x]) top = ctx.ceilingclip[x] + 1;
        if (top <= bottom) {
          this.planes.addPixel(ctx, false, x, top, bottom);
        }
      }

      // Upper wall
      if (toptexture) {
        mid = ((ctx.centeryfrac - fixedMul(worldhigh, scale)) >> FRACBITS) | 0;
        if (mid >= ctx.floorclip[x]) mid = ctx.floorclip[x] - 1;
        if (mid >= yl) {
          const tex = ctx.texData.textures[toptexture];
          if (tex) {
            const tcx = ((texCol % tex.width) + tex.width) % tex.width;
            dc.colormap = colormap;
            dc.x = x;
            dc.yl = yl;
            dc.yh = mid;
            dc.textureMid = rw_toptexturemid;
            dc.iscale = iscale;
            dc.source = tex.columns[tcx];
            dc.sourceLength = tex.height;
            dc.worldTopZ = frontsector.ceilingHeight;
            dc.worldBottomZ = backsector!.ceilingHeight;
            drawColumnDeferred();
          }
          ctx.ceilingclip[x] = mid;
        } else {
          ctx.ceilingclip[x] = yl - 1;
        }
      } else {
        if (markceiling) ctx.ceilingclip[x] = yl - 1;
      }

      // Lower wall
      if (bottomtexture) {
        mid = (((ctx.centeryfrac - fixedMul(worldlow, scale)) + FRACUNIT - 1) >> FRACBITS) | 0;
        if (mid <= ctx.ceilingclip[x]) mid = ctx.ceilingclip[x] + 1;
        if (mid <= yh) {
          const tex = ctx.texData.textures[bottomtexture];
          if (tex) {
            const tcx = ((texCol % tex.width) + tex.width) % tex.width;
            dc.colormap = colormap;
            dc.x = x;
            dc.yl = mid;
            dc.yh = yh;
            dc.textureMid = rw_bottomtexturemid;
            dc.iscale = iscale;
            dc.source = tex.columns[tcx];
            dc.sourceLength = tex.height;
            dc.worldTopZ = backsector!.floorHeight;
            dc.worldBottomZ = frontsector.floorHeight;
            drawColumnDeferred();
          }
          ctx.floorclip[x] = mid;
        } else {
          ctx.floorclip[x] = yh + 1;
        }
      } else {
        if (markfloor) ctx.floorclip[x] = yh + 1;
      }
    }
  }

  private scaleFromGlobalAngle(
    ctx: RenderContext, x: number,
    rw_normalangle: number, rw_distance: number,
  ): number {
    const visangle = (ctx.viewangle + (ctx.xtoviewangle[x] || 0)) >>> 0;
    const anglea = (ANG90 + (visangle - ctx.viewangle)) >>> 0;
    const angleb = (ANG90 + (visangle - rw_normalangle)) >>> 0;

    const sinea = finesine[(anglea >>> ANGLETOFINESHIFT) & FINEMASK] || 0;
    const sineb = finesine[(angleb >>> ANGLETOFINESHIFT) & FINEMASK] || 0;

    const num = fixedMul(ctx.projection, sineb);
    const den = fixedMul(rw_distance, sinea);

    if (den > (num >> 16)) {
      let scale = fixedDiv(num, den);
      if (scale > 64 * FRACUNIT) scale = 64 * FRACUNIT;
      else if (scale < 256) scale = 256;
      return scale;
    }
    return 64 * FRACUNIT;
  }

  private calcTextureBaseOffset(
    ctx: RenderContext, seg: Seg, hyp: number,
    rw_normalangle: number,
  ): number {
    let offsetangle = ((rw_normalangle - ctx.rwAngle1) >>> 0);
    if (offsetangle > ANG180) offsetangle = ((-offsetangle) >>> 0);
    if (offsetangle > ANG90) offsetangle = ANG90;

    const sinIdx = (offsetangle >>> ANGLETOFINESHIFT) & FINEMASK;
    let rw_offset = fixedMul(hyp, finesine[sinIdx] || 0);

    if (((rw_normalangle - ctx.rwAngle1) >>> 0) < ANG180) {
      rw_offset = -rw_offset;
    }

    rw_offset += (seg.sidedef.textureOffset || 0) + (seg.offset || 0);
    return rw_offset;
  }

  private getTexColumn(
    ctx: RenderContext, x: number, baseOffset: number,
    rw_centerangle: number, rw_distance: number,
  ): number {
    const angle = ((rw_centerangle + (ctx.xtoviewangle[x] || 0)) >>> ANGLETOFINESHIFT) & (FINEANGLES / 2 - 1);
    let col = baseOffset - fixedMul(finetangent[angle] || 0, rw_distance);
    return (col >> FRACBITS) | 0;
  }
}
