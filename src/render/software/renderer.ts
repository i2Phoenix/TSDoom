// ============================================================
// BSP Renderer
// Reference: r_main.c, r_bsp.c, r_segs.c, r_plane.c
// ============================================================

import { GameMap, NF_SUBSECTOR, Seg, Sector, MapThing } from '../../map';
import { TextureData, Patch } from '../../textures';
import { PaletteData } from '../../palette';
import { WAD } from '../../wad';
import {
  FRACBITS, FRACUNIT, ANG90, ANG180, ANG270,
  ANGLETOFINESHIFT, FINEANGLES, FINEMASK,
  finesine, finecosine, finetangent, tantoangle,
  fixedMul, fixedDiv, pointToAngle, slopeDiv,
} from '../../../game/math';
import {
  SCREENWIDTH, SCREENHEIGHT, rgbaBuffer, zBuffer, ZFLAG_WALL, Z_DEPTH_MASK,
  clearScreen, dc, setZScale,
  drawColumnDeferred, drawMaskedColumnDeferred,
  writeGBufferFloorPixel, writeGBufferSpritePixel,
} from './draw';
import { gBuffer, initGBuffer, SurfaceType } from './gbuffer';
import { SpriteData, THING_INFO } from './sprites';
import { getAnimatedFlat, getAnimatedTexture, getThingAnimFrame } from '../../../game/animations';
import { removedThings } from '../../../game/pickups';
import { getActiveVfx, getVfxSprite, VfxEffect } from '../../../game/vfx';
import { getDroppedItems, DroppedItem, getMapObjectByThingIndex } from '../../../game/mobj';
import { getActiveProjectiles, getProjectileSprite, Projectile } from '../../../game/projectiles';
import { MF_SHADOW } from '../../../game/mobjinfo';
import { shouldSpawnThing } from '../../../game/skill';
import { profilerBegin, profilerEnd } from '../../../game/profiler';

// ---- Constants ----
const FIELDOFVIEW = 2048;  // half FOV in fine angles
const LIGHTLEVELS = 16;
const LIGHTSEGSHIFT = 4;
const MAXLIGHTSCALE = 48;
const LIGHTSCALESHIFT = 12;
const MAXLIGHTZ = 128;
const LIGHTZSHIFT = 20;
let NUMCOLORMAPS = 32;   // updated dynamically from palData.numColormaps
const BASE_WIDTH = 320;  // reference width for resolution-independent lighting
const SKY_FLAT_NAME = 'F_SKY1';

// ---- Render Mode ----
export type RenderMode = 'normal' | 'depth';
let renderMode: RenderMode = 'normal';

/** Cycle render mode: Normal -> Depth -> Normal */
export function cycleRenderMode(): void {
  renderMode = renderMode === 'normal' ? 'depth' : 'normal';
}

/** Get current render mode */
export function getRenderMode(): RenderMode {
  return renderMode;
}

// ---- View ----
let viewx = 0;
let viewy = 0;
let viewz = 0;
let viewangle = 0;
let viewsin = 0;
let viewcos = 0;
let ST_HEIGHT = Math.round(32 * SCREENWIDTH / 320);
let viewwidth = SCREENWIDTH;
let viewheight = SCREENHEIGHT - ST_HEIGHT;
let centerx = viewwidth >> 1;
let centery = viewheight >> 1;
let centerxfrac = centerx << FRACBITS;
let centeryfrac = centery << FRACBITS;
let projection = centerxfrac;

// ---- Angle Lookup ----
let clipangle = 0;
let viewangletox = new Int32Array(FINEANGLES / 2);
let xtoviewangle = new Uint32Array(SCREENWIDTH + 1);

// ---- Light Tables ----
const scalelight: number[][] = [];
const zlight: number[][] = [];

// ---- Clip ----
let floorclip = new Int16Array(SCREENWIDTH);
let ceilingclip = new Int16Array(SCREENWIDTH);

// ---- Drawsegs (for masked midtextures) ----
// Reference: r_segs.c drawseg_t, r_things.c R_DrawMasked
interface DrawSeg {
  seg: Seg;
  x1: number;
  x2: number;
  scale1: number;
  scale2: number;
  scalestep: number;
  maskedTextureCol: Int16Array | null; // texture column per screen x
  sprTopClip: Int16Array;    // snapshot of ceilingclip at render time
  sprBottomClip: Int16Array; // snapshot of floorclip at render time
}

const MAXDRAWSEGS = 256;
let drawsegs: DrawSeg[] = [];

interface ClipRange { first: number; last: number; }
let solidsegs: ClipRange[] = [];

// ---- Visplanes ----
interface Visplane {
  height: number;
  picnum: number;
  lightlevel: number;
  isCeiling: boolean;
  minx: number;
  maxx: number;
  top: Int16Array;
  bottom: Int16Array;
}

// Visplane pool — reuse objects and their Int16Arrays instead of allocating new ones
const VISPLANE_POOL_SIZE = 128;
const visplanePool: Visplane[] = [];
let visplanePoolUsed = 0;
let visplanes: Visplane[] = [];

function initVisplanePool(): void {
  visplanePool.length = 0;
  for (let i = 0; i < VISPLANE_POOL_SIZE; i++) {
    visplanePool.push({
      height: 0, picnum: 0, lightlevel: 0, isCeiling: false,
      minx: 0, maxx: -1,
      top: new Int16Array(SCREENWIDTH),
      bottom: new Int16Array(SCREENWIDTH),
    });
  }
}

function allocVisplane(): Visplane {
  if (visplanePoolUsed < visplanePool.length) {
    const vp = visplanePool[visplanePoolUsed++];
    // Resize arrays if resolution changed
    if (vp.top.length !== SCREENWIDTH) {
      vp.top = new Int16Array(SCREENWIDTH);
      vp.bottom = new Int16Array(SCREENWIDTH);
    }
    return vp;
  }
  // Fallback: allocate new (shouldn't happen with enough pool size)
  const vp: Visplane = {
    height: 0, picnum: 0, lightlevel: 0, isCeiling: false,
    minx: 0, maxx: -1,
    top: new Int16Array(SCREENWIDTH),
    bottom: new Int16Array(SCREENWIDTH),
  };
  visplanePool.push(vp);
  visplanePoolUsed = visplanePool.length;
  return vp;
}

function resetVisplanePool(): void {
  visplanePoolUsed = 0;
  visplanes.length = 0;
}

// ---- Y Slope (for floor/ceiling) ----
let yslope = new Int32Array(SCREENHEIGHT);
let distscale = new Int32Array(SCREENWIDTH);

// ---- Module refs ----
let map: GameMap;
let texData: TextureData;
let palData: PaletteData;
let wad: WAD;
// Sprite data
let spriteData: SpriteData | null = null;
let subsectorThings: Map<number, {thing: MapThing, info: {sprite: string, frame: number, radius: number, height: number}, thingIdx: number}[]> = new Map();
let subsectorVfx: Map<number, VfxEffect[]> = new Map();
let subsectorDrops: Map<number, DroppedItem[]> = new Map();
let subsectorProjectiles: Map<number, Projectile[]> = new Map();
let skytexture = 0;

// ---- Vissprites ----
interface VisSprite {
  x1: number;       // left screen x (clamped to viewport)
  x2: number;       // right screen x (clamped to viewport)
  gx: number;       // thing world x (fixed)
  gy: number;       // thing world y (fixed)
  gz: number;       // thing bottom z (fixed)
  gzt: number;      // thing top z (fixed)
  scale: number;    // screen scale (fixed)
  xiscale: number;  // inverse scale (fixed), negative if flipped
  startFrac: number; // starting texture column frac (fixed), adjusted for left clipping
  texturemid: number; // fixed
  patch: Patch;
  flip: boolean;
  colormap: number; // light level
  dist: number;     // distance for sorting
  clipOffset: number; // offset into shared clip buffer (floor then ceiling, each x2-x1+1)
  isFuzz: boolean;  // true for MF_SHADOW things (Spectre, invisible player)
}
let vissprites: VisSprite[] = [];

// Shared clip buffer for sprite floor/ceiling snapshots (avoids per-sprite allocation)
// Layout: for each sprite, clipBuf[offset..offset+width-1] = floor, [offset+width..offset+2*width-1] = ceiling
const CLIP_BUF_SIZE = SCREENWIDTH * 256; // enough for ~128 sprites at full width
let clipBuf = new Int16Array(CLIP_BUF_SIZE);
let clipBufUsed = 0;

function allocClip(width: number): number {
  const need = width * 2; // floor + ceiling
  if (clipBufUsed + need > clipBuf.length) {
    // Grow buffer if needed (rare)
    const newBuf = new Int16Array(clipBuf.length * 2);
    newBuf.set(clipBuf);
    clipBuf = newBuf;
  }
  const offset = clipBufUsed;
  clipBufUsed += need;
  return offset;
}

function resetClipBuf(): void {
  clipBufUsed = 0;
}

// ---- Seg rendering state ----
let rw_angle1 = 0;
let rw_normalangle = 0;
let rw_distance = 0;
let rw_scale = 0;
let rw_scalestep = 0;
let rw_midtexturemid = 0;
let rw_toptexturemid = 0;
let rw_bottomtexturemid = 0;
let worldtop = 0;
let worldbottom = 0;
let worldhigh = 0;
let worldlow = 0;
let markfloor = false;
let markceiling = false;
let toptexture = 0;
let bottomtexture = 0;
let midtexture = 0;
let curLineWallLightLevel = 0;

// ===========================================================
// Initialization
// ===========================================================

export function initRenderer(m: GameMap, t: TextureData, p: PaletteData, w?: WAD): void {
  map = m;
  texData = t;
  palData = p;
  if (w) wad = w;
  NUMCOLORMAPS = palData.numColormaps;
  skytexture = texData.textureMap.get('SKY1') ?? 0;
  initGBuffer(SCREENWIDTH, SCREENHEIGHT);
  initVisplanePool();
  if (wad) spriteData = new SpriteData(wad, texData);

  // Build subsector → things map
  subsectorThings.clear();
  let thingsWithInfo = 0;
  for (const thing of map.things) {
    // Skip player starts (types 1-4) and deathmatch starts (type 11)
    if (thing.type <= 4 || thing.type === 11) continue;
    // Difficulty filter: skip things not present on current skill
    if (!shouldSpawnThing(thing.options)) continue;
    const info = THING_INFO[thing.type];
    if (!info) continue;
    thingsWithInfo++;
    const ss = map.pointInSubsector(thing.x << FRACBITS, thing.y << FRACBITS);
    const ssIdx = map.subsectors.indexOf(ss);
    if (ssIdx < 0) continue;
    if (!subsectorThings.has(ssIdx)) subsectorThings.set(ssIdx, []);
    const thingIdx = map.things.indexOf(thing);
    subsectorThings.get(ssIdx)!.push({thing, info, thingIdx});
  }
  console.log(`[sprites] subsectorThings built: ${thingsWithInfo} things with info, ${subsectorThings.size} subsectors with things, total entries: ${Array.from(subsectorThings.values()).reduce((s,a) => s+a.length, 0)}`);

  // Recompute resolution-dependent view parameters
  ST_HEIGHT = Math.round(32 * SCREENWIDTH / 320);
  viewwidth = SCREENWIDTH;
  viewheight = SCREENHEIGHT - ST_HEIGHT;
  centerx = viewwidth >> 1;
  centery = viewheight >> 1;
  centerxfrac = centerx << FRACBITS;
  centeryfrac = centery << FRACBITS;
  projection = centerxfrac;

  // Reallocate resolution-dependent arrays
  viewangletox = new Int32Array(FINEANGLES / 2);
  xtoviewangle = new Uint32Array(SCREENWIDTH + 1);
  floorclip = new Int16Array(SCREENWIDTH);
  ceilingclip = new Int16Array(SCREENWIDTH);
  yslope = new Int32Array(SCREENHEIGHT);
  distscale = new Int32Array(SCREENWIDTH);

  initTextureMapping();
  initLightTables();

  // Set draw module's centery for correct texture mapping
  dc.centery = centery;

  // yslope for floor/ceiling distance
  for (let i = 0; i < viewheight; i++) {
    let dy = (((i - viewheight / 2) * FRACUNIT + FRACUNIT / 2) | 0);
    dy = Math.abs(dy);
    if (dy < 1) dy = 1;
    yslope[i] = fixedDiv((viewwidth / 2) * FRACUNIT, dy);
  }

  // distscale for floor/ceiling
  for (let i = 0; i < viewwidth; i++) {
    const cosadj = Math.abs(finecosine((xtoviewangle[i] >>> ANGLETOFINESHIFT) & FINEMASK));
    distscale[i] = cosadj > 256 ? fixedDiv(FRACUNIT, cosadj) : FRACUNIT;
  }
}

