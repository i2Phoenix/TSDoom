// ============================================================
// Palette & Colormap
// Reference: PLAYPAL, COLORMAP lumps
// Supports two modes:
//   Classic  — original DOOM colormaps (32 levels, palette-quantized)
//   TrueColor — smooth RGB dimming (64 levels, full 16M color output)
// ============================================================

import { WAD } from './wad';

// 256-color palette as RGBA Uint32 values (for ImageData)
export type Palette = Uint32Array;

// 34 colormaps, each 256 entries (palette index remapping)
export type Colormap = Uint8Array; // 256 bytes

export const CLASSIC_COLORMAPS = 32;
export const TRUECOLOR_COLORMAPS = 64;

export class PaletteData {
  /** 14 palettes, each 256 RGBA uint32 values */
  palettes: Palette[] = [];
  /** 34 colormaps x 256 entries (from WAD COLORMAP lump) */
  colormaps: Colormap[] = [];
  /** Active palette index */
  activePalette = 0;
  /** Flat RGBA lookup for the active palette: palette index -> RGBA uint32 */
  rgbaLookup: Uint32Array = new Uint32Array(256);

  /** Light-level lookup tables: lightLookup[level][paletteIdx] -> RGBA uint32 */
  lightLookup: Uint32Array[] = [];

  /** Current color mode */
  private _trueColorMode = true;

  /** Number of colormap levels in current mode */
  get numColormaps(): number {
    return this._trueColorMode ? TRUECOLOR_COLORMAPS : CLASSIC_COLORMAPS;
  }

  get trueColorMode(): boolean {
    return this._trueColorMode;
  }

  constructor(wad: WAD) {
    this.parsePLAYPAL(wad);
    this.parseCOLORMAP(wad);
    this.setActivePalette(0);
  }

  private parsePLAYPAL(wad: WAD): void {
    const data = wad.getLumpByName('PLAYPAL');
    // 14 palettes x 256 colors x 3 bytes (RGB)
    const numPalettes = Math.floor(data.length / (256 * 3));
    for (let p = 0; p < numPalettes; p++) {
      const palette = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        const off = p * 768 + i * 3;
        const r = data[off];
        const g = data[off + 1];
        const b = data[off + 2];
        // RGBA for little-endian systems (Canvas ImageData)
        palette[i] = (255 << 24) | (b << 16) | (g << 8) | r;
      }
      this.palettes.push(palette);
    }
  }

  private parseCOLORMAP(wad: WAD): void {
    const data = wad.getLumpByName('COLORMAP');
    // 34 colormaps x 256 bytes
    const numMaps = Math.floor(data.length / 256);
    for (let m = 0; m < numMaps; m++) {
      this.colormaps.push(data.slice(m * 256, (m + 1) * 256));
    }
  }

  /** Switch between Classic and TrueColor modes */
  setTrueColorMode(enabled: boolean): void {
    if (this._trueColorMode === enabled) return;
    this._trueColorMode = enabled;
    this.rebuildLightLookup();
  }

  setActivePalette(index: number): void {
    this.activePalette = index;
    const pal = this.palettes[index];
    this.rgbaLookup = new Uint32Array(pal);
    this.rebuildLightLookup();
  }

  /** Rebuild light lookup tables for the current mode and palette */
  private rebuildLightLookup(): void {
    const pal = this.palettes[this.activePalette];
    if (!pal) return;

    if (this._trueColorMode) {
      this.buildTrueColorLookup(pal);
    } else {
      this.buildClassicLookup(pal);
    }
  }

  /** Classic mode: use WAD colormaps (32 levels, palette-quantized) */
  private buildClassicLookup(pal: Uint32Array): void {
    this.lightLookup = [];
    for (let m = 0; m < this.colormaps.length; m++) {
      const lookup = new Uint32Array(256);
      const cmap = this.colormaps[m];
      for (let i = 0; i < 256; i++) {
        lookup[i] = pal[cmap[i]];
      }
      this.lightLookup.push(lookup);
    }
  }

  /**
   * True Color mode: smooth RGB dimming (64 levels).
   * Level 0 = full bright, level 63 = full dark.
   * Each pixel = base palette RGB * (1 - level/63).
   * No palette quantization — full 16M color output.
   */
  private buildTrueColorLookup(pal: Uint32Array): void {
    this.lightLookup = [];
    const levels = TRUECOLOR_COLORMAPS;
    // Minimum brightness factor (13/256 ≈ 5%) prevents fully black sectors,
    // matching DOOM's WAD colormap 31 which retains some visibility.
    const MIN_FACTOR = 13;

    for (let m = 0; m < levels; m++) {
      const lookup = new Uint32Array(256);
      // Integer factor 0-256 (256 = full bright, MIN_FACTOR = darkest)
      const rawFactor = Math.round(((levels - 1 - m) / (levels - 1)) * 256);
      const factor = Math.max(rawFactor, MIN_FACTOR);

      for (let i = 0; i < 256; i++) {
        const rgba = pal[i];
        const r = (((rgba & 0xFF) * factor) >> 8) & 0xFF;
        const g = ((((rgba >> 8) & 0xFF) * factor) >> 8) & 0xFF;
        const b = ((((rgba >> 16) & 0xFF) * factor) >> 8) & 0xFF;
        lookup[i] = (255 << 24) | (b << 16) | (g << 8) | r;
      }
      this.lightLookup.push(lookup);
    }
  }

  /** Get RGBA uint32 for a palette index with a given colormap level */
  getColor(paletteIdx: number, colormapIdx: number): number {
    return this.lightLookup[colormapIdx][paletteIdx];
  }

  /** Get a colormap lookup table for a given light level (0=bright, max=dark) */
  getColormapLookup(level: number): Uint32Array {
    const maxLevel = this.lightLookup.length - 1;
    const clamped = Math.max(0, Math.min(level, maxLevel));
    return this.lightLookup[clamped];
  }
}
