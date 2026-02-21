// ============================================================
// Map Data Parser
// Reference: doomdata.h, p_setup.c, r_defs.h
// ============================================================

import { WAD } from './wad';
import { TextureData } from './textures';
import { FRACBITS, FRACUNIT } from '../game/math';

// Re-export all types and constants from game/map-types.ts
// so that src/ modules can continue importing from './map'
export {
  ML_BLOCKING, ML_BLOCKMONSTERS, ML_TWOSIDED, ML_DONTPEGTOP,
  ML_DONTPEGBOTTOM, ML_SECRET, ML_SOUNDBLOCK, ML_DONTDRAW, ML_MAPPED,
  NF_SUBSECTOR, incValidcount,
} from '../game/map-types';
export type {
  Vertex, Sector, SideDef, LineDef, Seg, SubSector, Node, MapThing, GameMap,
} from '../game/map-types';

import type { Vertex, Sector, SideDef, LineDef, Seg, SubSector, Node, MapThing, GameMap } from '../game/map-types';
import { ML_TWOSIDED, NF_SUBSECTOR, incValidcount } from '../game/map-types';
import type { GameInstance } from '../game/game-instance';

// Map lump ordering (relative to map label)
const ML_THINGS = 1;
const ML_LINEDEFS = 2;
const ML_SIDEDEFS = 3;
const ML_VERTEXES = 4;
const ML_SEGS = 5;
const ML_SSECTORS = 6;
const ML_NODES = 7;
const ML_SECTORS = 8;
const ML_REJECT = 9;
const ML_BLOCKMAP = 10;

// Block size for blockmap (128 map units)
const MAPBLOCKSHIFT = FRACBITS + 7; // FRACBITS + log2(128)

export class GameMapImpl implements GameMap {
  name: string;
  vertices: Vertex[] = [];
  sectors: Sector[] = [];
  sidedefs: SideDef[] = [];
  linedefs: LineDef[] = [];
  segs: Seg[] = [];
  subsectors: SubSector[] = [];
  nodes: Node[] = [];
  things: MapThing[] = [];
  blockmap: Int16Array = new Int16Array(0);
  blockmapLump: Int16Array = new Int16Array(0);
  bmapOrgX = 0;
  bmapOrgY = 0;
  bmapWidth = 0;
  bmapHeight = 0;
  rejectMatrix: Uint8Array = new Uint8Array(0);

  constructor(
    private wad: WAD,
    private texData: TextureData,
    mapName: string
  ) {
    this.name = mapName;
    const lumpNum = wad.getNumForName(mapName);
    this.loadVertexes(lumpNum + ML_VERTEXES);
    this.loadSectors(lumpNum + ML_SECTORS);
    this.loadSideDefs(lumpNum + ML_SIDEDEFS);
    this.loadLineDefs(lumpNum + ML_LINEDEFS);
    this.loadSubSectors(lumpNum + ML_SSECTORS);
    this.loadNodes(lumpNum + ML_NODES);
    this.loadSegs(lumpNum + ML_SEGS);
    this.loadThings(lumpNum + ML_THINGS);
    this.loadBlockmap(lumpNum + ML_BLOCKMAP);
    this.rejectMatrix = wad.getLumpData(lumpNum + ML_REJECT);

    // Link subsector → sector via first seg
    for (const ss of this.subsectors) {
      if (ss.firstSeg < this.segs.length) {
        ss.sector = this.segs[ss.firstSeg].frontsector;
      }
    }

    console.log(`Map ${mapName}: ${this.vertices.length} vertices, ${this.linedefs.length} linedefs, ${this.sectors.length} sectors, ${this.segs.length} segs, ${this.subsectors.length} subsectors, ${this.nodes.length} nodes, ${this.things.length} things`);
  }

  private readShort(data: Uint8Array, off: number): number {
    const v = data[off] | (data[off + 1] << 8);
    return v > 32767 ? v - 65536 : v;
  }

  private readUShort(data: Uint8Array, off: number): number {
    return data[off] | (data[off + 1] << 8);
  }