/**
 * Rebuild subsector assignments for monsters that have MapObjState (moved at runtime).
 * Called each frame before BSP traversal.
 */
function updateSubsectorThings(): void {
  // Rebuild entire subsectorThings map using runtime positions from MapObjState
  subsectorThings.clear();
  for (let i = 0; i < map.things.length; i++) {
    const thing = map.things[i];
    if (thing.type <= 4 || thing.type === 11) continue;
    if (!shouldSpawnThing(thing.options)) continue;
    const info = THING_INFO[thing.type];
    if (!info) continue;

    // Check if this thing has a runtime MapObjState (monster/barrel)
    const mobj = getMapObjectByThingIndex(i);
    // Skip removed things only — dead things still render their corpse sprite
    if (mobj && mobj.removed) continue;

    // Use runtime position if available, otherwise static spawn position
    const wx = mobj ? mobj.x : (thing.x << FRACBITS);
    const wy = mobj ? mobj.y : (thing.y << FRACBITS);

    const ss = map.pointInSubsector(wx, wy);
    const ssIdx = map.subsectors.indexOf(ss);
    if (ssIdx < 0) continue;
    if (!subsectorThings.has(ssIdx)) subsectorThings.set(ssIdx, []);
    subsectorThings.get(ssIdx)!.push({thing, info, thingIdx: i});
  }
}

function initTextureMapping(): void {
  // Build viewangletox table
  // This maps fine angles in the range [0, FINEANGLES/2) to screen X
  const focallength = fixedDiv(centerxfrac, finetangent[FINEANGLES / 4 + FIELDOFVIEW / 2] || 1);

  for (let i = 0; i < FINEANGLES / 2; i++) {
    const ft = finetangent[i] || 0;
    let t: number;
    if (ft > FRACUNIT * 2) {
      t = -1;
    } else if (ft < -FRACUNIT * 2) {
      t = viewwidth + 1;
    } else {
      t = fixedMul(ft, focallength);
      t = ((centerxfrac - t + FRACUNIT - 1) >> FRACBITS) | 0;
      if (t < -1) t = -1;
      else if (t > viewwidth + 1) t = viewwidth + 1;
    }
    viewangletox[i] = t;
  }

  // Build xtoviewangle table (reverse mapping)
  for (let x = 0; x <= viewwidth; x++) {
    let i = 0;
    while (i < FINEANGLES / 2 && viewangletox[i] > x) i++;
    xtoviewangle[x] = ((i << ANGLETOFINESHIFT) - ANG90) >>> 0;
  }

  // Clamp viewangletox edges
  for (let i = 0; i < FINEANGLES / 2; i++) {
    if (viewangletox[i] === -1) viewangletox[i] = 0;
    else if (viewangletox[i] === viewwidth + 1) viewangletox[i] = viewwidth;
  }

  clipangle = xtoviewangle[0];
}

function initLightTables(): void {
  for (let i = 0; i < LIGHTLEVELS; i++) {
    scalelight[i] = [];
    const startmap = ((LIGHTLEVELS - 1 - i) * 2) * NUMCOLORMAPS / LIGHTLEVELS;
    for (let j = 0; j < MAXLIGHTSCALE; j++) {
      let level = Math.floor(startmap - j * BASE_WIDTH / viewwidth / 2);
      if (level < 0) level = 0;
      if (level >= NUMCOLORMAPS) level = NUMCOLORMAPS - 1;
      scalelight[i][j] = level;
    }
  }
  for (let i = 0; i < LIGHTLEVELS; i++) {
    zlight[i] = [];
    const startmap = ((LIGHTLEVELS - 1 - i) * 2) * NUMCOLORMAPS / LIGHTLEVELS;
    for (let j = 0; j < MAXLIGHTZ; j++) {
      let scale = fixedDiv((BASE_WIDTH / 2) * FRACUNIT, (j + 1) << LIGHTZSHIFT);
      scale >>= LIGHTSCALESHIFT;
      let level = Math.floor(startmap - scale / 2);
      if (level < 0) level = 0;
      if (level >= NUMCOLORMAPS) level = NUMCOLORMAPS - 1;
      zlight[i][j] = level;
    }
  }
}

/**
 * Extra light added to all pixels (muzzle flash).
 * Positive = brighter (subtracts from colormapIdx).
 * Like DOOM's player->extralight.
 */
let extralight = 0;

/** Set extralight level (0 = normal, 1-2 = gun flash) */
export function setExtraLight(level: number): void {
  extralight = level;
}

/**
 * Resolve G-Buffer to rgbaBuffer (Pass 2 of deferred rendering).
 * Reads paletteIdx + lightLevel from G-Buffer, applies colormap
 * with extralight offset, writes final RGBA.
 */
export function resolveGBuffer(): void {
  const len = SCREENWIDTH * SCREENHEIGHT;
  const g = gBuffer;
  // extralight shifts colormapIdx toward brighter (lower index)
  // Each extralight unit = ~4 colormap levels brighter
  const lightShift = extralight * 4;

  for (let i = 0; i < len; i++) {
    const surface = g.flags[i];
    if (surface === SurfaceType.NONE || surface === SurfaceType.SKY) continue;

    const paletteIdx = g.paletteIdx[i];
    let lightLvl = g.lightLevel[i] - lightShift;
    if (lightLvl < 0) lightLvl = 0;
    const colormap = palData.getColormapLookup(lightLvl);
    rgbaBuffer[i] = colormap[paletteIdx];
  }
}

/**
 * Resolve fuzz (Spectre/invisibility) pixels — Pass 2b.
 * Must be called AFTER resolveGBuffer so that surrounding pixels
 * have valid RGBA values to sample from.
 *
 * Replicates DOOM's R_DrawFuzzColumn:
 * - Reads a neighboring pixel (offset by ±1 row using the fuzz table)
 * - Darkens it by halving RGB channels
 *
 * Reference: r_draw.c R_DrawFuzzColumn, fuzzoffset[] table
 */
// Classic DOOM fuzz offset table (49 entries, +1 or -1 row offset)
const FUZZOFFSET = [
   1, -1,  1, -1,  1,  1, -1,
   1,  1, -1,  1,  1,  1, -1,
   1,  1,  1, -1, -1, -1, -1,
   1, -1, -1,  1,  1,  1,  1, -1,
   1, -1,  1,  1, -1, -1,  1,
   1, -1, -1, -1, -1,  1,  1,
   1,  1, -1,  1,  1, -1,
];
let fuzzpos = 0;

export function resolveFuzzPixels(): void {
  const len = SCREENWIDTH * SCREENHEIGHT;
  const g = gBuffer;

  for (let i = 0; i < len; i++) {
    if (g.flags[i] !== SurfaceType.FUZZ) continue;

    // Calculate fuzz offset (±1 row in the framebuffer)
    const offset = FUZZOFFSET[fuzzpos] * SCREENWIDTH;
    fuzzpos = (fuzzpos + 1) % FUZZOFFSET.length;

    // Sample neighboring pixel (clamped to buffer bounds)
    let srcIdx = i + offset;
    if (srcIdx < 0) srcIdx = 0;
    if (srcIdx >= len) srcIdx = len - 1;

    // Read existing RGBA from neighboring pixel and darken (halve RGB)
    const existing = rgbaBuffer[srcIdx];
    const r = ((existing & 0xFF) >> 1);
    const g2 = (((existing >> 8) & 0xFF) >> 1);
    const b = (((existing >> 16) & 0xFF) >> 1);
    rgbaBuffer[i] = (255 << 24) | (b << 16) | (g2 << 8) | r;
  }
}

/** Rebuild light tables after color mode change (Classic <-> TrueColor) */
export function rebuildLightTables(): void {
  if (!palData) return;
  NUMCOLORMAPS = palData.numColormaps;
  initLightTables();
}

// ===========================================================
// View Setup
// ===========================================================

export function setViewPosition(x: number, y: number, z: number, angle: number): void {
  viewx = x;
  viewy = y;
  viewz = z;
  viewangle = angle >>> 0;
  const fineAngle = (viewangle >>> ANGLETOFINESHIFT) & FINEMASK;
  viewsin = finesine[fineAngle] || 0;
  viewcos = finecosine(fineAngle) || 0;
}

// ===========================================================
// R_PointToAngle (view-relative)
// ===========================================================

function viewAngleTo(x: number, y: number): number {
  return pointToAngle(viewx, viewy, x, y);
}

// ===========================================================
// Angle to Screen X  (R_PointToAngle → screen column)
// ===========================================================

function angleToX(ang: number): number {
  // From the original DOOM source (r_bsp.c):
  //   angle = (angle + ANG90) >> ANGLETOFINESHIFT;
  //   x = viewangletox[angle];
  // The +ANG90 offset shifts the view-relative angle into the
  // range covered by the viewangletox lookup table.
  const fineIdx = ((ang + ANG90) >>> ANGLETOFINESHIFT) & (FINEANGLES / 2 - 1);
  return viewangletox[fineIdx];
}

// ===========================================================
// Main Render Frame
// ===========================================================

export function renderFrame(): void {
  profilerBegin('  clear');
  clearScreen();
  gBuffer.clear();

  for (let i = 0; i < SCREENWIDTH; i++) {
    floorclip[i] = viewheight;
    ceilingclip[i] = -1;
  }

  resetVisplanePool();
  vissprites.length = 0;
  resetClipBuf();
  drawsegs.length = 0;
  solidsegs = [
    { first: -0x7FFFFFFF, last: -1 },
    { first: viewwidth, last: 0x7FFFFFFF },
  ];

  debugCounters.subsectors = 0;
  debugCounters.addLineCalls = 0;
  debugCounters.backFaceCulled = 0;
  debugCounters.clipCulled = 0;
  debugCounters.storeWallCalls = 0;
  debugCounters.columnsDrawn = 0;
  debugCounters.x1GreaterX2 = 0;
  debugCounters.angleToXResults = [];
  profilerEnd('  clear');

  // Rebuild subsector→thing mapping to reflect runtime positions
  updateSubsectorThings();

  // Build VFX and dropped items subsector assignments for BSP traversal
  buildVfxSubsectorMap();
  buildDropSubsectorMap();
  buildProjectileSubsectorMap();

  // Traverse BSP (collects wall segs, projects sprites + VFX per-subsector)
  profilerBegin('  bsp');
  renderBSPNode(map.nodes.length - 1);
  profilerEnd('  bsp');

  // Render visplanes (floors/ceilings)
  profilerBegin('  planes');
  drawPlanes();
  profilerEnd('  planes');

  // Render masked midtextures (fences, grates on two-sided linedefs)
  profilerBegin('  masked');
  drawMaskedMidTextures();
  profilerEnd('  masked');

  // Render sprites (things + VFX) on top of floors/ceilings, clipped by walls
  profilerBegin('  sprites');
  drawSprites();
  profilerEnd('  sprites');

  debugFrame++;
}

