// ============================================================
// RenderContext — Encapsulated Renderer State
// Replaces 60+ module-level `let` variables from the old
// monolithic renderer.ts. Every pipeline stage reads/writes
// this shared context instead of file-scope globals.
// ============================================================

import { FRACBITS, FRACUNIT, fixedDiv,
  FINEANGLES,
} from '../../../game/math';
import type { GameMap, Seg, Sector, MapThing } from '../../map';
import type { TextureData, Patch } from '../../textures';
import type { PaletteData } from '../../palette';
import type { WAD } from '../../wad';
import type { SpriteData } from '../sprites';
import { SCREENWIDTH, SCREENHEIGHT } from '../draw';
import type { VfxEffect } from '../../../game/vfx';
import type { DroppedItem } from '../../../game/mobj';
import type { Projectile } from '../../../game/projectiles';

// ---- Constants ----
export const FIELDOFVIEW = 2048;
export const LIGHTLEVELS = 16;
export const LIGHTSEGSHIFT = 4;
export const MAXLIGHTSCALE = 48;
export const LIGHTSCALESHIFT = 12;
export const MAXLIGHTZ = 128;
export const LIGHTZSHIFT = 20;
export const BASE_WIDTH = 320;
export const SKY_FLAT_NAME = 'F_SKY1';
export const MAXDRAWSEGS = 256;
const VISPLANE_POOL_SIZE = 128;
const CLIP_BUF_SIZE_FACTOR = 256;

// ---- Render Mode ----
export type RenderMode = 'normal' | 'depth';

// ---- Data structures ----

export interface DrawSeg {
  seg: Seg;
  x1: number;
  x2: number;
  scale1: number;
  scale2: number;
  scalestep: number;
  maskedTextureCol: Int16Array | null;
  sprTopClip: Int16Array;
  sprBottomClip: Int16Array;
}

export interface ClipRange {
  first: number;
  last: number;
}

export interface Visplane {
  height: number;
  picnum: number;
  lightlevel: number;
  isCeiling: boolean;
  minx: number;
  maxx: number;
  top: Int16Array;
  bottom: Int16Array;
}

export interface VisSprite {
  x1: number;
  x2: number;
  gx: number;
  gy: number;
  gz: number;
  gzt: number;
  scale: number;
  xiscale: number;
  startFrac: number;
  texturemid: number;
  patch: Patch;
  flip: boolean;
  colormap: number;
  dist: number;
  clipOffset: number;
  isFuzz: boolean;
}

export interface ThingEntry {
  thing: MapThing;
  info: { sprite: string; frame: number; radius: number; height: number };
  thingIdx: number;
}

export interface DebugCounters {
  subsectors: number;
  addLineCalls: number;
  backFaceCulled: number;
  clipCulled: number;
  storeWallCalls: number;
  columnsDrawn: number;
  x1GreaterX2: number;
  angleToXResults: any[];
}

// ============================================================
// RenderContext
// ============================================================

export class RenderContext {
  // ---- Render Mode ----
  renderMode: RenderMode = 'normal';

  // ---- View (camera) ----
  viewx = 0;
  viewy = 0;
  viewz = 0;
  viewangle = 0;
  viewsin = 0;
  viewcos = 0;

  // ---- Resolution-dependent ----
  stHeight = Math.round(32 * SCREENWIDTH / BASE_WIDTH);
  viewwidth = SCREENWIDTH;
  viewheight = SCREENHEIGHT - this.stHeight;
  centerx = this.viewwidth >> 1;
  centery = this.viewheight >> 1;
  centerxfrac = this.centerx << FRACBITS;
  centeryfrac = this.centery << FRACBITS;
  projection = this.centerxfrac;

  // ---- Angle/projection tables ----
  clipangle = 0;
  viewangletox = new Int32Array(FINEANGLES / 2);
  xtoviewangle = new Uint32Array(SCREENWIDTH + 1);

  // ---- Light tables ----
  numColormaps = 32;
  scalelight: number[][] = [];
  zlight: number[][] = [];
  extralight = 0;

