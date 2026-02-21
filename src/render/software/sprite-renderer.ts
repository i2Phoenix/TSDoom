// ============================================================
// SpriteRenderer — Sprite Projection & Drawing
// Extracted from renderer.ts (R_ProjectSprite, R_DrawSprite)
// ============================================================

import {
  FRACBITS, FRACUNIT, fixedDiv, fixedMul,
  ANGLETOFINESHIFT, FINEMASK,
  finesine, finecosine, pointToAngle,
} from '../../../game/math';
import { MF_SHADOW } from '../../../game/mobjinfo';
import {
  SCREENWIDTH, rgbaBuffer, zBuffer,
  ZFLAG_WALL, Z_DEPTH_MASK,
  writeGBufferSpritePixel,
} from './draw';
import { gBuffer, SurfaceType } from './gbuffer';
import { getThingAnimFrame } from '../../../game/animations';
import { getMapObjectByThingIndex } from '../../../game/mobj';
import { getActiveVfx, getVfxSprite, type VfxEffect } from '../../../game/vfx';
import { getDroppedItems, type DroppedItem } from '../../../game/mobj';
import { getActiveProjectiles, getProjectileSprite, type Projectile } from '../../../game/projectiles';
import { getRemovedThings } from '../../../game/pickups';
import { shouldSpawnThing } from '../../../game/skill';
import { THING_INFO } from './sprites';
import type { Sector, MapThing } from '../../map';
import type { Patch } from '../../textures';
import type { RenderContext, VisSprite } from './render-context';
import { LIGHTLEVELS, MAXLIGHTSCALE, LIGHTSCALESHIFT } from './render-context';

/**
 * Handles sprite projection (world → screen) during BSP traversal
 * and final sorted drawing.
 */
export class SpriteRenderer {
  // ---- Subsector map builders ----

  buildSubsectorMaps(ctx: RenderContext): void {
    this.buildThingSubsectorMap(ctx);
    this.buildVfxSubsectorMap(ctx);
    this.buildDropSubsectorMap(ctx);
    this.buildProjectileSubsectorMap(ctx);
  }

  private buildThingSubsectorMap(ctx: RenderContext): void {
    ctx.subsectorThings.clear();
    for (let i = 0; i < ctx.map.things.length; i++) {
      const thing = ctx.map.things[i];
      if (getRemovedThings(ctx.gi).has(i)) continue;
      if (!shouldSpawnThing(thing.options, ctx.gi)) continue;
      const info = THING_INFO[thing.type];
      if (!info) continue;

      // Use runtime position from MapObjState if available (monsters move!)
      const mobj = getMapObjectByThingIndex(i, ctx.gi);
      if (mobj && mobj.removed) continue;
      const x = mobj ? mobj.x : (thing.x << FRACBITS);
      const y = mobj ? mobj.y : (thing.y << FRACBITS);
      const ss = ctx.map.pointInSubsector(x, y);
      const ssIdx = ctx.map.subsectors.indexOf(ss);
      if (ssIdx < 0) continue;
      let arr = ctx.subsectorThings.get(ssIdx);
      if (!arr) { arr = []; ctx.subsectorThings.set(ssIdx, arr); }
      arr.push({ thing, info, thingIdx: i });
    }
  }

  private buildVfxSubsectorMap(ctx: RenderContext): void {
    ctx.subsectorVfx.clear();
    if (!ctx.spriteData) return;
    const effects = getActiveVfx(ctx.gi);
    for (const e of effects) {
      const ss = ctx.map.pointInSubsector(e.x, e.y);
      const ssIdx = ctx.map.subsectors.indexOf(ss);
      if (ssIdx < 0) continue;
      if (!ctx.subsectorVfx.has(ssIdx)) ctx.subsectorVfx.set(ssIdx, []);
      ctx.subsectorVfx.get(ssIdx)!.push(e);
    }
  }

  private buildDropSubsectorMap(ctx: RenderContext): void {
    ctx.subsectorDrops.clear();
    if (!ctx.spriteData) return;
    const items = getDroppedItems(ctx.gi);
    for (const item of items) {
      const ss = ctx.map.pointInSubsector(item.x, item.y);
      const ssIdx = ctx.map.subsectors.indexOf(ss);
      if (ssIdx < 0) continue;
      if (!ctx.subsectorDrops.has(ssIdx)) ctx.subsectorDrops.set(ssIdx, []);
      ctx.subsectorDrops.get(ssIdx)!.push(item);
    }
  }