let debugFrame = 0;
const debugCounters = {
  subsectors: 0,
  addLineCalls: 0,
  backFaceCulled: 0,
  clipCulled: 0,
  storeWallCalls: 0,
  columnsDrawn: 0,
  x1GreaterX2: 0,
  angleToXResults: [] as any[],
};

// ===========================================================
// BSP Traversal
// ===========================================================

function renderBSPNode(nodeIdx: number): void {
  if (nodeIdx & NF_SUBSECTOR) {
    const ssIdx = nodeIdx === 0xFFFF ? 0 : nodeIdx & ~NF_SUBSECTOR;
    if (ssIdx < map.subsectors.length) {
      renderSubsector(ssIdx);
    }
    return;
  }
  if (nodeIdx >= map.nodes.length) return;

  const node = map.nodes[nodeIdx];
  const side = map.pointOnSide(viewx, viewy, node);

  renderBSPNode(node.children[side]);

  if (checkBBox(node.bbox[side ^ 1])) {
    renderBSPNode(node.children[side ^ 1]);
  }
}

// DOOM's checkcoord lookup table — selects which two bbox corners to use
// for the visibility angle span, based on viewer position relative to bbox.
// bbox indices: 0=BOXTOP, 1=BOXBOTTOM, 2=BOXLEFT, 3=BOXRIGHT
const checkcoord: number[][] = [
  [3,0,2,1],  // boxpos 0: viewer is left-top
  [3,0,2,0],  // boxpos 1: viewer is center-top
  [3,1,2,0],  // boxpos 2: viewer is right-top
  [0],         // boxpos 3: unused
  [2,0,2,1],  // boxpos 4: viewer is left-center
  [0,0,0,0],  // boxpos 5: viewer is INSIDE — always visible
  [3,1,3,0],  // boxpos 6: viewer is right-center
  [0],         // boxpos 7: unused
  [2,0,3,1],  // boxpos 8: viewer is left-bottom
  [2,1,3,1],  // boxpos 9: viewer is center-bottom
  [2,1,3,0],  // boxpos 10: viewer is right-bottom
];

function checkBBox(bbox: [number, number, number, number]): boolean {
  // Determine viewer position relative to bbox quadrant
  let boxx: number;
  if (viewx <= bbox[2]) {      // BOXLEFT
    boxx = 0;
  } else if (viewx < bbox[3]) { // BOXRIGHT
    boxx = 1;
  } else {
    boxx = 2;
  }

  let boxy: number;
  if (viewy >= bbox[0]) {      // BOXTOP
    boxy = 0;
  } else if (viewy > bbox[1]) { // BOXBOTTOM
    boxy = 1;
  } else {
    boxy = 2;
  }

  const boxpos = (boxy << 2) + boxx;
  if (boxpos === 5) return true; // viewer is inside the bbox

  // Select the two corners that define the widest visible span
  const cc = checkcoord[boxpos];
  const x1 = bbox[cc[0]];
  const y1 = bbox[cc[1]];
  const x2 = bbox[cc[2]];
  const y2 = bbox[cc[3]];

  // Compute view-relative angles to the selected corners
  let angle1 = (pointToAngle(viewx, viewy, x1, y1) - viewangle) >>> 0;
  let angle2 = (pointToAngle(viewx, viewy, x2, y2) - viewangle) >>> 0;

  const span = (angle1 - angle2) >>> 0;
  // Sitting on a line?
  if (span >= ANG180) return true;

  let tspan = (angle1 + clipangle) >>> 0;
  if (tspan > (2 * clipangle) >>> 0) {
    tspan = (tspan - (2 * clipangle)) >>> 0;
    if (tspan >= span) return false;
    angle1 = clipangle;
  }

  tspan = (clipangle - angle2) >>> 0;
  if (tspan > (2 * clipangle) >>> 0) {
    tspan = (tspan - (2 * clipangle)) >>> 0;
    if (tspan >= span) return false;
    angle2 = ((-clipangle) >>> 0);
  }

  // Map angles to screen columns (matching DOOM's direct lookup)
  const sx1 = viewangletox[((angle1 + ANG90) >>> ANGLETOFINESHIFT) & (FINEANGLES / 2 - 1)];
  const sx2 = viewangletox[((angle2 + ANG90) >>> ANGLETOFINESHIFT) & (FINEANGLES / 2 - 1)];

  // Does not cross a pixel?
  if (sx1 === sx2) return false;

  // DOOM's exact solidsegs check: find first clippost that could contain sx2-1
  let i = 0;
  while (solidsegs[i].last < sx2 - 1) i++;

  // If the clippost fully contains [sx1, sx2-1], it's occluded
  if (sx1 >= solidsegs[i].first && sx2 - 1 <= solidsegs[i].last) {
    return false;
  }

  return true;
}

// ===========================================================
// Subsector
// ===========================================================

function renderSubsector(ssIdx: number): void {
  const ss = map.subsectors[ssIdx];
  if (!ss.sector) return;
  debugCounters.subsectors++;

  // Project sprites BEFORE segs (same as original DOOM R_Subsector).
  // Clip arrays at this point reflect walls from CLOSER subsectors only.
  // Per-pixel depth testing during drawVisSprite handles same-subsector
  // wall clipping (e.g., monster legs hidden behind a column).
  if (spriteData) {
    const things = subsectorThings.get(ssIdx);
    if (things) {
      for (const {thing, info, thingIdx} of things) {
        if (removedThings.has(thingIdx)) continue;
        projectSprite(thing, info, ss.sector!, thingIdx);
      }
    }
    const vfxList = subsectorVfx.get(ssIdx);
    if (vfxList) {
      for (const e of vfxList) {
        projectVfxSprite(e, ss.sector!);
      }
    }
    const dropList = subsectorDrops.get(ssIdx);
    if (dropList) {
      for (const item of dropList) {
        projectDropSprite(item, ss.sector!);
      }
    }
    const projList = subsectorProjectiles.get(ssIdx);
    if (projList) {
      for (const p of projList) {
        projectProjectileSprite(p, ss.sector!);
      }
    }
  }

  for (let i = 0; i < ss.numSegs; i++) {
    const segIdx = ss.firstSeg + i;
    if (segIdx < map.segs.length) {
      addLine(map.segs[segIdx]);
    }
  }
}

// ===========================================================
// Add a seg line
// ===========================================================

function addLine(seg: Seg): void {
  debugCounters.addLineCalls++;
  // Match original DOOM R_AddLine exactly
  let angle1 = viewAngleTo(seg.v1.x, seg.v1.y);
  let angle2 = viewAngleTo(seg.v2.x, seg.v2.y);

  // Back face cull (using absolute angles)
  const span = (angle1 - angle2) >>> 0;
  if (span >= ANG180) { debugCounters.backFaceCulled++; return; }

  // Global angle needed by segcalc (absolute angle to v1)
  rw_angle1 = angle1;

  // Now make view-relative
  angle1 = (angle1 - viewangle) >>> 0;
  angle2 = (angle2 - viewangle) >>> 0;

  // Clip to FOV
  let tspan = (angle1 + clipangle) >>> 0;
  if (tspan > (2 * clipangle) >>> 0) {
    tspan = (tspan - (2 * clipangle)) >>> 0;
    if (tspan >= span) return;
    angle1 = clipangle;
  }

  tspan = (clipangle - angle2) >>> 0;
  if (tspan > (2 * clipangle) >>> 0) {
    tspan = (tspan - (2 * clipangle)) >>> 0;
    if (tspan >= span) return;
    angle2 = ((-clipangle) >>> 0);
  }

  // Map to screen columns
  const x1 = angleToX(angle1);
  const x2 = angleToX(angle2);
  if (debugCounters.angleToXResults.length < 20) {
    debugCounters.angleToXResults.push({angle1: angle1.toString(16), angle2: angle2.toString(16), x1, x2});
  }
  if (x1 === x2) { debugCounters.x1GreaterX2++; return; }

  const backsector = seg.backsector;
  if (!backsector) {
    clipSolidWallSegment(x1, x2 - 1, seg);
  } else {
    if (backsector.ceilingHeight <= seg.frontsector.floorHeight ||
        backsector.floorHeight >= seg.frontsector.ceilingHeight) {
      clipSolidWallSegment(x1, x2 - 1, seg);
    } else if (backsector.ceilingHeight !== seg.frontsector.ceilingHeight ||
               backsector.floorHeight !== seg.frontsector.floorHeight) {
      clipPassWallSegment(x1, x2 - 1, seg);
    } else {
      // Reject empty lines used for triggers/specials:
      // identical floor+ceiling+light AND no midtexture
      if (backsector.floorPic === seg.frontsector.floorPic &&
          backsector.ceilingPic === seg.frontsector.ceilingPic &&
          backsector.lightLevel === seg.frontsector.lightLevel &&
          seg.sidedef.midTexture === 0) {
        return;
      }
      clipPassWallSegment(x1, x2 - 1, seg);
    }
  }
}

// ===========================================================
// Clip solid/pass wall segments (same as before)
// ===========================================================

function clipSolidWallSegment(x1: number, x2: number, seg: Seg): void {
  let i = 0;
  while (solidsegs[i].last < x1 - 1) i++;

  if (x1 < solidsegs[i].first) {
    if (x2 < solidsegs[i].first - 1) {
      storeWallRange(x1, x2, seg);
      solidsegs.splice(i, 0, { first: x1, last: x2 });
      return;
    }
    storeWallRange(x1, solidsegs[i].first - 1, seg);
    solidsegs[i].first = x1;
  }

  if (x2 <= solidsegs[i].last) return;

  let j = i;
  while (x2 >= solidsegs[j + 1].first - 1) {
    storeWallRange(solidsegs[j].last + 1, Math.min(solidsegs[j + 1].first - 1, x2), seg);
    j++;
    if (x2 <= solidsegs[j].last) {
      solidsegs[i].last = solidsegs[j].last;
      if (j !== i) solidsegs.splice(i + 1, j - i);
      return;
    }
  }
  storeWallRange(solidsegs[j].last + 1, x2, seg);
  solidsegs[i].last = x2;
  if (j !== i) solidsegs.splice(i + 1, j - i);
}

function clipPassWallSegment(x1: number, x2: number, seg: Seg): void {
  let i = 0;
  while (solidsegs[i].last < x1 - 1) i++;

  if (x1 < solidsegs[i].first) {
    if (x2 < solidsegs[i].first - 1) {
      storeWallRange(x1, x2, seg);
      return;
    }
    storeWallRange(x1, solidsegs[i].first - 1, seg);
  }

  if (x2 <= solidsegs[i].last) return;

  while (x2 >= solidsegs[i + 1].first - 1) {
    storeWallRange(solidsegs[i].last + 1, Math.min(solidsegs[i + 1].first - 1, x2), seg);
    i++;
    if (x2 <= solidsegs[i].last) return;
  }
  storeWallRange(solidsegs[i].last + 1, x2, seg);
}

