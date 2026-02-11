// ============================================================
// WAD File Parser
// Handles WAD file header, directory, and lump I/O
// Reference: w_wad.c / w_wad.h
// ============================================================

export interface LumpInfo {
  name: string;
  offset: number;
  size: number;
}

export class WAD {
  private data: DataView;
  private buffer: ArrayBuffer;
  readonly lumps: LumpInfo[] = [];
  private lumpMap: Map<string, number> = new Map();

  constructor(buffer: ArrayBuffer) {
    this.buffer = buffer;
    this.data = new DataView(buffer);
    this.parseHeader();
  }

  private parseHeader(): void {
    // Read identification (4 bytes: "IWAD" or "PWAD")
    const id = this.readString(0, 4);
    if (id !== 'IWAD' && id !== 'PWAD') {
      throw new Error(`Invalid WAD: expected IWAD/PWAD, got "${id}"`);
    }

    const numLumps = this.data.getInt32(4, true);
    const dirOffset = this.data.getInt32(8, true);

    // Parse directory
    for (let i = 0; i < numLumps; i++) {
      const entryOffset = dirOffset + i * 16;
      const filepos = this.data.getInt32(entryOffset, true);
      const size = this.data.getInt32(entryOffset + 4, true);
      const name = this.readString(entryOffset + 8, 8).replace(/\0+$/, '').toUpperCase();

      this.lumps.push({ name, offset: filepos, size });
      // Store last occurrence (later lumps override earlier ones)
      this.lumpMap.set(name, i);
    }

    console.log(`WAD loaded: ${id}, ${numLumps} lumps`);
  }

  private readString(offset: number, length: number): string {
    let s = '';
    for (let i = 0; i < length; i++) {
      const c = this.data.getUint8(offset + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** Returns -1 if not found */
  checkNumForName(name: string): number {
    const idx = this.lumpMap.get(name.toUpperCase());
    return idx !== undefined ? idx : -1;
  }

  getNumForName(name: string): number {
    const idx = this.checkNumForName(name);
    if (idx === -1) throw new Error(`Lump not found: ${name}`);
    return idx;
  }

  getLumpData(lump: number): Uint8Array {
    const info = this.lumps[lump];
    return new Uint8Array(this.buffer, info.offset, info.size);
  }

  getLumpByName(name: string): Uint8Array {
    return this.getLumpData(this.getNumForName(name));
  }

  getLumpLength(lump: number): number {
    return this.lumps[lump].size;
  }

  getLumpView(lump: number): DataView {
    const info = this.lumps[lump];
    return new DataView(this.buffer, info.offset, info.size);
  }
}

export async function loadWAD(url: string): Promise<WAD> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load WAD: ${resp.statusText}`);
  const buffer = await resp.arrayBuffer();
  return new WAD(buffer);
}