  private readString(data: Uint8Array, off: number, len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = data[off + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.toUpperCase();
  }

  private loadVertexes(lump: number): void {
    const data = this.wad.getLumpData(lump);
    const count = Math.floor(data.length / 4); // 2 shorts per vertex
    for (let i = 0; i < count; i++) {
      const x = this.readShort(data, i * 4) << FRACBITS;
      const y = this.readShort(data, i * 4 + 2) << FRACBITS;
      this.vertices.push({ x, y });
    }
  }

  private loadSectors(lump: number): void {
    const data = this.wad.getLumpData(lump);
    const size = 26; // sizeof mapsector_t
    const count = Math.floor(data.length / size);
    for (let i = 0; i < count; i++) {
      const off = i * size;
      const floorPicName = this.readString(data, off + 4, 8);
      const ceilingPicName = this.readString(data, off + 12, 8);
      this.sectors.push({
        floorHeight: this.readShort(data, off) << FRACBITS,
        ceilingHeight: this.readShort(data, off + 2) << FRACBITS,
        floorPic: this.texData.flatNumForName(floorPicName),
        ceilingPic: this.texData.flatNumForName(ceilingPicName),
        lightLevel: this.readShort(data, off + 20),
        special: this.readShort(data, off + 22),
        tag: this.readShort(data, off + 24),
        floorPicName,
        ceilingPicName,
        soundtarget: null,
        soundtraversed: 0,
        validcount: 0,
      });
    }
  }

  private loadSideDefs(lump: number): void {
    const data = this.wad.getLumpData(lump);
    const size = 30; // sizeof mapsidedef_t
    const count = Math.floor(data.length / size);
    for (let i = 0; i < count; i++) {
      const off = i * size;
      const topName = this.readString(data, off + 4, 8);
      const bottomName = this.readString(data, off + 12, 8);
      const midName = this.readString(data, off + 20, 8);
      const sectorIdx = this.readShort(data, off + 28);
      this.sidedefs.push({
        textureOffset: this.readShort(data, off) << FRACBITS,
        rowOffset: this.readShort(data, off + 2) << FRACBITS,
        topTexture: this.texData.textureNumForName(topName),
        bottomTexture: this.texData.textureNumForName(bottomName),
        midTexture: this.texData.textureNumForName(midName),
        sectorIdx,
        sector: this.sectors[sectorIdx],
        topTextureName: topName,
        bottomTextureName: bottomName,
        midTextureName: midName,
      });
    }
  }

  private loadLineDefs(lump: number): void {
    const data = this.wad.getLumpData(lump);
    const size = 14; // sizeof maplinedef_t
    const count = Math.floor(data.length / size);
    for (let i = 0; i < count; i++) {
      const off = i * size;
      const v1idx = this.readUShort(data, off);
      const v2idx = this.readUShort(data, off + 2);
      const sidenum0 = this.readShort(data, off + 10);
      const sidenum1 = this.readShort(data, off + 12);

      const v1 = this.vertices[v1idx];
      const v2 = this.vertices[v2idx];

      this.linedefs.push({
        v1: v1idx,
        v2: v2idx,
        flags: this.readShort(data, off + 4),
        special: this.readShort(data, off + 6),
        tag: this.readShort(data, off + 8),
        sidenum: [sidenum0, sidenum1],
        frontsector: sidenum0 !== -1 ? this.sidedefs[sidenum0].sector : null,
        backsector: sidenum1 !== -1 ? this.sidedefs[sidenum1].sector : null,
        dx: v2.x - v1.x,
        dy: v2.y - v1.y,
        validcount: 0,
      });
    }
  }

  private loadSegs(lump: number): void {
    const data = this.wad.getLumpData(lump);
    const size = 12; // sizeof mapseg_t
    const count = Math.floor(data.length / size);
    for (let i = 0; i < count; i++) {
      const off = i * size;
      const v1idx = this.readUShort(data, off);
      const v2idx = this.readUShort(data, off + 2);
      const angle = this.readShort(data, off + 4) << 16;
      const linedefIdx = this.readUShort(data, off + 6);
      const side = this.readShort(data, off + 8);
      const segOffset = this.readShort(data, off + 10) << 16;

      const linedef = this.linedefs[linedefIdx];
      const sidedefIdx = linedef.sidenum[side];
      const sidedef = this.sidedefs[sidedefIdx];

      let frontsector = sidedef.sector;
      let backsector: Sector | null = null;
      if (linedef.flags & ML_TWOSIDED) {
        const otherSideIdx = linedef.sidenum[side ^ 1];
        if (otherSideIdx !== -1) {
          backsector = this.sidedefs[otherSideIdx].sector;
        }
      }

      const sv1 = this.vertices[v1idx];
      const sv2 = this.vertices[v2idx];
      // Precompute seg length in map units (not fixed_t)
      const sdx = (sv2.x - sv1.x) / FRACUNIT;
      const sdy = (sv2.y - sv1.y) / FRACUNIT;
      this.segs.push({
        v1: sv1,
        v2: sv2,
        offset: segOffset,
        angle: angle >>> 0,
        sidedef,
        linedef,
        frontsector,
        backsector,
        length: Math.sqrt(sdx * sdx + sdy * sdy),
      });
    }
  }

  private loadSubSectors(lump: number): void {
    const data = this.wad.getLumpData(lump);
    const size = 4;
    const count = Math.floor(data.length / size);
    for (let i = 0; i < count; i++) {
      const off = i * size;
      this.subsectors.push({
        numSegs: this.readUShort(data, off),
        firstSeg: this.readUShort(data, off + 2),
        sector: null,
      });
    }
  }

  private loadNodes(lump: number): void {
    const data = this.wad.getLumpData(lump);
    const size = 28; // sizeof mapnode_t
    const count = Math.floor(data.length / size);
    for (let i = 0; i < count; i++) {
      const off = i * size;
      const bbox: [[number, number, number, number], [number, number, number, number]] = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ];
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 4; k++) {
          bbox[j][k] = this.readShort(data, off + 8 + j * 8 + k * 2) << FRACBITS;
        }
      }
      this.nodes.push({
        x: this.readShort(data, off) << FRACBITS,
        y: this.readShort(data, off + 2) << FRACBITS,
        dx: this.readShort(data, off + 4) << FRACBITS,
        dy: this.readShort(data, off + 6) << FRACBITS,
        bbox,
        children: [
          this.readUShort(data, off + 24),
          this.readUShort(data, off + 26),
        ],
      });
    }
  }

  private loadThings(lump: number): void {
    const data = this.wad.getLumpData(lump);
    const size = 10;
    const count = Math.floor(data.length / size);
    for (let i = 0; i < count; i++) {
      const off = i * size;
      this.things.push({
        x: this.readShort(data, off),
        y: this.readShort(data, off + 2),
        angle: this.readShort(data, off + 4),
        type: this.readShort(data, off + 6),
        options: this.readShort(data, off + 8),
      });
    }
  }

  private loadBlockmap(lump: number): void {
    const data = this.wad.getLumpData(lump);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = Math.floor(data.length / 2);
    const bml = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      bml[i] = view.getInt16(i * 2, true);
    }
    this.blockmapLump = bml;
    this.blockmap = bml.subarray(4);
    this.bmapOrgX = bml[0] << FRACBITS;
    this.bmapOrgY = bml[1] << FRACBITS;
    this.bmapWidth = bml[2];
    this.bmapHeight = bml[3];
  }

  /** Find the subsector containing a point (x,y in fixed-point) */
  pointInSubsector(x: number, y: number): SubSector {
    let nodeIdx = this.nodes.length - 1;
    while (!(nodeIdx & NF_SUBSECTOR)) {
      const node = this.nodes[nodeIdx];
      const side = this.pointOnSide(x, y, node);
      nodeIdx = node.children[side];
    }
    return this.subsectors[nodeIdx & ~NF_SUBSECTOR];
  }

  pointOnSide(x: number, y: number, node: Node): number {
    if (node.dx === 0) {
      return x <= node.x ? (node.dy > 0 ? 1 : 0) : (node.dy < 0 ? 1 : 0);
    }
    if (node.dy === 0) {
      return y <= node.y ? (node.dx < 0 ? 1 : 0) : (node.dx > 0 ? 1 : 0);
    }

    const dx = (x - node.x) | 0;
    const dy = (y - node.y) | 0;

    // Cross product check (with FRACBITS shift to avoid overflow)
    const left = ((node.dy >> FRACBITS) * (dx >> FRACBITS)) | 0;
    const right = ((dy >> FRACBITS) * (node.dx >> FRACBITS)) | 0;

    return right < left ? 0 : 1;
  }

  // ============================================================
  // Blockmap line iterator — P_BlockLinesIterator
  // Reference: p_maputl.c P_BlockLinesIterator
  // ============================================================

  blockLinesIterator(
    bx: number, by: number, vc: number,
    callback: (line: LineDef) => boolean,
  ): boolean {
    if (bx < 0 || by < 0 || bx >= this.bmapWidth || by >= this.bmapHeight) {
      return true;
    }

    let offset = this.blockmap[by * this.bmapWidth + bx];
    const bml = this.blockmapLump;
    for (let i = offset; ; i++) {
      if (i >= bml.length) break;
      const lineIdx = bml[i];
      if (lineIdx === -1) break;
      if (lineIdx === 0 && i === offset) continue;

      if (lineIdx < 0 || lineIdx >= this.linedefs.length) continue;

      const ld = this.linedefs[lineIdx];
      if (ld.validcount === vc) continue;
      ld.validcount = vc;

      if (!callback(ld)) return false;
    }
    return true;
  }

  forEachBlockLine(
    top: number, bottom: number, left: number, right: number,
    callback: (line: LineDef) => boolean,
    gi: GameInstance,
  ): void {
    const vc = incValidcount(gi);

    const bx0 = Math.max(0, (left - this.bmapOrgX) >> MAPBLOCKSHIFT);
    const bx1 = Math.min(this.bmapWidth - 1, (right - this.bmapOrgX) >> MAPBLOCKSHIFT);
    const by0 = Math.max(0, (bottom - this.bmapOrgY) >> MAPBLOCKSHIFT);
    const by1 = Math.min(this.bmapHeight - 1, (top - this.bmapOrgY) >> MAPBLOCKSHIFT);

    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        if (!this.blockLinesIterator(bx, by, vc, callback)) return;
      }
    }
  }
}
