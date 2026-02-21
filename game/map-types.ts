// ============================================================
// Map Data Types — shared between game/ and src/
// Platform-independent type definitions for map structures.
// Reference: doomdata.h, r_defs.h, p_local.h
// ============================================================

// ---- Linedef flags (from doomdata.h) ----
export const ML_BLOCKING = 1;
export const ML_BLOCKMONSTERS = 2;
export const ML_TWOSIDED = 4;
export const ML_DONTPEGTOP = 8;
export const ML_DONTPEGBOTTOM = 16;
export const ML_SECRET = 32;
export const ML_SOUNDBLOCK = 64;
export const ML_DONTDRAW = 128;
export const ML_MAPPED = 256;

// ---- BSP subsector marker ----
export const NF_SUBSECTOR = 0x8000;

// ---- Global validcount for linedef deduplication ----
import { GameInstance } from './game-instance';

/** Increment and return the global validcount (call before each forEachBlockLine batch) */
export function incValidcount(gi: GameInstance): number {
  return ++gi.validcount;
}

/** Return the current global validcount */
export function getValidcount(gi: GameInstance): number {
  return gi.validcount;
}

// ---- Map data interfaces ----

export interface Vertex {
  x: number; // fixed_t
  y: number;
}

export interface Sector {
  floorHeight: number;   // fixed_t
  ceilingHeight: number; // fixed_t
  floorPic: number;      // flat index
  ceilingPic: number;
  lightLevel: number;
  special: number;
  tag: number;
  // Runtime
  floorPicName: string;
  ceilingPicName: string;
  // AI sound propagation
  soundtarget: unknown | null;
  soundtraversed: number;
  validcount: number;
}

export interface SideDef {
  textureOffset: number;  // fixed_t
  rowOffset: number;      // fixed_t
  topTexture: number;     // texture index
  bottomTexture: number;
  midTexture: number;
  sectorIdx: number;
  sector: Sector;
  // raw names for debugging
  topTextureName: string;
  bottomTextureName: string;
  midTextureName: string;
}

export interface LineDef {
  v1: number; // vertex indices
  v2: number;
  flags: number;
  special: number;
  tag: number;
  sidenum: [number, number]; // -1 for one-sided
  frontsector: Sector | null;
  backsector: Sector | null;
  // Precalculated
  dx: number; // fixed_t
  dy: number;
  // BSP traversal dedup
  validcount: number;
}

export interface Seg {
  v1: Vertex;
  v2: Vertex;
  offset: number;  // fixed_t
  angle: number;   // BAM angle
  sidedef: SideDef;
  linedef: LineDef;
  frontsector: Sector;
  backsector: Sector | null;
  /** Precomputed length in map units (not fixed_t) */
  length: number;
}

export interface SubSector {
  numSegs: number;
  firstSeg: number;
  sector: Sector | null;
}

export interface Node {
  x: number;  // partition line start
  y: number;
  dx: number; // partition line direction
  dy: number;
  bbox: [[number, number, number, number], [number, number, number, number]];
  children: [number, number];
}

export interface MapThing {
  x: number;
  y: number;
  angle: number;
  type: number;
  options: number;
}

// ---- GameMap interface (what game/ modules use) ----

export interface GameMap {
  name: string;
  vertices: Vertex[];
  sectors: Sector[];
  sidedefs: SideDef[];
  linedefs: LineDef[];
  segs: Seg[];
  subsectors: SubSector[];
  nodes: Node[];
  things: MapThing[];
  blockmap: Int16Array;
  blockmapLump: Int16Array;
  bmapOrgX: number;
  bmapOrgY: number;
  bmapWidth: number;
  bmapHeight: number;
  rejectMatrix: Uint8Array;

  pointInSubsector(x: number, y: number): SubSector;
  pointOnSide(x: number, y: number, node: Node): number;
  blockLinesIterator(bx: number, by: number, vc: number, callback: (line: LineDef) => boolean): boolean;
  forEachBlockLine(top: number, bottom: number, left: number, right: number, callback: (line: LineDef) => boolean, gi: GameInstance): void;
}