  // ---- Clip arrays ----
  floorclip = new Int16Array(SCREENWIDTH);
  ceilingclip = new Int16Array(SCREENWIDTH);

  // ---- Drawsegs ----
  drawsegs: DrawSeg[] = [];

  // ---- Solid segs (BSP occlusion) ----
  solidsegs: ClipRange[] = [];

  // ---- Visplanes ----
  visplanePool: Visplane[] = [];
  visplanePoolUsed = 0;
  visplanes: Visplane[] = [];
  curFloorplane: Visplane | null = null;
  curCeilingplane: Visplane | null = null;

  // ---- Plane row tables ----
  planeRowDistance = new Int32Array(0);
  planeRowFloorScale = new Int32Array(0);
  planeRowColormapIdx = new Int32Array(0);
  planeRowValid = new Uint8Array(0);

  // ---- Y-slope / distscale ----
  yslope = new Int32Array(SCREENHEIGHT);
  distscale = new Int32Array(SCREENWIDTH);

  // ---- Vissprites ----
  vissprites: VisSprite[] = [];
  clipBuf: Int16Array;
  clipBufUsed = 0;

  // ---- Seg rendering state ----
  rwAngle1 = 0;
  rwNormalangle = 0;
  rwDistance = 0;
  rwScale = 0;
  rwScalestep = 0;
  rwMidtexturemid = 0;
  rwToptexturemid = 0;
  rwBottomtexturemid = 0;
  rwCenterangle = 0;
  worldtop = 0;
  worldbottom = 0;
  worldhigh = 0;
  worldlow = 0;
  markfloor = false;
  markceiling = false;
  toptexture = 0;
  bottomtexture = 0;
  midtexture = 0;
  curLineWallLightLevel = 0;

  // ---- Data references (bound per level) ----
  map!: GameMap;
  texData!: TextureData;
  palData!: PaletteData;
  wad!: WAD;
  spriteData: SpriteData | null = null;
  skytexture = 0;

  // ---- Subsector → thing maps (rebuilt each frame) ----
  subsectorThings: Map<number, ThingEntry[]> = new Map();
  subsectorVfx: Map<number, VfxEffect[]> = new Map();
  subsectorDrops: Map<number, DroppedItem[]> = new Map();
  subsectorProjectiles: Map<number, Projectile[]> = new Map();

  // ---- Fuzz ----
  fuzzpos = 0;

  // ---- Debug ----
  debugFrame = 0;
  debugCounters: DebugCounters = {
    subsectors: 0,
    addLineCalls: 0,
    backFaceCulled: 0,
    clipCulled: 0,
    storeWallCalls: 0,
    columnsDrawn: 0,
    x1GreaterX2: 0,
    angleToXResults: [],
  };

  // ---- Weapon overlay ----
  pspritePlayer: import('../../../game/weapons').WeaponPlayer | null = null;

  constructor() {
    this.clipBuf = new Int16Array(SCREENWIDTH * CLIP_BUF_SIZE_FACTOR);
    this.initVisplanePool();
  }

  // ---- Visplane pool management ----

  initVisplanePool(): void {
    this.visplanePool.length = 0;
    for (let i = 0; i < VISPLANE_POOL_SIZE; i++) {
      this.visplanePool.push({
        height: 0, picnum: 0, lightlevel: 0, isCeiling: false,
        minx: 0, maxx: 0,
        top: new Int16Array(SCREENWIDTH),
        bottom: new Int16Array(SCREENWIDTH),
      });
    }
    this.visplanePoolUsed = 0;
    this.visplanes.length = 0;
  }