// ===========================================================
// Store Wall Range — the core rendering
// ===========================================================

function storeWallRange(start: number, stop: number, seg: Seg): void {
  if (start > stop) return;
  debugCounters.storeWallCalls++;

  const frontsector = seg.frontsector;
  const backsector = seg.backsector;

  // Normal angle and distance
  rw_normalangle = (seg.angle + ANG90) >>> 0;

  // Calculate perpendicular distance to the seg (R_StoreWallRange)
  const dx = (seg.v1.x - viewx) || 0;
  const dy = (seg.v1.y - viewy) || 0;
  const hyp = Math.hypot(dx, dy) | 0;

  // Clamp offset angle like original DOOM before computing distance
  let offsetangle = ((rw_normalangle - rw_angle1) >>> 0);
  if (offsetangle > ANG180) offsetangle = ((-offsetangle) >>> 0);
  if (offsetangle > ANG90) offsetangle = ANG90;

  // Original DOOM: distangle = ANG90 - offsetangle
  // rw_distance = FixedMul(hyp, finesine[distangle])
  // sin(90° - offset) = cos(offset) — gives perpendicular distance
  const distangle = ((ANG90 - offsetangle) >>> 0);
  const sinIdx = (distangle >>> ANGLETOFINESHIFT) & FINEMASK;
  const sinNorm = finesine[sinIdx] || 0;
  rw_distance = sinNorm !== 0 ? Math.abs(fixedMul(hyp, sinNorm)) : (hyp || 1);
  if (rw_distance < 1) rw_distance = 1;

  // Scale at endpoints
  rw_scale = scaleFromGlobalAngle(start);
  if (rw_scale < 64) rw_scale = 64;
  if (rw_scale > 64 * FRACUNIT) rw_scale = 64 * FRACUNIT;

  if (stop > start) {
    let scale2 = scaleFromGlobalAngle(stop);
    if (scale2 < 64) scale2 = 64;
    if (scale2 > 64 * FRACUNIT) scale2 = 64 * FRACUNIT;
    rw_scalestep = ((scale2 - rw_scale) / (stop - start)) | 0;
  } else {
    rw_scalestep = 0;
  }

  // World heights relative to view
  worldtop = frontsector.ceilingHeight - viewz;
  worldbottom = frontsector.floorHeight - viewz;

  // Setup textures
  const sidedef = seg.sidedef;
  midtexture = 0;
  toptexture = 0;
  bottomtexture = 0;
  markfloor = true;
  markceiling = true;

  const isSkyFront = texData.flatList[frontsector.ceilingPic]?.name === SKY_FLAT_NAME;

  if (!backsector) {
    // One-sided line
    midtexture = getAnimatedTexture(sidedef.midTexture);
    const tex = texData.textures[midtexture];
    const texH = tex ? tex.height << FRACBITS : 0;

    if (seg.linedef.flags & 16) { // ML_DONTPEGBOTTOM
      rw_midtexturemid = frontsector.floorHeight + texH - viewz;
    } else {
      rw_midtexturemid = worldtop;
    }
    rw_midtexturemid += sidedef.rowOffset;
  } else {
    // Two-sided line
    worldhigh = backsector.ceilingHeight - viewz;
    worldlow = backsector.floorHeight - viewz;

    const isSkyBack = texData.flatList[backsector.ceilingPic]?.name === SKY_FLAT_NAME;
    if (isSkyFront && isSkyBack) worldtop = worldhigh;

    if (worldhigh < worldtop) {
      toptexture = getAnimatedTexture(sidedef.topTexture);
      if (seg.linedef.flags & 8) { // ML_DONTPEGTOP
        rw_toptexturemid = worldtop;
      } else {
        const tex = texData.textures[toptexture];
        rw_toptexturemid = worldhigh + (tex ? tex.height << FRACBITS : 0);
      }
      rw_toptexturemid += sidedef.rowOffset;
    }

    if (worldlow > worldbottom) {
      bottomtexture = getAnimatedTexture(sidedef.bottomTexture);
      if (seg.linedef.flags & 16) { // ML_DONTPEGBOTTOM
        rw_bottomtexturemid = worldtop;
      } else {
        rw_bottomtexturemid = worldlow;
      }
      rw_bottomtexturemid += sidedef.rowOffset;
    }

    // Original DOOM r_segs.c: mark floor/ceiling based on world-space heights,
    // texture differences, AND light level differences
    if (worldlow !== worldbottom
        || backsector.floorPic !== frontsector.floorPic
        || backsector.lightLevel !== frontsector.lightLevel) {
      markfloor = true;
    } else {
      markfloor = false;
    }

    if (worldhigh !== worldtop
        || backsector.ceilingPic !== frontsector.ceilingPic
        || backsector.lightLevel !== frontsector.lightLevel) {
      markceiling = true;
    } else {
      markceiling = false;
    }

    // Closed door override
    if (backsector.ceilingHeight <= frontsector.floorHeight
        || backsector.floorHeight >= frontsector.ceilingHeight) {
      markceiling = markfloor = true;
    }
  }

  // Visibility culling: if floor/ceiling is on wrong side of view plane,
  // don't mark it (original DOOM R_StoreWallRange)
  if (frontsector.floorHeight >= viewz) {
    markfloor = false;
  }
  if (frontsector.ceilingHeight <= viewz && !isSkyFront) {
    markceiling = false;
  }

  // Light level
  const lightnum = Math.max(0, Math.min(LIGHTLEVELS - 1, (frontsector.lightLevel >> LIGHTSEGSHIFT) | 0));
  curLineWallLightLevel = lightnum;

  // Calculate rw_centerangle for texture column mapping
  rw_centerangle = (ANG90 + viewangle - rw_normalangle) >>> 0;

  // Calculate base texture column offset
  const rwBaseOffset = calcTextureBaseOffset(seg, hyp);

  // Set up visplanes for this wall range (R_CheckPlane equivalent)
  if (markceiling) {
    cur_ceilingplane = checkVisplane(findOrCreateVisplane(frontsector, true), start, stop);
  } else {
    cur_ceilingplane = null;
  }
  if (markfloor) {
    cur_floorplane = checkVisplane(findOrCreateVisplane(frontsector, false), start, stop);
  } else {
    cur_floorplane = null;
  }

  // Record drawseg for masked midtexture on two-sided lines
  // Reference: r_segs.c — if sidedef->midtexture, set maskedtexture and store drawseg
  let maskedTexture = false;
  if (backsector && sidedef.midTexture !== 0) {
    maskedTexture = true;
  }

  // Render columns
  // If masked, also compute texture columns for the drawseg
  let maskedTextureCol: Int16Array | null = null;
  if (maskedTexture) {
    maskedTextureCol = new Int16Array(SCREENWIDTH);
    maskedTextureCol.fill(0x7FFF); // MAXSHORT = skip
  }

  let scale = rw_scale;
  for (let x = start; x <= stop; x++) {
    renderColumn(x, seg, scale, frontsector, backsector, rwBaseOffset);
    // Save texture column for masked mid rendering
    if (maskedTextureCol) {
      maskedTextureCol[x] = getTexColumn(x, rwBaseOffset);
    }
    scale += rw_scalestep;
  }

  // Store drawseg for masked midtexture
  if (maskedTexture && maskedTextureCol && drawsegs.length < MAXDRAWSEGS) {
    // Snapshot clip arrays at this point
    const sprTopClip = new Int16Array(SCREENWIDTH);
    const sprBottomClip = new Int16Array(SCREENWIDTH);
    sprTopClip.set(ceilingclip);
    sprBottomClip.set(floorclip);

    drawsegs.push({
      seg,
      x1: start,
      x2: stop,
      scale1: rw_scale,
      scale2: scale - rw_scalestep, // last scale value used
      scalestep: rw_scalestep,
      maskedTextureCol,
      sprTopClip,
      sprBottomClip,
    });
  }
}

function scaleFromGlobalAngle(x: number): number {
  // Original DOOM: R_ScaleFromGlobalAngle
  // visangle = viewangle + xtoviewangle[start]
  const visangle = (viewangle + (xtoviewangle[x] || 0)) >>> 0;

  const anglea = (ANG90 + (visangle - viewangle)) >>> 0;
  const angleb = (ANG90 + (visangle - rw_normalangle)) >>> 0;

  const sinea = finesine[(anglea >>> ANGLETOFINESHIFT) & FINEMASK] || 0;
  const sineb = finesine[(angleb >>> ANGLETOFINESHIFT) & FINEMASK] || 0;

  const num = fixedMul(projection, sineb);
  const den = fixedMul(rw_distance, sinea);

  if (den > (num >> 16)) {
    let scale = fixedDiv(num, den);
    if (scale > 64 * FRACUNIT) scale = 64 * FRACUNIT;
    else if (scale < 256) scale = 256;
    return scale;
  }
  return 64 * FRACUNIT;
}

function calcTextureBaseOffset(seg: Seg, hyp: number): number {
  // Original DOOM R_StoreWallRange texture offset calculation
  // hyp is passed from storeWallRange to avoid recomputing Math.hypot
  let offsetangle = ((rw_normalangle - rw_angle1) >>> 0);
  
  // Clamp offsetangle  
  if (offsetangle > ANG180) offsetangle = ((-offsetangle) >>> 0);
  if (offsetangle > ANG90) offsetangle = ANG90;
  
  const sinIdx = (offsetangle >>> ANGLETOFINESHIFT) & FINEMASK;
  let rw_offset = fixedMul(hyp, finesine[sinIdx] || 0);
  
  if (((rw_normalangle - rw_angle1) >>> 0) < ANG180) {
    rw_offset = -rw_offset;
  }
  
  rw_offset += (seg.sidedef.textureOffset || 0) + (seg.offset || 0);
  return rw_offset;
}

// rw_centerangle is calculated once per wall range
let rw_centerangle = 0;

function getTexColumn(x: number, baseOffset: number): number {
  // Original DOOM: angle = (rw_centerangle + xtoviewangle[rw_x]) >> ANGLETOFINESHIFT
  // texturecolumn = rw_offset - FixedMul(finetangent[angle], rw_distance)
  const angle = ((rw_centerangle + (xtoviewangle[x] || 0)) >>> ANGLETOFINESHIFT) & (FINEANGLES / 2 - 1);
  let col = baseOffset - fixedMul(finetangent[angle] || 0, rw_distance);
  return (col >> FRACBITS) | 0;
}

// ===========================================================
// Render a single wall column
// ===========================================================

