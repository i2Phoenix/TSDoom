// ============================================================
// Palette Flash (Screen Color Shift)
// Reference: st_stuff.c — ST_doPaletteStuff
// ============================================================
// Classic mode: switches PLAYPAL palettes (original DOOM behavior).
// TrueColor mode: renders with palette 0, applies screen-space
//   color blend as post-process (smoother, no geometry tinting).

import { SCREENWIDTH, SCREENHEIGHT, rgbaBuffer } from "../render/draw";
import { PaletteData } from "../palette";
import { PowerType } from '../../game/player';

// PLAYPAL palette index constants (from st_stuff.c)
const STARTREDPALS = 1;
const NUMREDPALS = 8;
const STARTBONUSPALS = 9;
const NUMBONUSPALS = 4;
const RADIATIONPAL = 13;

/** Track previously set palette to avoid redundant setActivePalette calls */
let currentPalette = -1;

/** Invulnerability colormap active (inverse grayscale post-process) */
let invulnEffect = false;

/** Player interface — only the fields we need */
interface FlashPlayer {
  damagecount: number;
  bonuscount: number;
  powers: number[];
}

/**
 * ST_doPaletteStuff — select the correct screen palette based on
 * damage, bonus pickups, berserk, and radiation suit state.
 * Call once per frame (in the draw loop), before rendering.
 *
 * Classic mode: switches palette.
 * TrueColor mode: keeps palette 0, stores tint for post-process.
 */
export function updatePaletteFlash(
  player: FlashPlayer,
  palData: PaletteData
): void {
  // Invulnerability colormap 33: inverse grayscale (takes priority)
  // Original DOOM: active when powers[invulnerability] > 128 or odd ticks
  invulnEffect = player.powers[PowerType.invulnerability] > 0;

  let palette = 0;
  let cnt = player.damagecount;

  if (player.powers[PowerType.strength]) {
    const bzc = 12 - (player.powers[PowerType.strength] >> 6);
    if (bzc > cnt) cnt = bzc;
  }

  if (cnt) {
    palette = (cnt + 7) >> 3;
    if (palette >= NUMREDPALS) palette = NUMREDPALS - 1;
    palette += STARTREDPALS;
  } else if (player.bonuscount) {
    palette = (player.bonuscount + 7) >> 3;
    if (palette >= NUMBONUSPALS) palette = NUMBONUSPALS - 1;
    palette += STARTBONUSPALS;
  } else if (
    player.powers[PowerType.ironfeet] > 4 * 32 ||
    player.powers[PowerType.ironfeet] & 8
  ) {
    palette = RADIATIONPAL;
  }

  if (palData.trueColorMode) {
    // TrueColor: always render with palette 0, apply tint as post-process
    if (currentPalette !== 0) {
      currentPalette = 0;
      palData.setActivePalette(0);
    }
    pendingTintPalette = palette;
  } else {
    // Classic: switch palette (original DOOM behavior)
    pendingTintPalette = 0;
    if (palette !== currentPalette) {
      currentPalette = palette;
      palData.setActivePalette(palette);
    }
  }
}

/** Pending tint palette index for TrueColor post-process */
let pendingTintPalette = 0;

// Pre-computed tint colors for each palette (R, G, B, intensity 0-255)
// Derived from comparing PLAYPAL palette N to palette 0
// Tint colors: [R, G, B, alpha (0-255)]
// Tuned for screen blend mode — higher alpha needed vs linear blend
const TINT_COLORS: Record<number, [number, number, number, number]> = {
  // Red damage palettes (1-8): increasing red intensity
  1:  [255, 0, 0, 40],
  2:  [255, 0, 0, 80],
  3:  [255, 0, 0, 120],
  4:  [255, 0, 0, 155],
  5:  [255, 0, 0, 185],
  6:  [255, 0, 0, 210],
  7:  [255, 0, 0, 235],
  8:  [255, 0, 0, 250],
  // Gold bonus palettes (9-12)
  9:  [215, 186, 69, 40],
  10: [215, 186, 69, 80],
  11: [215, 186, 69, 120],
  12: [215, 186, 69, 155],
  // Radiation suit (13)
  13: [0, 220, 0, 60],
};

/**
 * Apply screen tint as post-process (TrueColor mode only).
 * Uses "screen" blend mode for damage (red) — preserves scene detail
 * while tinting, like a colored filter over the lens.
 * Gold (pickup) and green (radiation) use soft overlay blend.
 *
 * Screen blend: result = 1 - (1 - base) * (1 - tint*alpha)
 * This brightens the image toward the tint color proportionally —
 * dark areas get more tint, bright areas stay bright.
 */
export function applyScreenTint(): void {
  // Invulnerability: inverse grayscale (colormap 33)
  // This takes priority over palette tints — original DOOM behavior
  if (invulnEffect) {
    const len = SCREENWIDTH * SCREENHEIGHT;
    for (let i = 0; i < len; i++) {
      const px = rgbaBuffer[i];
      const sr = px & 0xFF;
      const sg = (px >> 8) & 0xFF;
      const sb = (px >> 16) & 0xFF;

      // Luminance (fast integer approximation of rec601)
      const gray = (sr * 77 + sg * 150 + sb * 29) >> 8;
      // Invert
      const inv = 255 - gray;

      rgbaBuffer[i] = (255 << 24) | (inv << 16) | (inv << 8) | inv;
    }
    return;
  }

  if (pendingTintPalette === 0) return;

  const tint = TINT_COLORS[pendingTintPalette];
  if (!tint) return;

  const [tr, tg, tb, alpha] = tint;
  const len = SCREENWIDTH * SCREENHEIGHT;

  // Tint layer: how much of each channel to blend (0-255)
  const layerR = (tr * alpha) >> 8;
  const layerG = (tg * alpha) >> 8;
  const layerB = (tb * alpha) >> 8;
  // Inverse layer for screen blend: 255 - layer
  const invR = 255 - layerR;
  const invG = 255 - layerG;
  const invB = 255 - layerB;

  for (let i = 0; i < len; i++) {
    const px = rgbaBuffer[i];
    const sr = px & 0xFF;
    const sg = (px >> 8) & 0xFF;
    const sb = (px >> 16) & 0xFF;

    // Screen blend: result = 255 - ((255 - src) * (255 - layer)) / 255
    const r = 255 - (((255 - sr) * invR) >> 8);
    const g = 255 - (((255 - sg) * invG) >> 8);
    const b = 255 - (((255 - sb) * invB) >> 8);

    rgbaBuffer[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
}

/** Reset the palette tracker and force normal palette (call on level load / respawn) */
export function resetPaletteFlash(palData?: PaletteData): void {
  currentPalette = 0;
  pendingTintPalette = 0;
  if (palData) {
    palData.setActivePalette(0);
  }
}