  allocVisplane(): Visplane {
    let vp: Visplane;
    if (this.visplanePoolUsed < this.visplanePool.length) {
      vp = this.visplanePool[this.visplanePoolUsed++];
    } else {
      vp = {
        height: 0, picnum: 0, lightlevel: 0, isCeiling: false,
        minx: 0, maxx: 0,
        top: new Int16Array(SCREENWIDTH),
        bottom: new Int16Array(SCREENWIDTH),
      };
      this.visplanePool.push(vp);
      this.visplanePoolUsed++;
    }
    vp.top.fill(0x7FFF);
    vp.bottom.fill(0);
    vp.minx = this.viewwidth;
    vp.maxx = -1;
    this.visplanes.push(vp);
    return vp;
  }

  resetVisplanePool(): void {
    this.visplanePoolUsed = 0;
    this.visplanes.length = 0;
  }

  // ---- Clip buffer management ----

  allocClip(width: number): number {
    const offset = this.clipBufUsed;
    const need = width * 2;
    if (offset + need > this.clipBuf.length) {
      const newSize = Math.max(this.clipBuf.length * 2, offset + need);
      const newBuf = new Int16Array(newSize);
      newBuf.set(this.clipBuf);
      this.clipBuf = newBuf;
    }
    this.clipBufUsed += need;
    return offset;
  }

  resetClipBuf(): void {
    this.clipBufUsed = 0;
  }

  // ---- Per-frame reset ----

  resetFrame(): void {
    for (let i = 0; i < this.viewwidth; i++) {
      this.floorclip[i] = this.viewheight;
      this.ceilingclip[i] = -1;
    }
    this.resetVisplanePool();
    this.vissprites.length = 0;
    this.resetClipBuf();
    this.drawsegs.length = 0;
    this.solidsegs = [
      { first: -0x7FFFFFFF, last: -1 },
      { first: this.viewwidth, last: 0x7FFFFFFF },
    ];
    this.curFloorplane = null;
    this.curCeilingplane = null;

    this.debugCounters.subsectors = 0;
    this.debugCounters.addLineCalls = 0;
    this.debugCounters.backFaceCulled = 0;
    this.debugCounters.clipCulled = 0;
    this.debugCounters.storeWallCalls = 0;
    this.debugCounters.columnsDrawn = 0;
    this.debugCounters.x1GreaterX2 = 0;
    this.debugCounters.angleToXResults = [];
  }

  // ---- Resolution change ----

  updateResolution(): void {
    this.stHeight = Math.round(32 * SCREENWIDTH / BASE_WIDTH);
    this.viewwidth = SCREENWIDTH;
    this.viewheight = SCREENHEIGHT - this.stHeight;
    this.centerx = this.viewwidth >> 1;
    this.centery = this.viewheight >> 1;
    this.centerxfrac = this.centerx << FRACBITS;
    this.centeryfrac = this.centery << FRACBITS;
    this.projection = this.centerxfrac;

    this.viewangletox = new Int32Array(FINEANGLES / 2);
    this.xtoviewangle = new Uint32Array(SCREENWIDTH + 1);
    this.floorclip = new Int16Array(SCREENWIDTH);
    this.ceilingclip = new Int16Array(SCREENWIDTH);
    this.yslope = new Int32Array(SCREENHEIGHT);
    this.distscale = new Int32Array(SCREENWIDTH);
    this.clipBuf = new Int16Array(SCREENWIDTH * CLIP_BUF_SIZE_FACTOR);

    for (let i = 0; i < this.viewheight; i++) {
      let dy = (((i - this.viewheight / 2) * FRACUNIT + FRACUNIT / 2) | 0);
      dy = Math.abs(dy);
      if (dy < 1) dy = 1;
      this.yslope[i] = fixedDiv((this.viewwidth / 2) * FRACUNIT, dy);
    }
  }

  // ---- Plane row table management ----

  ensurePlaneRowTables(): void {
    if (this.planeRowDistance.length < this.viewheight) {
      this.planeRowDistance = new Int32Array(this.viewheight);
      this.planeRowFloorScale = new Int32Array(this.viewheight);
      this.planeRowColormapIdx = new Int32Array(this.viewheight);
      this.planeRowValid = new Uint8Array(this.viewheight);
    }
    this.planeRowValid.fill(0);
  }
}