function renderColumn(
  x: number, seg: Seg, scale: number,
  frontsector: Sector, backsector: Sector | null,
  baseOffset: number
): void {
  if (x < 0 || x >= SCREENWIDTH) return;
  if (scale < 64) scale = 64;

  const iscale = fixedDiv(FRACUNIT, scale);

  // Column top/bottom (from sector heights projected to screen)
  let yl = ((centeryfrac - fixedMul(worldtop, scale) + FRACUNIT - 1) >> FRACBITS) | 0;
  let yh = ((centeryfrac - fixedMul(worldbottom, scale)) >> FRACBITS) | 0;

  // Clip
  if (yl < ceilingclip[x] + 1) yl = ceilingclip[x] + 1;
  if (yh > floorclip[x] - 1) yh = floorclip[x] - 1;

  // Light
  let lightIdx = (scale >> LIGHTSCALESHIFT) | 0;
  if (lightIdx >= MAXLIGHTSCALE) lightIdx = MAXLIGHTSCALE - 1;
  if (lightIdx < 0) lightIdx = 0;
  const colormapIdx = scalelight[curLineWallLightLevel]?.[lightIdx] ?? 0;
  const colormap = palData.getColormapLookup(colormapIdx);

  // Texture column
  const texCol = getTexColumn(x, baseOffset);

  // Set Z-scale for depth buffer (used by floors and sprites for per-pixel Z-testing)
  setZScale(scale);

  // Compute world position of this wall column for G-Buffer
  // Use the view ray to compute the actual wall hit point in world space
  {
    const colAngle = (viewangle + (xtoviewangle[x] || 0)) >>> 0;
    const colAnIdx = (colAngle >>> ANGLETOFINESHIFT) & FINEMASK;
    // distance from camera = projection / scale (fixed_t)
    const dist = scale > 0 ? fixedDiv(projection, scale) : (512 * FRACUNIT);
    dc.worldX = viewx + fixedMul(dist, finecosine(colAnIdx));
    dc.worldY = viewy + fixedMul(dist, finesine[colAnIdx]);
    dc.colormapIdx = colormapIdx;
    dc.surfaceType = SurfaceType.WALL;
  }

  if (!backsector) {
    // Mark visplanes BEFORE drawing wall (matches DOOM R_RenderSegLoop order)
    if (markceiling) addToVisplane(true, x, ceilingclip[x] + 1, Math.min(yl - 1, floorclip[x] - 1));
    if (markfloor) addToVisplane(false, x, Math.max(yh + 1, ceilingclip[x] + 1), floorclip[x] - 1);

    // One-sided: draw mid texture
    if (yl <= yh && midtexture) {
      const tex = texData.textures[midtexture];
      if (tex) {
        const tcx = ((texCol % tex.width) + tex.width) % tex.width;
        dc.colormap = colormap;
        dc.x = x;
        dc.yl = yl;
        dc.yh = yh;
        dc.textureMid = rw_midtexturemid;
        dc.iscale = iscale;
        dc.source = tex.columns[tcx];
        dc.sourceLength = tex.height;
        dc.worldTopZ = frontsector.ceilingHeight;
        dc.worldBottomZ = frontsector.floorHeight;
        drawColumnDeferred();
      }
    }

    // Solid wall occlusion
    ceilingclip[x] = viewheight;
    floorclip[x] = -1;
  } else {
    // Two-sided
    let mid: number;

    // Ceiling visplane (same logic as one-sided)
    if (markceiling) {
      const top = ceilingclip[x] + 1;
      let bottom = yl - 1;
      if (bottom >= floorclip[x]) bottom = floorclip[x] - 1;
      if (top <= bottom) {
        addToVisplane(true, x, top, bottom);
      }
    }

    // Floor visplane
    if (markfloor) {
      let top = yh + 1;
      const bottom = floorclip[x] - 1;
      if (top <= ceilingclip[x]) top = ceilingclip[x] + 1;
      if (top <= bottom) {
        addToVisplane(false, x, top, bottom);
      }
    }

    // Upper wall
    if (toptexture) {
      mid = ((centeryfrac - fixedMul(worldhigh, scale)) >> FRACBITS) | 0;
      if (mid >= floorclip[x]) mid = floorclip[x] - 1;
      if (mid >= yl) {
        const tex = texData.textures[toptexture];
        if (tex) {
          const tcx = ((texCol % tex.width) + tex.width) % tex.width;
          dc.colormap = colormap;
          dc.x = x;
          dc.yl = yl;
          dc.yh = mid;
          dc.textureMid = rw_toptexturemid;
          dc.iscale = iscale;
          dc.source = tex.columns[tcx];
          dc.sourceLength = tex.height;
          dc.worldTopZ = frontsector.ceilingHeight;
          dc.worldBottomZ = backsector!.ceilingHeight;
          drawColumnDeferred();
        }
        ceilingclip[x] = mid;
      } else {
        ceilingclip[x] = yl - 1;
      }
    } else {
      // no top wall
      if (markceiling) ceilingclip[x] = yl - 1;
    }

    // Lower wall
    if (bottomtexture) {
      mid = (((centeryfrac - fixedMul(worldlow, scale)) + FRACUNIT - 1) >> FRACBITS) | 0;
      if (mid <= ceilingclip[x]) mid = ceilingclip[x] + 1;
      if (mid <= yh) {
        const tex = texData.textures[bottomtexture];
        if (tex) {
          const tcx = ((texCol % tex.width) + tex.width) % tex.width;
          dc.colormap = colormap;
          dc.x = x;
          dc.yl = mid;
          dc.yh = yh;
          dc.textureMid = rw_bottomtexturemid;
          dc.iscale = iscale;
          dc.source = tex.columns[tcx];
          dc.sourceLength = tex.height;
          dc.worldTopZ = backsector!.floorHeight;
          dc.worldBottomZ = frontsector.floorHeight;
          drawColumnDeferred();
        }
        floorclip[x] = mid;
      } else {
        floorclip[x] = yh + 1;
      }
    } else {
      // no bottom wall
      if (markfloor) floorclip[x] = yh + 1;
    }
  }
}

// ===========================================================
// Visplane Management
// ===========================================================

function findOrCreateVisplane(sector: Sector, isCeiling: boolean): Visplane {
  const height = isCeiling ? sector.ceilingHeight : sector.floorHeight;
  const picnum = isCeiling ? sector.ceilingPic : sector.floorPic;
  const lightlevel = sector.lightLevel;

  // Original DOOM: sky flats all map together with height=0, lightlevel=0
  const matchHeight = (texData.flatList[picnum]?.name === SKY_FLAT_NAME) ? 0 : height;
  const matchLight = (texData.flatList[picnum]?.name === SKY_FLAT_NAME) ? 0 : lightlevel;

  for (const vp of visplanes) {
    if (vp.height === matchHeight && vp.picnum === picnum && 
        vp.lightlevel === matchLight && vp.isCeiling === isCeiling) {
      return vp;
    }
  }

  const vp = allocVisplane();
  vp.height = matchHeight;
  vp.picnum = picnum;
  vp.lightlevel = matchLight;
  vp.isCeiling = isCeiling;
  vp.minx = SCREENWIDTH;
  vp.maxx = -1;
  vp.top.fill(0x7FFF);
  vp.bottom.fill(-1);
  visplanes.push(vp);
  return vp;
}

// R_CheckPlane equivalent: ensure we can write to this column without conflict
function checkVisplane(vp: Visplane, start: number, stop: number): Visplane {
  if (start < vp.minx || stop > vp.maxx) {
    // No overlap with existing data, can extend
    const intrl = Math.max(start, vp.minx);
    const intrh = Math.min(stop, vp.maxx);
    
    // Check if any x in the intersection already has data
    let hasConflict = false;
    for (let x = intrl; x <= intrh; x++) {
      if (vp.top[x] !== 0x7FFF) { hasConflict = true; break; }
    }
    
    if (!hasConflict) {
      // Extend this plane
      if (start < vp.minx) vp.minx = start;
      if (stop > vp.maxx) vp.maxx = stop;
      return vp;
    }
  } else {
    // Check if the intersection range has any data
    let hasConflict = false;
    for (let x = start; x <= stop; x++) {
      if (vp.top[x] !== 0x7FFF) { hasConflict = true; break; }
    }
    if (!hasConflict) return vp;
  }
  
  // Conflict: allocate from pool with same properties
  const newVp = allocVisplane();
  newVp.height = vp.height;
  newVp.picnum = vp.picnum;
  newVp.lightlevel = vp.lightlevel;
  newVp.isCeiling = vp.isCeiling;
  newVp.minx = start;
  newVp.maxx = stop;
  newVp.top.fill(0x7FFF);
  newVp.bottom.fill(-1);
  visplanes.push(newVp);
  return newVp;
}

// Cached visplane pointers per storeWallRange call
let cur_floorplane: Visplane | null = null;
let cur_ceilingplane: Visplane | null = null;

function addToVisplane(isCeiling: boolean, x: number, top: number, bottom: number): void {
  if (top > bottom || x < 0 || x >= SCREENWIDTH) return;
  const vp = isCeiling ? cur_ceilingplane : cur_floorplane;
  if (!vp) return;
  if (x < vp.minx) vp.minx = x;
  if (x > vp.maxx) vp.maxx = x;
  vp.top[x] = Math.max(0, top);
  vp.bottom[x] = Math.min(viewheight - 1, bottom);
}

// ===========================================================
// Draw Visplanes (Floors & Ceilings)
// ===========================================================

// Precomputed per-row tables (allocated once, reused each frame)
let planeRowDistance: Int32Array = new Int32Array(0);
let planeRowFloorScale: Int32Array = new Int32Array(0);
let planeRowColormapIdx: Int32Array = new Int32Array(0);
let planeRowValid: Uint8Array = new Uint8Array(0);

function ensurePlaneRowTables(): void {
  if (planeRowDistance.length >= viewheight) return;
  planeRowDistance = new Int32Array(viewheight);
  planeRowFloorScale = new Int32Array(viewheight);
  planeRowColormapIdx = new Int32Array(viewheight);
  planeRowValid = new Uint8Array(viewheight);
}