  private buildProjectileSubsectorMap(ctx: RenderContext): void {
    ctx.subsectorProjectiles.clear();
    if (!ctx.spriteData) return;
    const projectiles = getActiveProjectiles(ctx.gi);
    for (const p of projectiles) {
      if (p.removed) continue;
      const ss = ctx.map.pointInSubsector(p.x, p.y);
      const ssIdx = ctx.map.subsectors.indexOf(ss);
      if (ssIdx < 0) continue;
      if (!ctx.subsectorProjectiles.has(ssIdx)) ctx.subsectorProjectiles.set(ssIdx, []);
      ctx.subsectorProjectiles.get(ssIdx)!.push(p);
    }
  }

  // ---- Projection (called during BSP traversal) ----

  /** Project all sprites in a subsector and add to vissprites. */
  projectSubsector(ctx: RenderContext, ssIdx: number, sector: Sector): void {
    // Map things
    const things = ctx.subsectorThings.get(ssIdx);
    if (things && ctx.spriteData) {
      for (const { thing, info, thingIdx } of things) {
        this.projectThing(ctx, thing, info, sector, thingIdx);
      }
    }

    // VFX
    const vfx = ctx.subsectorVfx.get(ssIdx);
    if (vfx) {
      for (const e of vfx) this.projectVfx(ctx, e, sector);
    }

    // Dropped items
    const drops = ctx.subsectorDrops.get(ssIdx);
    if (drops) {
      for (const d of drops) this.projectDrop(ctx, d, sector);
    }

    // Projectiles
    const projectiles = ctx.subsectorProjectiles.get(ssIdx);
    if (projectiles) {
      for (const p of projectiles) this.projectProjectile(ctx, p, sector);
    }
  }

