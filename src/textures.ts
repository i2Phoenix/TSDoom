// ============================================================
// Texture & Flat Parser
// Reference: r_data.c — TEXTURE1, TEXTURE2, PNAMES, patch_t
// ============================================================

import { WAD } from './wad';

// A patch column post
export interface Post {
  topDelta: number;
  length: number;
  data: Uint8Array;
}

// A patch column is a list of posts
export type PatchColumn = Post[];

// Parsed patch (sprite/texture patch)
export interface Patch {
  width: number;
  height: number;
  leftOffset: number;
  topOffset: number;
  columns: PatchColumn[];
}

// Composite texture
export interface Texture {
  name: string;
  width: number;
  height: number;
  /** Pre-composed column data: array of columns, each column is Uint8Array of height pixels */
  columns: Uint8Array[];
  /** Transparency mask: parallel to columns, 1 = opaque pixel written by a patch, 0 = transparent/unfilled */
  columnMask: Uint8Array[];
}

// Flat texture (64×64 raw pixels)
export interface Flat {
  name: string;
  data: Uint8Array; // 4096 bytes (64×64)
}

export class TextureData {
  private wad: WAD;
  /** Patch names from PNAMES */
  patchNames: string[] = [];
  /** Composite textures */
  textures: Texture[] = [];
  /** Texture name → index map */
  textureMap: Map<string, number> = new Map();
  /** Flat name → flat data */
  flats: Map<string, Flat> = new Map();
  /** Flat list for numeric indexing */
  flatList: Flat[] = [];
  /** Flat name → index */
  flatMap: Map<string, number> = new Map();
  /** Parsed patch cache */
  private patchCache: Map<number, Patch> = new Map();

  constructor(wad: WAD) {
    this.wad = wad;
    this.loadPNames();
    this.loadTextures('TEXTURE1');
    if (wad.checkNumForName('TEXTURE2') !== -1) {
      this.loadTextures('TEXTURE2');
    }
    this.loadFlats();
    console.log(`Textures: ${this.textures.length}, Flats: ${this.flatList.length}`);
  }

  private loadPNames(): void {
    const data = this.wad.getLumpByName('PNAMES');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getInt32(0, true);
    for (let i = 0; i < count; i++) {
      let name = '';
      for (let j = 0; j < 8; j++) {
        const c = data[4 + i * 8 + j];
        if (c === 0) break;
        name += String.fromCharCode(c);
      }
      this.patchNames.push(name.toUpperCase());
    }
  }

  private loadTextures(lumpName: string): void {
    const data = this.wad.getLumpByName(lumpName);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const numTextures = view.getInt32(0, true);

    for (let i = 0; i < numTextures; i++) {
      const offset = view.getInt32(4 + i * 4, true);

      // Read texture header
      let name = '';
      for (let j = 0; j < 8; j++) {
        const c = data[offset + j];
        if (c === 0) break;
        name += String.fromCharCode(c);
      }
      name = name.toUpperCase();

      // Skip masked (4 bytes) at offset+8
      const width = view.getInt16(offset + 12, true);
      const height = view.getInt16(offset + 14, true);
      // Skip columndirectory (4 bytes) at offset+16
      const patchCount = view.getInt16(offset + 20, true);

      // Read patches
      const patches: Array<{
        originX: number;
        originY: number;
        patchIdx: number;
      }> = [];

      for (let p = 0; p < patchCount; p++) {
        const pp = offset + 22 + p * 10;
        patches.push({
          originX: view.getInt16(pp, true),
          originY: view.getInt16(pp + 2, true),
          patchIdx: view.getInt16(pp + 4, true),
          // stepdir (2 bytes) and colormap (2 bytes) unused
        });
      }

      // Compose texture columns with transparency mask
      const columns: Uint8Array[] = [];
      const columnMask: Uint8Array[] = [];
      for (let x = 0; x < width; x++) {
        const col = new Uint8Array(height);
        const mask = new Uint8Array(height); // 0 = transparent, 1 = opaque
        col.fill(0);
        mask.fill(0);

        // Composite all patches for this column
        for (const patch of patches) {
          const px = x - patch.originX;
          if (px < 0) continue;

          const patchData = this.getPatch(patch.patchIdx);
          if (!patchData || px >= patchData.width) continue;

          const patchCol = patchData.columns[px];
          for (const post of patchCol) {
            for (let dy = 0; dy < post.length; dy++) {
              const ty = patch.originY + post.topDelta + dy;
              if (ty >= 0 && ty < height) {
                col[ty] = post.data[dy];
                mask[ty] = 1; // mark as opaque
              }
            }
          }
        }

        columns.push(col);
        columnMask.push(mask);
      }

      this.textureMap.set(name, this.textures.length);
      this.textures.push({ name, width, height, columns, columnMask });
    }
  }

  /** Parse a patch from it's PNAMES index */
  getPatch(pnamesIndex: number): Patch | null {
    if (this.patchCache.has(pnamesIndex)) {
      return this.patchCache.get(pnamesIndex)!;
    }

    const patchName = this.patchNames[pnamesIndex];
    const lumpIdx = this.wad.checkNumForName(patchName);
    if (lumpIdx === -1) return null;

    const patch = this.parsePatchLump(lumpIdx);
    this.patchCache.set(pnamesIndex, patch);
    return patch;
  }

  /** Parse a patch from a lump index */
  parsePatchLump(lumpIdx: number): Patch {
    const data = this.wad.getLumpData(lumpIdx);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const width = view.getInt16(0, true);
    const height = view.getInt16(2, true);
    const leftOffset = view.getInt16(4, true);
    const topOffset = view.getInt16(6, true);

    const columns: PatchColumn[] = [];

    for (let x = 0; x < width; x++) {
      const colOffset = view.getUint32(8 + x * 4, true);
      const col: PatchColumn = [];

      let ptr = colOffset;
      while (true) {
        const topDelta = data[ptr++];
        if (topDelta === 0xFF) break; // End of column

        const length = data[ptr++];
        ptr++; // Skip padding byte

        const postData = data.slice(ptr, ptr + length);
        col.push({ topDelta, length, data: postData });

        ptr += length;
        ptr++; // Skip padding byte
      }

      columns.push(col);
    }

    return { width, height, leftOffset, topOffset, columns };
  }

  private loadFlats(): void {
    // Flats are between F_START and F_END markers
    const fStart = this.wad.checkNumForName('F_START');
    const fEnd = this.wad.checkNumForName('F_END');
    if (fStart === -1 || fEnd === -1) return;

    for (let i = fStart + 1; i < fEnd; i++) {
      const lump = this.wad.lumps[i];
      if (lump.size === 0) continue; // marker lump
      if (lump.size !== 4096) continue; // not a flat (64×64)

      const name = lump.name;
      const flat: Flat = {
        name,
        data: this.wad.getLumpData(i),
      };
      this.flatMap.set(name, this.flatList.length);
      this.flatList.push(flat);
      this.flats.set(name, flat);
    }
  }

  /** Get texture index for name. Returns 0 for '-' or empty string. */
  textureNumForName(name: string): number {
    if (!name || name === '-' || name.trim() === '') return 0;
    const idx = this.textureMap.get(name.toUpperCase().replace(/\0+$/, ''));
    return idx !== undefined ? idx : 0;
  }

  /** Get flat index for name */
  flatNumForName(name: string): number {
    const idx = this.flatMap.get(name.toUpperCase().replace(/\0+$/, ''));
    return idx !== undefined ? idx : 0;
  }
}