function drawPlanes(): void {
  ensurePlaneRowTables();

  for (const vp of visplanes) {
    if (vp.maxx < vp.minx) continue;

    const flatName = texData.flatList[vp.picnum]?.name;
    if (flatName === SKY_FLAT_NAME) {
      drawSky(vp);
      continue;
    }

    const animatedPicnum = getAnimatedFlat(vp.picnum);
    const flat = texData.flatList[animatedPicnum];
    if (!flat) continue;

    const planeheight = Math.abs(vp.height - viewz);
    const lightnum = Math.max(0, Math.min(LIGHTLEVELS - 1, (vp.lightlevel >> LIGHTSEGSHIFT) | 0));
    const surfaceType = vp.isCeiling ? SurfaceType.CEILING : SurfaceType.FLOOR;
    const flatData = flat.data;
    const vpHeight = vp.height;
    const g = gBuffer;

    // --- Precompute per-row values ---
    // Find the y range this visplane actually covers
    let globalMinY = viewheight;
    let globalMaxY = 0;
    for (let x = vp.minx; x <= vp.maxx; x++) {
      if (vp.top[x] <= vp.bottom[x]) {
        if (vp.top[x] < globalMinY) globalMinY = vp.top[x];
        if (vp.bottom[x] > globalMaxY) globalMaxY = vp.bottom[x];
      }
    }
    if (globalMinY > globalMaxY) continue;
    if (globalMinY < 0) globalMinY = 0;
    if (globalMaxY >= viewheight) globalMaxY = viewheight - 1;

    for (let y = globalMinY; y <= globalMaxY; y++) {
      const dy = y - centery;
      if (dy === 0) {
        planeRowValid[y] = 0;
        continue;
      }
      const yslopeVal = yslope[y] || 0;
      const distance = Math.abs(fixedMul(planeheight, yslopeVal));
      if (distance === 0) {
        planeRowValid[y] = 0;
        continue;
      }
      planeRowValid[y] = 1;
      planeRowDistance[y] = distance;
      planeRowFloorScale[y] = fixedDiv(projection, distance);
      let zIdx = (distance >>> LIGHTZSHIFT) | 0;
      if (zIdx >= MAXLIGHTZ) zIdx = MAXLIGHTZ - 1;
      planeRowColormapIdx[y] = zlight[lightnum]?.[zIdx] ?? 0;
    }

    // --- Column iteration with precomputed per-row lookups ---
    for (let x = vp.minx; x <= vp.maxx; x++) {
      const t = vp.top[x];
      const b = vp.bottom[x];
      if (t > b) continue;

      // Per-column values (computed once per column)
      const distscaleX = distscale[x] || FRACUNIT;
      const viewAngleFine = ((viewangle + (xtoviewangle[x] || 0)) >>> ANGLETOFINESHIFT) & FINEMASK;
      const cosVal = finecosine(viewAngleFine);
      const sinVal = finesine[viewAngleFine] || 0;

      for (let y = t; y <= b; y++) {
        if (y < 0 || y >= viewheight || !planeRowValid[y]) continue;

        const distance = planeRowDistance[y];
        const floorScale = planeRowFloorScale[y];

        // Z-test: skip if a WALL pixel is closer
        const dest = y * SCREENWIDTH + x;
        const existingZ = zBuffer[dest];
        if ((existingZ & ZFLAG_WALL) && (existingZ & Z_DEPTH_MASK) > floorScale) continue;

        const length = fixedMul(distance, distscaleX);
        const xfrac = viewx + fixedMul(cosVal, length);
        const yfrac = -viewy - fixedMul(sinVal, length);

        const tx = ((xfrac >> FRACBITS) & 63);
        const ty = ((yfrac >> FRACBITS) & 63);
        const pixel = flatData[(ty * 64 + tx) & 4095] || 0;

        // Write G-Buffer (inlined)
        g.paletteIdx[dest] = pixel;
        g.lightLevel[dest] = planeRowColormapIdx[y];
        g.worldX[dest] = xfrac;
        g.worldY[dest] = -yfrac;
        g.worldZ[dest] = vpHeight;
        g.flags[dest] = surfaceType;
        zBuffer[dest] = floorScale;
      }
    }
  }
}

function drawSky(vp: Visplane): void {
  const skyTex = texData.textures[skytexture];
  const lookup = palData.getColormapLookup(0);

  for (let x = vp.minx; x <= vp.maxx; x++) {
    const t = vp.top[x];
    const b = vp.bottom[x];
    if (t > b) continue;

    if (skyTex) {
      const angle = ((viewangle + xtoviewangle[x]) >>> 0);
      const col = ((angle >>> ANGLETOFINESHIFT) * skyTex.width / FINEANGLES) | 0;
      const texCol = skyTex.columns[((col % skyTex.width) + skyTex.width) % skyTex.width];
      if (texCol) {
        for (let y = t; y <= b; y++) {
          if (y >= 0 && y < viewheight) {
            const pixel = texCol[((y * skyTex.height / viewheight) | 0) % skyTex.height] || 0;
            rgbaBuffer[y * SCREENWIDTH + x] = lookup[pixel];
          }
        }
        continue;
      }
    }

    // Fallback: dark blue
    for (let y = t; y <= b; y++) {
      if (y >= 0 && y < viewheight) {
        rgbaBuffer[y * SCREENWIDTH + x] = 0xFF200020;
      }
    }
  }
}

// ===========================================================
// Sprite Rendering (R_ProjectSprite / R_DrawSprite)
// ===========================================================



