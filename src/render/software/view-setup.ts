// ============================================================
// ViewSetup — Camera, Projection, and Light Tables
// Extracted from renderer.ts. Pure math — no draw calls.
// ============================================================

import {
  FRACBITS, FRACUNIT, fixedDiv, fixedMul,
  ANG90, ANGLETOFINESHIFT, FINEANGLES, FINEMASK,
  finesine, finecosine, finetangent, pointToAngle,
} from '../../../game/math';
import { SCREENWIDTH, SCREENHEIGHT } from './draw';
import {
  FIELDOFVIEW, LIGHTLEVELS, LIGHTSEGSHIFT,
  MAXLIGHTSCALE, LIGHTSCALESHIFT,
  MAXLIGHTZ, LIGHTZSHIFT, BASE_WIDTH,
  type RenderContext,
} from './render-context';

/**
 * ViewSetup manages camera transform, angle-to-screen mapping,
 * and light tables. All state is written into a RenderContext.
 */
export class ViewSetup {
  /** Set camera position and recompute sin/cos. */
  setPosition(ctx: RenderContext, x: number, y: number, z: number, angle: number): void {
    ctx.viewx = x;
    ctx.viewy = y;
    ctx.viewz = z;
    ctx.viewangle = angle >>> 0;
    const fineAngle = (ctx.viewangle >>> ANGLETOFINESHIFT) & FINEMASK;
    ctx.viewsin = finesine[fineAngle] || 0;
    ctx.viewcos = finecosine(fineAngle) || 0;
  }

  /** R_PointToAngle — angle from viewer to (x, y). */
  angleTo(ctx: RenderContext, x: number, y: number): number {
    return pointToAngle(ctx.viewx, ctx.viewy, x, y);
  }

  /** Map a view-relative angle to a screen X column. */
  angleToX(ctx: RenderContext, ang: number): number {
    const fineIdx = ((ang + ANG90) >>> ANGLETOFINESHIFT) & (FINEANGLES / 2 - 1);
    return ctx.viewangletox[fineIdx];
  }

  /**
   * Build viewangletox and xtoviewangle lookup tables.
   * Called once on init and on every resolution change.
   */
  initTextureMapping(ctx: RenderContext): void {
    const focallength = fixedDiv(
      ctx.centerxfrac,
      finetangent[FINEANGLES / 4 + FIELDOFVIEW / 2] || 1,
    );

    for (let i = 0; i < FINEANGLES / 2; i++) {
      const ft = finetangent[i] || 0;
      let t: number;
      if (ft > FRACUNIT * 2) {
        t = -1;
      } else if (ft < -FRACUNIT * 2) {
        t = ctx.viewwidth + 1;
      } else {
        t = fixedMul(ft, focallength);
        t = ((ctx.centerxfrac - t + FRACUNIT - 1) >> FRACBITS) | 0;
        if (t < -1) t = -1;
        else if (t > ctx.viewwidth + 1) t = ctx.viewwidth + 1;
      }
      ctx.viewangletox[i] = t;
    }

    // Reverse mapping: screen X → view angle
    for (let x = 0; x <= ctx.viewwidth; x++) {
      let i = 0;
      while (i < FINEANGLES / 2 && ctx.viewangletox[i] > x) i++;
      ctx.xtoviewangle[x] = ((i << ANGLETOFINESHIFT) - ANG90) >>> 0;
    }

    // Clamp viewangletox edges
    for (let i = 0; i < FINEANGLES / 2; i++) {
      if (ctx.viewangletox[i] === -1) ctx.viewangletox[i] = 0;
      else if (ctx.viewangletox[i] === ctx.viewwidth + 1) ctx.viewangletox[i] = ctx.viewwidth;
    }

    ctx.clipangle = ctx.xtoviewangle[0];
  }

  /**
   * Build scalelight and zlight tables for distance-based light dimming.
   * Called on init, resolution change, and color mode toggle.
   */
  initLightTables(ctx: RenderContext): void {
    for (let i = 0; i < LIGHTLEVELS; i++) {
      ctx.scalelight[i] = [];
      const startmap = ((LIGHTLEVELS - 1 - i) * 2) * ctx.numColormaps / LIGHTLEVELS;
      for (let j = 0; j < MAXLIGHTSCALE; j++) {
        let level = Math.floor(startmap - j * BASE_WIDTH / ctx.viewwidth / 2);
        if (level < 0) level = 0;
        if (level >= ctx.numColormaps) level = ctx.numColormaps - 1;
        ctx.scalelight[i][j] = level;
      }
    }
    for (let i = 0; i < LIGHTLEVELS; i++) {
      ctx.zlight[i] = [];
      const startmap = ((LIGHTLEVELS - 1 - i) * 2) * ctx.numColormaps / LIGHTLEVELS;
      for (let j = 0; j < MAXLIGHTZ; j++) {
        let scale = fixedDiv((BASE_WIDTH / 2) * FRACUNIT, (j + 1) << LIGHTZSHIFT);
        scale >>= LIGHTSCALESHIFT;
        let level = Math.floor(startmap - scale / 2);
        if (level < 0) level = 0;
        if (level >= ctx.numColormaps) level = ctx.numColormaps - 1;
        ctx.zlight[i][j] = level;
      }
    }
  }

  /**
   * Full initialization: texture mapping, light tables, yslope, distscale.
   * Called after resolution change or level load.
   */
  init(ctx: RenderContext): void {
    ctx.updateResolution();
    this.initTextureMapping(ctx);
    this.initLightTables(ctx);

    // Recompute distscale (depends on xtoviewangle)
    for (let i = 0; i < ctx.viewwidth; i++) {
      const cosadj = Math.abs(finecosine((ctx.xtoviewangle[i] >>> ANGLETOFINESHIFT) & FINEMASK));
      ctx.distscale[i] = cosadj > 256 ? fixedDiv(FRACUNIT, cosadj) : FRACUNIT;
    }
  }
}