  private projectThing(
    ctx: RenderContext,
    thing: MapThing,
    info: { sprite: string; frame: number; radius: number; height: number },
    sector: Sector,
    thingIdx: number,
  ): void {
    const mobj = getMapObjectByThingIndex(thingIdx, ctx.gi);
    const tx = mobj ? mobj.x : (thing.x << FRACBITS);
    const ty = mobj ? mobj.y : (thing.y << FRACBITS);

    const dx = tx - ctx.viewx;
    const dy = ty - ctx.viewy;
    const trx = fixedMul(dx, ctx.viewcos) + fixedMul(dy, ctx.viewsin);
    const try_ = fixedMul(dx, ctx.viewsin) - fixedMul(dy, ctx.viewcos);

    if (trx < FRACUNIT * 4) return;

    const xscale = fixedDiv(ctx.projection, trx);
    const screenX = ctx.centerx + ((fixedMul(try_, xscale)) >> FRACBITS);
    if (screenX < -SCREENWIDTH || screenX > SCREENWIDTH * 2) return;

    // Sprite rotation
    const angToViewer = Math.atan2(
      (ctx.viewy - ty) / FRACUNIT,
      (ctx.viewx - tx) / FRACUNIT,
    );
    let thingAngleBam: number;
    if (mobj) {
      thingAngleBam = mobj.angle;
    } else {
      thingAngleBam = ((thing.angle * 0x100000000 / 360) >>> 0);
    }
    const thingAngle = (thingAngleBam / 0x80000000) * Math.PI;
    const relAngle = angToViewer - thingAngle;
    const normalizedAngle = ((relAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    const animFrame = getThingAnimFrame(thingIdx);
    const spriteFrame = ctx.spriteData!.getSpriteFrame(
      animFrame ? animFrame.sprite : info.sprite,
      animFrame ? animFrame.frame : info.frame,
      normalizedAngle,
    );
    if (!spriteFrame) return;

    const { patch, flip } = spriteFrame;
    const thingFloorZ = mobj ? mobj.z : sector.floorHeight;
    const thingTopZ = thingFloorZ + (patch.topOffset << FRACBITS);
    const texturemid = thingTopZ - ctx.viewz;

    const spriteOffset = patch.leftOffset << FRACBITS;
    const x1 = screenX - ((fixedMul(spriteOffset, xscale)) >> FRACBITS);
    const x2 = x1 + ((fixedMul(patch.width << FRACBITS, xscale)) >> FRACBITS) - 1;
    if (x2 < 0 || x1 >= ctx.viewwidth) return;

    const xiscale = fixedDiv(FRACUNIT, xscale);
    const lightLevel = Math.max(0, Math.min(sector.lightLevel >> 4, LIGHTLEVELS - 1));
    const cx1 = Math.max(0, x1);
    const cx2 = Math.min(ctx.viewwidth - 1, x2);

    const clipWidth = cx2 - cx1 + 1;
    const clipOff = ctx.allocClip(clipWidth);
    for (let i = 0; i < clipWidth; i++) {
      ctx.clipBuf[clipOff + i] = ctx.floorclip[cx1 + i];
      ctx.clipBuf[clipOff + clipWidth + i] = ctx.ceilingclip[cx1 + i];
    }

    const absXiscale = flip ? -xiscale : xiscale;
    let startFrac = flip ? (patch.width - 1) << FRACBITS : 0;
    if (cx1 > x1) startFrac += absXiscale * (cx1 - x1);

    const hasFuzz = mobj ? !!(mobj.flags & MF_SHADOW) : (thing.type === 58);

    ctx.vissprites.push({
      x1: cx1, x2: cx2,
      gx: tx, gy: ty, gz: thingFloorZ, gzt: thingTopZ,
      scale: xscale, xiscale: absXiscale, startFrac,
      texturemid, patch, flip,
      colormap: lightLevel, dist: trx,
      clipOffset: clipOff, isFuzz: hasFuzz,
    });
  }

  private projectSimple(
    ctx: RenderContext, x: number, y: number, z: number,
    sprite: string, frame: number, sector: Sector, isFuzz = false,
  ): void {
    const dx = x - ctx.viewx;
    const dy = y - ctx.viewy;
    const trx = fixedMul(dx, ctx.viewcos) + fixedMul(dy, ctx.viewsin);
    const try_ = fixedMul(dx, ctx.viewsin) - fixedMul(dy, ctx.viewcos);

    if (trx < FRACUNIT * 4) return;

    const xscale = fixedDiv(ctx.projection, trx);
    const screenX = ctx.centerx + ((fixedMul(try_, xscale)) >> FRACBITS);
    if (screenX < -SCREENWIDTH || screenX > SCREENWIDTH * 2) return;

    const spriteFrame = ctx.spriteData!.getSpriteFrame(sprite, frame, 0);
    if (!spriteFrame) return;
    const { patch, flip } = spriteFrame;

    const lightLevel = Math.max(0, Math.min(sector.lightLevel >> 4, LIGHTLEVELS - 1));
    const thingTopZ = z + (patch.topOffset << FRACBITS);
    const texturemid = thingTopZ - ctx.viewz;
    const spriteOffset = patch.leftOffset << FRACBITS;
    const x1 = screenX - ((fixedMul(spriteOffset, xscale)) >> FRACBITS);
    const x2 = x1 + ((fixedMul(patch.width << FRACBITS, xscale)) >> FRACBITS) - 1;
    if (x2 < 0 || x1 >= ctx.viewwidth) return;

    const xiscale = fixedDiv(FRACUNIT, xscale);
    const cx1 = Math.max(0, x1);
    const cx2 = Math.min(ctx.viewwidth - 1, x2);

    const clipW = cx2 - cx1 + 1;
    const clipOff = ctx.allocClip(clipW);
    for (let i = 0; i < clipW; i++) {
      ctx.clipBuf[clipOff + i] = ctx.floorclip[cx1 + i];
      ctx.clipBuf[clipOff + clipW + i] = ctx.ceilingclip[cx1 + i];
    }

    const absXiscale = flip ? -xiscale : xiscale;
    let startFrac = flip ? (patch.width - 1) << FRACBITS : 0;
    if (cx1 > x1) startFrac += absXiscale * (cx1 - x1);

    ctx.vissprites.push({
      x1: cx1, x2: cx2,
      gx: x, gy: y, gz: z, gzt: thingTopZ,
      scale: xscale, xiscale: absXiscale, startFrac,
      texturemid, patch, flip,
      colormap: lightLevel, dist: trx,
      clipOffset: clipOff, isFuzz,
    });
  }

  private projectVfx(ctx: RenderContext, e: VfxEffect, sector: Sector): void {
    const { sprite, frame } = getVfxSprite(e);
    this.projectSimple(ctx, e.x, e.y, e.z, sprite, frame, sector);
  }

  private projectDrop(ctx: RenderContext, item: DroppedItem, sector: Sector): void {
    const info = THING_INFO[item.thingType];
    if (!info) return;
    this.projectSimple(ctx, item.x, item.y, item.z, info.sprite, info.frame, sector);
  }

  private projectProjectile(ctx: RenderContext, proj: Projectile, sector: Sector): void {
    const { sprite, frame } = getProjectileSprite(proj);
    this.projectSimple(ctx, proj.x, proj.y, proj.z, sprite, frame, sector);
  }

  // ---- Drawing (called after BSP traversal) ----

  /** Sort vissprites back-to-front and draw them. */
  drawAll(ctx: RenderContext): void {
    if (ctx.vissprites.length === 0) return;

    ctx.vissprites.sort((a, b) => b.dist - a.dist);

    for (const vis of ctx.vissprites) {
      this.drawVisSprite(ctx, vis);
    }
  }

  private drawVisSprite(ctx: RenderContext, vis: VisSprite): void {
    const patch = vis.patch;

    const lightIdx = vis.colormap;
    const scaleLightRow = ctx.scalelight[lightIdx] || ctx.scalelight[0];
    const lightScale = Math.min(Math.max(vis.scale >> LIGHTSCALESHIFT, 0), MAXLIGHTSCALE - 1);
    const colormapIdx = scaleLightRow[lightScale];
    const colormap = ctx.palData.getColormapLookup(colormapIdx);

    const stepFrac = vis.xiscale;
    let frac = vis.startFrac;

    for (let x = vis.x1; x <= vis.x2; x++) {
      const col = (frac >> FRACBITS) & 0x7FFF;
      if (col < 0 || col >= patch.width) {
        frac += stepFrac;
        continue;
      }

      const sprtopscreen = ctx.centery - ((fixedMul(vis.texturemid, vis.scale)) >> FRACBITS);
      const spryscale = vis.scale;
      const sprBottomScreen = sprtopscreen + ((fixedMul(patch.height << FRACBITS, spryscale)) >> FRACBITS);

      const clipIdx = x - vis.x1;
      const clipWidth = vis.x2 - vis.x1 + 1;
      let yl = Math.max(Math.ceil(sprtopscreen), ctx.clipBuf[vis.clipOffset + clipWidth + clipIdx] + 1);
      let yh = Math.min(Math.floor(sprBottomScreen) - 1, ctx.clipBuf[vis.clipOffset + clipIdx] - 1);

      if (yl > yh) {
        frac += stepFrac;
        continue;
      }

      if (yl < 0) yl = 0;
      if (yh >= ctx.viewheight) yh = ctx.viewheight - 1;

      const patchCol = patch.columns[col];
      for (const post of patchCol) {
        const postTopScreen = sprtopscreen + ((post.topDelta * spryscale) >> FRACBITS);
        const postBottomScreen = postTopScreen + ((post.length * spryscale) >> FRACBITS);

        const drawYl = Math.max(Math.ceil(postTopScreen), yl);
        const drawYh = Math.min(Math.floor(postBottomScreen) - 1, yh);
        if (drawYl > drawYh) continue;

        const spriteScale = vis.scale;
        for (let y = drawYl; y <= drawYh; y++) {
          const texY = Math.floor(((y - postTopScreen) * post.length) / Math.max(1, postBottomScreen - postTopScreen));
          if (texY < 0 || texY >= post.length) continue;

          const pixel = post.data[texY];
          if (pixel === undefined) continue;

          const dest = y * SCREENWIDTH + x;
          const existingZ = zBuffer[dest];
          if ((existingZ & ZFLAG_WALL) && (existingZ & Z_DEPTH_MASK) > spriteScale) continue;

          const sprFrac = (y - sprtopscreen) / Math.max(1, sprBottomScreen - sprtopscreen);
          const wz = vis.gzt - ((sprFrac * (vis.gzt - vis.gz)) | 0);
          if (vis.isFuzz) {
            gBuffer.flags[dest] = SurfaceType.FUZZ;
          } else {
            writeGBufferSpritePixel(dest, pixel, colormapIdx, vis.gx, vis.gy, wz);
          }
          zBuffer[dest] = spriteScale;
        }
      }

      frac += stepFrac;
    }
  }
}