/** Project a single thing to screen coordinates and add as vissprite */
function projectSprite(
  thing: MapThing,
  info: { sprite: string; frame: number; radius: number; height: number },
  sector: Sector,
  thingIdx: number
): void {
  // Use runtime position from MapObjState if available (monsters move!)
  const mobj = getMapObjectByThingIndex(thingIdx);
  const tx = mobj ? mobj.x : (thing.x << FRACBITS);
  const ty = mobj ? mobj.y : (thing.y << FRACBITS);

  // Transform to view-relative coordinates
  const dx = tx - viewx;
  const dy = ty - viewy;

  // Rotate around view angle (matches DOOM's R_ProjectSprite)
  const trx = fixedMul(dx, viewcos) + fixedMul(dy, viewsin);   // depth (tz)
  const try_ = fixedMul(dx, viewsin) - fixedMul(dy, viewcos);  // lateral (tx)

  // Behind camera?
  if (trx < FRACUNIT * 4) {
    return;
  }

  // Screen-space X position
  const xscale = fixedDiv(projection, trx);
  const screenX = centerx + ((fixedMul(try_, xscale)) >> FRACBITS);

  // Too far to the side?
  if (screenX < -SCREENWIDTH || screenX > SCREENWIDTH * 2) {
    return;
  }

  // Get sprite angle relative to viewer
  // DOOM convention: angle from thing TO viewer, minus thing's facing angle
  const angToViewer = Math.atan2(
    (viewy - ty) / FRACUNIT,
    (viewx - tx) / FRACUNIT
  );
  // Get thing facing angle — use BAM from MapObjState if available,
  // otherwise convert from degrees (static map data)
  let thingAngleBam: number;
  if (mobj) {
    thingAngleBam = mobj.angle;
  } else {
    thingAngleBam = ((thing.angle * 0x100000000 / 360) >>> 0);
  }
  const thingAngle = (thingAngleBam / 0x80000000) * Math.PI;
  const relAngle = angToViewer - thingAngle;
  // Normalize angle to [0, 2π)
  const normalizedAngle = ((relAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

  // Get sprite patch for this frame and rotation
  // Check for animation state first
  const animFrame = getThingAnimFrame(thingIdx);
  const spriteFrame = spriteData!.getSpriteFrame(
    animFrame ? animFrame.sprite : info.sprite,
    animFrame ? animFrame.frame : info.frame,
    normalizedAngle
  );
  if (!spriteFrame) {
    return;
  }

  const { patch, flip } = spriteFrame;

  // Calculate screen extents using patch offsets (matches DOOM's R_ProjectSprite)
  // topOffset = distance from top of sprite to its "feet" anchor point
  // leftOffset = horizontal anchor (center of sprite in world)
  // sector.floorHeight is already in fixed-point (shifted during sector loading)
  const thingFloorZ = mobj ? mobj.z : sector.floorHeight;
  const thingTopZ = thingFloorZ + (patch.topOffset << FRACBITS);

  // Texture mid point (where to anchor the sprite vertically)
  const texturemid = thingTopZ - viewz;

  // Calculate screen columns using leftOffset for proper horizontal centering
  const spriteOffset = patch.leftOffset << FRACBITS;
  const x1 = screenX - ((fixedMul(spriteOffset, xscale)) >> FRACBITS);
  const x2 = x1 + ((fixedMul(patch.width << FRACBITS, xscale)) >> FRACBITS) - 1;

  // Fully off-screen?
  if (x2 < 0 || x1 >= viewwidth) return;

  // Inverse scale for column stepping
  const xiscale = fixedDiv(FRACUNIT, xscale);

  // Light level from sector
  const lightLevel = Math.max(0, Math.min(sector.lightLevel >> 4, LIGHTLEVELS - 1));

  // Clamp screen extents
  const cx1 = Math.max(0, x1);
  const cx2 = Math.min(viewwidth - 1, x2);

  // Snapshot clip arrays into shared buffer
  const clipWidth = cx2 - cx1 + 1;
  const clipOff = allocClip(clipWidth);
  for (let i = 0; i < clipWidth; i++) {
    clipBuf[clipOff + i] = floorclip[cx1 + i];
    clipBuf[clipOff + clipWidth + i] = ceilingclip[cx1 + i];
  }

  // DOOM: R_ProjectSprite — calculate startfrac adjusted for left clipping
  const absXiscale = flip ? -xiscale : xiscale;
  let startFrac: number;
  if (flip) {
    startFrac = (patch.width - 1) << FRACBITS;
  } else {
    startFrac = 0;
  }
  if (cx1 > x1) {
    startFrac += absXiscale * (cx1 - x1);
  }

  // Check MF_SHADOW flag for fuzz rendering (Spectre, partial invisibility)
  const hasFuzz = mobj ? !!(mobj.flags & MF_SHADOW) : (thing.type === 58); // type 58 = Spectre

  vissprites.push({
    x1: cx1,
    x2: cx2,
    gx: tx,
    gy: ty,
    gz: thingFloorZ,
    gzt: thingTopZ,
    scale: xscale,
    xiscale: absXiscale,
    startFrac,
    texturemid,
    patch,
    flip,
    colormap: lightLevel,
    dist: trx,
    clipOffset: clipOff,
    isFuzz: hasFuzz,
  });
}

/** Build per-subsector VFX map at the start of each frame */
function buildVfxSubsectorMap(): void {
  subsectorVfx.clear();
  if (!spriteData) return;
  const effects = getActiveVfx();
  for (const e of effects) {
    const ss = map.pointInSubsector(e.x, e.y);
    const ssIdx = map.subsectors.indexOf(ss);
    if (ssIdx < 0) continue;
    if (!subsectorVfx.has(ssIdx)) subsectorVfx.set(ssIdx, []);
    subsectorVfx.get(ssIdx)!.push(e);
  }
}

/** Build per-subsector dropped items map at the start of each frame */
function buildDropSubsectorMap(): void {
  subsectorDrops.clear();
  if (!spriteData) return;
  const items = getDroppedItems();
  for (const item of items) {
    const ss = map.pointInSubsector(item.x, item.y);
    const ssIdx = map.subsectors.indexOf(ss);
    if (ssIdx < 0) continue;
    if (!subsectorDrops.has(ssIdx)) subsectorDrops.set(ssIdx, []);
    subsectorDrops.get(ssIdx)!.push(item);
  }
}

/** Build per-subsector projectile map at the start of each frame */
function buildProjectileSubsectorMap(): void {
  subsectorProjectiles.clear();
  if (!spriteData) return;
  const projectiles = getActiveProjectiles();
  for (const p of projectiles) {
    if (p.removed) continue;
    const ss = map.pointInSubsector(p.x, p.y);
    const ssIdx = map.subsectors.indexOf(ss);
    if (ssIdx < 0) continue;
    if (!subsectorProjectiles.has(ssIdx)) subsectorProjectiles.set(ssIdx, []);
    subsectorProjectiles.get(ssIdx)!.push(p);
  }
}

/** Project a dropped item sprite — called during BSP traversal from renderSubsector */
function projectDropSprite(item: DroppedItem, sector: Sector): void {
  const info = THING_INFO[item.thingType];
  if (!info) return;

  const dx = item.x - viewx;
  const dy = item.y - viewy;
  const trx = fixedMul(dx, viewcos) + fixedMul(dy, viewsin);
  const try_ = fixedMul(dx, viewsin) - fixedMul(dy, viewcos);

  if (trx < FRACUNIT * 4) return;

  const xscale = fixedDiv(projection, trx);
  const screenX = centerx + ((fixedMul(try_, xscale)) >> FRACBITS);
  if (screenX < -SCREENWIDTH || screenX > SCREENWIDTH * 2) return;

  // Dropped items always face the viewer (rotation 0)
  const spriteFrame = spriteData!.getSpriteFrame(info.sprite, info.frame, 0);
  if (!spriteFrame) return;
  const { patch, flip } = spriteFrame;

  const lightLevel = Math.max(0, Math.min(sector.lightLevel >> 4, LIGHTLEVELS - 1));
  const thingTopZ = item.z + (patch.topOffset << FRACBITS);
  const texturemid = thingTopZ - viewz;
  const spriteOffset = patch.leftOffset << FRACBITS;
  const x1 = screenX - ((fixedMul(spriteOffset, xscale)) >> FRACBITS);
  const x2 = x1 + ((fixedMul(patch.width << FRACBITS, xscale)) >> FRACBITS) - 1;
  if (x2 < 0 || x1 >= viewwidth) return;

  const xiscale = fixedDiv(FRACUNIT, xscale);
  const cx1 = Math.max(0, x1);
  const cx2 = Math.min(viewwidth - 1, x2);

  const clipW2 = cx2 - cx1 + 1;
  const clipOff2 = allocClip(clipW2);
  for (let i = 0; i < clipW2; i++) {
    clipBuf[clipOff2 + i] = floorclip[cx1 + i];
    clipBuf[clipOff2 + clipW2 + i] = ceilingclip[cx1 + i];
  }

  const absXiscale = flip ? -xiscale : xiscale;
  let startFrac = flip ? (patch.width - 1) << FRACBITS : 0;
  if (cx1 > x1) {
    startFrac += absXiscale * (cx1 - x1);
  }

  vissprites.push({
    x1: cx1, x2: cx2,
    gx: item.x, gy: item.y, gz: item.z, gzt: thingTopZ,
    scale: xscale, xiscale: absXiscale, startFrac,
    texturemid, patch, flip,
    colormap: lightLevel, dist: trx,
    clipOffset: clipOff2,
    isFuzz: false,
  });
}

/** Project a single VFX effect — called during BSP traversal from renderSubsector */
function projectVfxSprite(e: VfxEffect, sector: Sector): void {
  const { sprite, frame } = getVfxSprite(e);

  // Transform to view-relative coordinates
  const dx = e.x - viewx;
  const dy = e.y - viewy;
  const trx = fixedMul(dx, viewcos) + fixedMul(dy, viewsin);   // depth
  const try_ = fixedMul(dx, viewsin) - fixedMul(dy, viewcos);  // lateral

  if (trx < FRACUNIT * 4) return; // behind camera

  const xscale = fixedDiv(projection, trx);
  const screenX = centerx + ((fixedMul(try_, xscale)) >> FRACBITS);
  if (screenX < -SCREENWIDTH || screenX > SCREENWIDTH * 2) return;

  // VFX sprites always face the viewer (angle=0 for sprite rotation)
  const spriteFrame = spriteData!.getSpriteFrame(sprite, frame, 0);
  if (!spriteFrame) return;
  const { patch, flip } = spriteFrame;

  const lightLevel = Math.max(0, Math.min(sector.lightLevel >> 4, LIGHTLEVELS - 1));

  // Calculate screen extents
  const thingTopZ = e.z + (patch.topOffset << FRACBITS);
  const texturemid = thingTopZ - viewz;
  const spriteOffset = patch.leftOffset << FRACBITS;
  const x1 = screenX - ((fixedMul(spriteOffset, xscale)) >> FRACBITS);
  const x2 = x1 + ((fixedMul(patch.width << FRACBITS, xscale)) >> FRACBITS) - 1;
  if (x2 < 0 || x1 >= viewwidth) return;

  const xiscale = fixedDiv(FRACUNIT, xscale);
  const cx1 = Math.max(0, x1);
  const cx2 = Math.min(viewwidth - 1, x2);

  // Snapshot clip arrays into shared buffer
  const clipW3 = cx2 - cx1 + 1;
  const clipOff3 = allocClip(clipW3);
  for (let i = 0; i < clipW3; i++) {
    clipBuf[clipOff3 + i] = floorclip[cx1 + i];
    clipBuf[clipOff3 + clipW3 + i] = ceilingclip[cx1 + i];
  }

  const absXiscale = flip ? -xiscale : xiscale;
  let startFrac = flip ? (patch.width - 1) << FRACBITS : 0;
  if (cx1 > x1) {
    startFrac += absXiscale * (cx1 - x1);
  }

  vissprites.push({
    x1: cx1,
    x2: cx2,
    gx: e.x,
    gy: e.y,
    gz: e.z,
    gzt: thingTopZ,
    scale: xscale,
    xiscale: absXiscale,
    startFrac,
    texturemid,
    patch,
    flip,
    colormap: lightLevel,
    dist: trx,
    clipOffset: clipOff3,
    isFuzz: false,
  });
}

/** Project a single projectile — called during BSP traversal from renderSubsector */
function projectProjectileSprite(proj: Projectile, sector: Sector): void {
  const { sprite, frame } = getProjectileSprite(proj);

  // Transform to view-relative coordinates
  const dx = proj.x - viewx;
  const dy = proj.y - viewy;
  const trx = fixedMul(dx, viewcos) + fixedMul(dy, viewsin);   // depth
  const try_ = fixedMul(dx, viewsin) - fixedMul(dy, viewcos);  // lateral

  if (trx < FRACUNIT * 4) return; // behind camera

  const xscale = fixedDiv(projection, trx);
  const screenX = centerx + ((fixedMul(try_, xscale)) >> FRACBITS);
  if (screenX < -SCREENWIDTH || screenX > SCREENWIDTH * 2) return;

  // Projectile sprites always face the viewer (angle=0 for rotation)
  const spriteFrame = spriteData!.getSpriteFrame(sprite, frame, 0);
  if (!spriteFrame) return;
  const { patch, flip } = spriteFrame;

  const lightLevel = Math.max(0, Math.min(sector.lightLevel >> 4, LIGHTLEVELS - 1));

  // Calculate screen extents — projectile z is the bottom, sprite anchors from topOffset
  const thingTopZ = proj.z + (patch.topOffset << FRACBITS);
  const texturemid = thingTopZ - viewz;
  const spriteOffset = patch.leftOffset << FRACBITS;
  const x1 = screenX - ((fixedMul(spriteOffset, xscale)) >> FRACBITS);
  const x2 = x1 + ((fixedMul(patch.width << FRACBITS, xscale)) >> FRACBITS) - 1;
  if (x2 < 0 || x1 >= viewwidth) return;

  const xiscale = fixedDiv(FRACUNIT, xscale);
  const cx1 = Math.max(0, x1);
  const cx2 = Math.min(viewwidth - 1, x2);

  // Snapshot clip arrays
  const clipW = cx2 - cx1 + 1;
  const clipOff = allocClip(clipW);
  for (let i = 0; i < clipW; i++) {
    clipBuf[clipOff + i] = floorclip[cx1 + i];
    clipBuf[clipOff + clipW + i] = ceilingclip[cx1 + i];
  }

  const absXiscale = flip ? -xiscale : xiscale;
  let startFrac = flip ? (patch.width - 1) << FRACBITS : 0;
  if (cx1 > x1) {
    startFrac += absXiscale * (cx1 - x1);
  }

  vissprites.push({
    x1: cx1, x2: cx2,
    gx: proj.x, gy: proj.y, gz: proj.z, gzt: thingTopZ,
    scale: xscale, xiscale: absXiscale, startFrac,
    texturemid, patch, flip,
    colormap: lightLevel, dist: trx,
    clipOffset: clipOff,
    isFuzz: false,
  });
}

/** Sort vissprites and draw them back-to-front */
function drawSprites(): void {
  if (vissprites.length === 0) return;

  // Sort back-to-front (farthest first)
  vissprites.sort((a, b) => b.dist - a.dist);

  // Debug: log every 60 frames
  const shouldLog = false;

  // Draw each vissprite
  for (let i = 0; i < vissprites.length; i++) {
    const vis = vissprites[i];
    drawVisSprite(vis);
  }
}

// ===========================================================
// Draw Masked Midtextures (Fences, Grates, Bars)
// Reference: R_RenderMaskedSegRange in r_segs.c
//            R_DrawMasked in r_things.c (final pass)
// ===========================================================

function drawMaskedMidTextures(): void {
  for (let dsIdx = drawsegs.length - 1; dsIdx >= 0; dsIdx--) {
    const ds = drawsegs[dsIdx];
    if (!ds.maskedTextureCol) continue;

    const seg = ds.seg;
    const frontsector = seg.frontsector;
    const backsector = seg.backsector;
    if (!backsector) continue;

    const texnum = getAnimatedTexture(seg.sidedef.midTexture);
    const tex = texData.textures[texnum];
    if (!tex) continue;

    // Calculate light table
    const lightnum = Math.max(0, Math.min(LIGHTLEVELS - 1,
      (frontsector.lightLevel >> LIGHTSEGSHIFT) | 0));

    // Find texture positioning (R_RenderMaskedSegRange)
    // ML_DONTPEGBOTTOM (flag 16): bottom of texture at lower floor
    let textureMid: number;
    if (seg.linedef.flags & 16) { // ML_DONTPEGBOTTOM
      textureMid = Math.max(frontsector.floorHeight, backsector.floorHeight)
                   + (tex.height << FRACBITS) - viewz;
    } else {
      textureMid = Math.min(frontsector.ceilingHeight, backsector.ceilingHeight)
                   - viewz;
    }
    textureMid += seg.sidedef.rowOffset;

    // Draw columns
    let spryscale = ds.scale1 + (ds.x1 - ds.x1) * ds.scalestep; // = ds.scale1
    for (let x = ds.x1; x <= ds.x2; x++) {
      const textureColumn = ds.maskedTextureCol[x];
      if (textureColumn === 0x7FFF) {
        spryscale += ds.scalestep;
        continue; // skip this column
      }

      // Compute column boundaries
      if (spryscale < 64) spryscale = 64;
      const iscale = fixedDiv(FRACUNIT, spryscale);

      // Light
      let lightIdx = (spryscale >> LIGHTSCALESHIFT) | 0;
      if (lightIdx >= MAXLIGHTSCALE) lightIdx = MAXLIGHTSCALE - 1;
      if (lightIdx < 0) lightIdx = 0;
      const colormapIdx = scalelight[lightnum]?.[lightIdx] ?? 0;

      // Get texture column data with wrapping
      const tcx = ((textureColumn % tex.width) + tex.width) % tex.width;

      // Compute screen top/bottom of the masked column
      // sprtopscreen = centeryfrac - FixedMul(textureMid, spryscale)
      const sprtopscreen = centeryfrac - fixedMul(textureMid, spryscale);
      const yl = ((sprtopscreen + FRACUNIT - 1) >> FRACBITS) | 0;
      const yh = ((sprtopscreen + fixedMul(tex.height << FRACBITS, spryscale) - 1) >> FRACBITS) | 0;

      // Clip to drawseg clip arrays
      const clipTop = ds.sprTopClip[x];
      const clipBottom = ds.sprBottomClip[x];

      const clippedYl = Math.max(yl, clipTop + 1);
      const clippedYh = Math.min(yh, clipBottom - 1);

      if (clippedYl <= clippedYh && x >= 0 && x < SCREENWIDTH) {
        // Set Z-scale for depth buffer
        setZScale(spryscale);

        // Compute world position of this column
        const colAngle = (viewangle + (xtoviewangle[x] || 0)) >>> 0;
        const colAnIdx = (colAngle >>> ANGLETOFINESHIFT) & FINEMASK;
        const dist = spryscale > 0 ? fixedDiv(projection, spryscale) : (512 * FRACUNIT);

        dc.colormap = null;
        dc.x = x;
        dc.yl = clippedYl;
        dc.yh = clippedYh;
        dc.textureMid = textureMid;
        dc.iscale = iscale;
        dc.source = tex.columns[tcx];
        dc.sourceLength = tex.height;
        dc.colormapIdx = colormapIdx;
        dc.surfaceType = SurfaceType.WALL;
        dc.worldX = viewx + fixedMul(dist, finecosine(colAnIdx));
        dc.worldY = viewy + fixedMul(dist, finesine[colAnIdx]);
        dc.worldTopZ = Math.min(frontsector.ceilingHeight, backsector.ceilingHeight);
        dc.worldBottomZ = Math.max(frontsector.floorHeight, backsector.floorHeight);

        drawMaskedColumnDeferred(tex.columnMask[tcx]);
      }

      spryscale += ds.scalestep;
    }

    // Mark as rendered
    ds.maskedTextureCol = null;
  }
}

/** Draw a single vissprite's masked columns */
function drawVisSprite(vis: VisSprite): void {
  const patch = vis.patch;

  // Light lookup
  const lightIdx = vis.colormap;
  const scaleLightRow = scalelight[lightIdx] || scalelight[0];
  const lightScale = Math.min(Math.max(vis.scale >> LIGHTSCALESHIFT, 0), MAXLIGHTSCALE - 1);
  const colormapIdx = scaleLightRow[lightScale];
  const colormap = palData.getColormapLookup(colormapIdx);

  // Use pre-computed startFrac (already adjusted for left clipping in projectSprite)
  const stepFrac = vis.xiscale;
  let frac = vis.startFrac;

  for (let x = vis.x1; x <= vis.x2; x++) {
    // Get texture column index
    const col = (frac >> FRACBITS) & 0x7FFF;
    if (col < 0 || col >= patch.width) {
      frac += stepFrac;
      continue;
    }

    // Calculate column top and bottom on screen
    const sprtopscreen = centery - ((fixedMul(vis.texturemid, vis.scale)) >> FRACBITS);
    const spryscale = vis.scale;
    const sprBottomScreen = sprtopscreen + ((fixedMul(patch.height << FRACBITS, spryscale)) >> FRACBITS);

    // Clip against saved floor and ceiling from shared clip buffer
    const clipIdx = x - vis.x1;
    const clipWidth = vis.x2 - vis.x1 + 1;
    let yl = Math.max(Math.ceil(sprtopscreen), clipBuf[vis.clipOffset + clipWidth + clipIdx] + 1);
    let yh = Math.min(Math.floor(sprBottomScreen) - 1, clipBuf[vis.clipOffset + clipIdx] - 1);

    if (yl > yh) {
      frac += stepFrac;
      continue;
    }

    // Clamp to viewport
    if (yl < 0) yl = 0;
    if (yh >= viewheight) yh = viewheight - 1;

    // Draw the column posts
    const patchCol = patch.columns[col];
    for (const post of patchCol) {
      // Calculate screen Y range for this post
      const postTopScreen = sprtopscreen + ((post.topDelta * spryscale) >> FRACBITS);
      const postBottomScreen = postTopScreen + ((post.length * spryscale) >> FRACBITS);

      const drawYl = Math.max(Math.ceil(postTopScreen), yl);
      const drawYh = Math.min(Math.floor(postBottomScreen) - 1, yh);

      if (drawYl > drawYh) continue;

      // Per-pixel Z-test: sprites only test against WALL pixels (ZFLAG_WALL).
      // Floor/ceiling pixels don't block sprites -- sprites draw on top of floors,
      // matching original DOOM's painter's algorithm (floors first, then sprites).
      const spriteScale = vis.scale;
      for (let y = drawYl; y <= drawYh; y++) {
        const texY = Math.floor(((y - postTopScreen) * post.length) / Math.max(1, postBottomScreen - postTopScreen));
        if (texY < 0 || texY >= post.length) continue;

        const pixel = post.data[texY];
        if (pixel === undefined) continue;

        const dest = y * SCREENWIDTH + x;
        const existingZ = zBuffer[dest];
        if ((existingZ & ZFLAG_WALL) && (existingZ & Z_DEPTH_MASK) > spriteScale) continue;

        // Sprite world Z: interpolate between gzt (top) and gz (bottom)
        const sprFrac = (y - sprtopscreen) / Math.max(1, sprBottomScreen - sprtopscreen);
        const wz = vis.gzt - ((sprFrac * (vis.gzt - vis.gz)) | 0);
        if (vis.isFuzz) {
          // Fuzz effect: just mark in G-Buffer, resolved later
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
// ===========================================================
// Psprite Rendering (Weapon Overlay)
// Reference: r_things.c R_DrawPSprite
// ===========================================================

import { getPspriteInfo, WeaponPlayer, PspDef, WEAPONTOP } from '../../../game/weapons';

let pspritePlayer: WeaponPlayer | null = null;

export function setPspritePlayer(p: WeaponPlayer): void {
  pspritePlayer = p;
}

export function drawPSprites(): void {
  if (!pspritePlayer || !spriteData) return;

  // DOOM: pspritescale = FixedDiv(viewwidth, SCREENWIDTH=320)
  const pspritescale = SCREENWIDTH / 320;
  const BASEYCENTER = 100; // DOOM constant (r_things.c line 47)

  for (let i = 0; i < 2; i++) {
    const info = getPspriteInfo(pspritePlayer, i);
    if (!info) continue;

    const result = spriteData.getSpriteFrame(info.sprite, info.frame, 0);
    if (!result) continue;

    const patch = result.patch;

    // === X positioning (R_DrawPSprite lines 676-679) ===
    // tx = psp->sx - 160*FRACUNIT
    // tx -= spriteoffset[lump]     (= leftOffset in pixels)
    // x1 = centerx + tx * pspritescale
    const tx = (info.sx >> FRACBITS) - 160 - patch.leftOffset;
    const x1 = Math.round(centerx + tx * pspritescale);

    // === Y positioning (R_DrawPSprite line 695 + R_DrawVisSprite line 428) ===
    // texturemid = BASEYCENTER + 0.5 - (sy - topOffset)
    // sprtopscreen = pspriteCentery - texturemid * spryscale
    //
    // At 320×200: centery=84, BASEYCENTER=100. The weapon bottom touches viewheight.
    // At other resolutions (e.g., 800×600): centery doesn't scale proportionally.
    // Fix: anchor weapon Y relative to viewport bottom, not center.
    // Original DOOM: weapon_centery_offset = centery (84) at 320×200.
    // Scaled: pspriteCentery = viewheight - (200 - 32 - 84) * pspritescale
    //       = viewheight - 84 * pspritescale (offset from bottom in scaled pixels)
    const pspriteCentery = viewheight - 84 * pspritescale;
    const sy_px = info.sy >> FRACBITS;
    const texturemid = BASEYCENTER + 0.5 - (sy_px - patch.topOffset);
    const sprtopscreen = pspriteCentery - texturemid * pspritescale;

    // Weapon lighting: use sector light level at player position
    // (dimmed in dark areas, bright in light areas)
    // extralight from muzzle flash also brightens the weapon
    const playerSS = map.pointInSubsector(viewx, viewy);
    const sectorLight = playerSS.sector ? playerSS.sector.lightLevel : 255;
    // Map sector light (0-255) to colormap index (0=bright, max=dark)
    // Similar to how walls are lit, but without distance attenuation
    let weaponLight = Math.floor((NUMCOLORMAPS - 1) * (1 - sectorLight / 255));
    weaponLight = Math.max(0, weaponLight - extralight * 4);
    const colormap = palData.getColormapLookup(weaponLight);

    drawPSpritePatch(patch, x1, sprtopscreen, pspritescale, result.flip, colormap);
  }
}

function drawPSpritePatch(
  patch: Patch, x1: number, sprtopscreen: number,
  scale: number, flip: boolean, colormap: Uint32Array
): void {
  const patchWidth = patch.width;
  // DOOM: x2 = x1 + spritewidth * pspritescale - 1
  const x2 = x1 + Math.round(patchWidth * scale) - 1;

  // Clip to viewport (R_DrawPSprite lines 696-712)
  const clippedX1 = Math.max(x1, 0);
  const clippedX2 = Math.min(x2, SCREENWIDTH - 1);
  if (clippedX1 > clippedX2) return;

  // DOOM fractional column traversal:
  //   xiscale = 1/pspritescale (texture units per screen pixel)
  //   frac = startfrac (0 or spritewidth-1 depending on flip)
  //   if clipped left: frac += xiscale * (clippedX1 - x1)
  const xiscale = patchWidth / (x2 - x1 + 1); // texels per screen pixel
  let startfrac: number;

  if (flip) {
    startfrac = patchWidth - 1;
    if (clippedX1 > x1) {
      startfrac -= xiscale * (clippedX1 - x1);
    }
  } else {
    startfrac = 0;
    if (clippedX1 > x1) {
      startfrac += xiscale * (clippedX1 - x1);
    }
  }

  let frac = startfrac;
  for (let screenX = clippedX1; screenX <= clippedX2; screenX++) {
    const patchCol = Math.floor(frac);
    if (patchCol >= 0 && patchCol < patchWidth) {
      const posts = patch.columns[patchCol];
      for (const post of posts) {
        // R_DrawMaskedColumn: topscreen = sprtopscreen + spryscale * topdelta
        const postTopScreen = sprtopscreen + post.topDelta * scale;
        const postHeight = post.length * scale;

        const drawYl = Math.max(Math.ceil(postTopScreen), 0);
        const drawYh = Math.min(Math.floor(postTopScreen + postHeight - 1), viewheight - 1);

        for (let y = drawYl; y <= drawYh; y++) {
          const texY = Math.floor((y - postTopScreen) * post.length / postHeight);
          if (texY >= 0 && texY < post.length) {
            const pixel = post.data[texY];
            if (pixel !== undefined) {
              const dest = y * SCREENWIDTH + screenX;
              rgbaBuffer[dest] = colormap[pixel];
              // Mark as PSPRITE — dynlights applies uniform player-position light
              gBuffer.flags[dest] = SurfaceType.PSPRITE;
            }
          }
        }
      }
    }

    frac += flip ? -xiscale : xiscale;
  }
}

// ===========================================================
// Depth Visualization Overlay
// ===========================================================

/** Convert Z-buffer to grayscale image for depth visualization mode */
export function renderDepthOverlay(): void {
  const size = SCREENWIDTH * viewheight;
  // Find max depth in the buffer for normalization (strip wall flag)
  let maxZ = 1;
  for (let i = 0; i < size; i++) {
    const d = zBuffer[i] & Z_DEPTH_MASK;
    if (d > maxZ) maxZ = d;
  }
  // Convert: higher scale (closer) = brighter
  for (let i = 0; i < size; i++) {
    const z = zBuffer[i] & Z_DEPTH_MASK;
    if (z === 0) {
      rgbaBuffer[i] = 0xFF000000; // black for sky/empty
    } else {
      const b = Math.min(255, (z * 255 / maxZ) | 0);
      rgbaBuffer[i] = 0xFF000000 | (b << 16) | (b << 8) | b;
    }
  }
}

// ===========================================================
// Exports
// ===========================================================

export function getFrameBuffer(): Uint32Array {
  return rgbaBuffer;
}

export { viewx, viewy, viewz, viewangle, SCREENWIDTH, SCREENHEIGHT };
