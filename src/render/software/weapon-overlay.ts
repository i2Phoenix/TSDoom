// ============================================================
// WeaponOverlay — Psprite (Weapon) Rendering
// Extracted from renderer.ts (R_DrawPSprite / R_DrawMaskedColumn)
// ============================================================

import { FRACBITS } from '../../../game/math';
import { getPspriteInfo, type WeaponPlayer } from '../../../game/weapons';
import type { Patch } from '../../textures';
import { SCREENWIDTH, SCREENHEIGHT, rgbaBuffer } from './draw';
import { gBuffer, SurfaceType } from './gbuffer';
import type { RenderContext } from './render-context';
import { BASE_WIDTH, LIGHTLEVELS, MAXLIGHTSCALE } from './render-context';

const BASEYCENTER = 100; // DOOM constant (r_things.c line 47)

/**
 * Renders the player's weapon overlay (psprites).
 */
export class WeaponOverlay {
  private player: WeaponPlayer | null = null;

  setPlayer(p: WeaponPlayer): void {
    this.player = p;
  }

  draw(ctx: RenderContext): void {
    if (!this.player || !ctx.spriteData) return;

    const pspritescale = SCREENWIDTH / 320;

    for (let i = 0; i < 2; i++) {
      const info = getPspriteInfo(this.player, i);
      if (!info) continue;

      const result = ctx.spriteData.getSpriteFrame(info.sprite, info.frame, 0);
      if (!result) continue;

      const patch = result.patch;

      // X positioning
      const tx = (info.sx >> FRACBITS) - 160 - patch.leftOffset;
      const x1 = Math.round(ctx.centerx + tx * pspritescale);

      // Y positioning — anchored relative to viewport bottom
      const pspriteCentery = ctx.viewheight - 84 * pspritescale;
      const sy_px = info.sy >> FRACBITS;
      const texturemid = BASEYCENTER + 0.5 - (sy_px - patch.topOffset);
      const sprtopscreen = pspriteCentery - texturemid * pspritescale;

      // Weapon lighting: sector light + extralight from muzzle flash
      const playerSS = ctx.map.pointInSubsector(ctx.viewx, ctx.viewy);
      const sectorLight = playerSS.sector ? playerSS.sector.lightLevel : 255;
      let weaponLight = Math.floor((ctx.numColormaps - 1) * (1 - sectorLight / 255));
      weaponLight = Math.max(0, weaponLight - ctx.extralight * 4);
      const colormap = ctx.palData.getColormapLookup(weaponLight);

      this.drawPatch(ctx, patch, x1, sprtopscreen, pspritescale, result.flip, colormap);
    }
  }

  private drawPatch(
    ctx: RenderContext,
    patch: Patch, x1: number, sprtopscreen: number,
    scale: number, flip: boolean, colormap: Uint32Array,
  ): void {
    const patchWidth = patch.width;
    const x2 = x1 + Math.round(patchWidth * scale) - 1;

    const clippedX1 = Math.max(x1, 0);
    const clippedX2 = Math.min(x2, SCREENWIDTH - 1);
    if (clippedX1 > clippedX2) return;

    const xiscale = patchWidth / (x2 - x1 + 1);
    let startfrac: number;

    if (flip) {
      startfrac = patchWidth - 1;
      if (clippedX1 > x1) startfrac -= xiscale * (clippedX1 - x1);
    } else {
      startfrac = 0;
      if (clippedX1 > x1) startfrac += xiscale * (clippedX1 - x1);
    }

    let frac = startfrac;
    for (let screenX = clippedX1; screenX <= clippedX2; screenX++) {
      const patchCol = Math.floor(frac);
      if (patchCol >= 0 && patchCol < patchWidth) {
        const posts = patch.columns[patchCol];
        for (const post of posts) {
          const postTopScreen = sprtopscreen + post.topDelta * scale;
          const postHeight = post.length * scale;

          const drawYl = Math.max(Math.ceil(postTopScreen), 0);
          const drawYh = Math.min(Math.floor(postTopScreen + postHeight - 1), ctx.viewheight - 1);

          for (let y = drawYl; y <= drawYh; y++) {
            const texY = Math.floor((y - postTopScreen) * post.length / postHeight);
            if (texY >= 0 && texY < post.length) {
              const pixel = post.data[texY];
              if (pixel !== undefined) {
                const dest = y * SCREENWIDTH + screenX;
                rgbaBuffer[dest] = colormap[pixel];
                gBuffer.flags[dest] = SurfaceType.PSPRITE;
              }
            }
          }
        }
      }
      frac += flip ? -xiscale : xiscale;
    }
  }
}
