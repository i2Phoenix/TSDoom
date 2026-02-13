// ============================================================
// Automap — Top-down 2D level map overlay
// Reference: am_map.c
// Modes: OFF → FULLSCREEN → MINIMAP → OFF
// ============================================================

import { FRACUNIT, FRACBITS } from './math';
import type { GameMap, LineDef, Vertex } from '../src/map';
import { ML_TWOSIDED, ML_SECRET, ML_DONTDRAW, ML_MAPPED } from '../src/map';
import { rgbaBuffer, SCREENWIDTH, SCREENHEIGHT } from '../src/render/software/draw';
import { getMapObjects, type MapObjState } from './mobj';
import { MF_COUNTKILL } from './mobjinfo';

// ---- Colors (0xAABBGGRR — little-endian ABGR for Uint32Array) ----
const WALLCOLOR   = 0xFF0000FC; // Red — one-sided walls
const FDWALLCOLOR = 0xFF0066AA; // Brown — floor height change
const CDWALLCOLOR = 0xFF00FCFC; // Yellow — ceiling height change
const TSWALLCOLOR = 0xFF808080; // Gray — same-height two-sided
const SECRETCOLOR = WALLCOLOR;  // Secret lines look like walls until discovered
const PLAYERCOLOR = 0xFF00FC00; // Green — player arrow
const THINGCOLOR  = 0xFF00FC00; // Green — thing markers

const BGCOLOR     = 0xFF000000; // Black background
const MINI_BORDER = 0xFF606060; // Gray border for minimap

// ---- Zoom limits ----
const MIN_SCALE = 0.02;
const MAX_SCALE = 5.0;
const ZOOM_SPEED = 1.08;
const PAN_SPEED = 8; // map units per tick when panning

// ---- Minimap size (fraction of screen) ----
const MINI_FRAC_W = 0.28; // 28% of screen width
const MINI_FRAC_H = 0.28; // 28% of screen height
const MINI_MARGIN = 4;     // pixels from edge
const MINI_BG_DIM = 0.35;  // darken existing scene to 35% brightness
const MINI_LINE_ALPHA = 0.85; // line opacity on minimap

// ---- Player arrow shape ----
const ARROW_LINES: [number, number, number, number][] = [
  [-0.6, 0, 1.0, 0],     // shaft
  [1.0, 0, 0.4, 0.5],    // upper head
  [1.0, 0, 0.4, -0.5],   // lower head
];

const ARROW_SIZE = 16; // pixels (half-extent) for fullscreen
const MINI_ARROW_SIZE = 8; // pixels for minimap

// ---- Display mode ----
export const enum AutomapMode {
  OFF = 0,
  FULLSCREEN = 1,
  MINIMAP = 2,
}

// ---- Module state ----
let mode: AutomapMode = AutomapMode.OFF;
let map: GameMap | null = null;

// View state (used for fullscreen mode)
let viewX = 0;   // center of automap in map coords (fixed_t)
let viewY = 0;
let scale = 0.15; // pixels per map unit (adjusted at start)
let followMode = true;

// Minimap scale (computed once on AM_Start, always follows player)
let miniScale = 0.08;

// Cheat reveal level: 0=normal, 1=all lines, 2=all lines+things
let revealLevel = 0;

// ---- Viewport for current draw (set before drawing) ----
let vpX = 0, vpY = 0, vpW = SCREENWIDTH, vpH = SCREENHEIGHT;
/** When true, line/dot drawing blends instead of overwriting */
let blendMode = false;

// ---- Public API ----

export function isAutomapActive(): boolean {
  return mode !== AutomapMode.OFF;
}

export function isAutomapFullscreen(): boolean {
  return mode === AutomapMode.FULLSCREEN;
}

export function getAutomapMode(): AutomapMode {
  return mode;
}

export function AM_Start(m: GameMap): void {
  map = m;
  revealLevel = 0;
  followMode = true;
  mode = AutomapMode.OFF;
  computeScales();
}

export function AM_Stop(): void {
  mode = AutomapMode.OFF;
  map = null;
}

/** Cycle automap mode: OFF → FULLSCREEN → MINIMAP → OFF */
export function AM_Toggle(): void {
  switch (mode) {
    case AutomapMode.OFF:
      mode = AutomapMode.FULLSCREEN;
      if (map) computeScales();
      break;
    case AutomapMode.FULLSCREEN:
      mode = AutomapMode.MINIMAP;
      break;
    case AutomapMode.MINIMAP:
      mode = AutomapMode.OFF;
      break;
  }
}

/** Cycle IDDT cheat reveal level */
export function AM_CycleReveal(): void {
  revealLevel = (revealLevel + 1) % 3;
}

/**
 * Handle a keydown for the automap. Returns true if consumed.
 */
export function AM_Responder(code: string): boolean {
  if (mode === AutomapMode.OFF) {
    if (code === 'Tab') {
      AM_Toggle();
      return true;
    }
    return false;
  }

  // Minimap mode: only TAB to cycle further
  if (mode === AutomapMode.MINIMAP) {
    if (code === 'Tab') {
      AM_Toggle();
      return true;
    }
    return false;
  }

  // Fullscreen mode: full controls
  switch (code) {
    case 'Tab':
      AM_Toggle();
      return true;

    case 'Equal':
    case 'NumpadAdd':
      scale = Math.min(scale * ZOOM_SPEED, MAX_SCALE);
      return true;

    case 'Minus':
    case 'NumpadSubtract':
      scale = Math.max(scale / ZOOM_SPEED, MIN_SCALE);
      return true;

    case 'ArrowUp':
      if (!followMode) viewY += PAN_SPEED * FRACUNIT / scale;
      return true;
    case 'ArrowDown':
      if (!followMode) viewY -= PAN_SPEED * FRACUNIT / scale;
      return true;
    case 'ArrowLeft':
      if (!followMode) viewX -= PAN_SPEED * FRACUNIT / scale;
      return true;
    case 'ArrowRight':
      if (!followMode) viewX += PAN_SPEED * FRACUNIT / scale;
      return true;

    case 'KeyF':
      followMode = !followMode;
      return true;

    default:
      return false;
  }
}

/**
 * Draw the automap overlay onto rgbaBuffer.
 */
export function AM_Drawer(
  playerX: number, playerY: number, playerAngle: number,
): void {
  if (mode === AutomapMode.OFF || !map) return;

  if (mode === AutomapMode.FULLSCREEN) {
    drawFullscreen(playerX, playerY, playerAngle);
  } else {
    drawMinimap(playerX, playerY, playerAngle);
  }
}

// ---- Fullscreen drawing ----

function drawFullscreen(
  playerX: number, playerY: number, playerAngle: number,
): void {
  // Set viewport to full screen
  vpX = 0; vpY = 0; vpW = SCREENWIDTH; vpH = SCREENHEIGHT;

  // Follow mode: center on player
  if (followMode) {
    viewX = playerX;
    viewY = playerY;
  }

  // Clear to black background
  rgbaBuffer.fill(BGCOLOR);

  drawLines(viewX, viewY, scale);
  drawThings(viewX, viewY, scale);
  drawPlayerArrow(playerX, playerY, playerAngle, viewX, viewY, scale, ARROW_SIZE);
}

// ---- Minimap drawing ----

function drawMinimap(
  playerX: number, playerY: number, playerAngle: number,
): void {
  const mw = Math.round(SCREENWIDTH * MINI_FRAC_W);
  const mh = Math.round(SCREENHEIGHT * MINI_FRAC_H);
  const mx = SCREENWIDTH - mw - MINI_MARGIN;
  const my = MINI_MARGIN;

  vpX = mx; vpY = my; vpW = mw; vpH = mh;
  blendMode = true;

  // Dim existing scene pixels in minimap area (semi-transparent background)
  for (let y = my; y < my + mh && y < SCREENHEIGHT; y++) {
    const row = y * SCREENWIDTH;
    for (let x = mx; x < mx + mw && x < SCREENWIDTH; x++) {
      const idx = row + x;
      const existing = rgbaBuffer[idx];
      const r = ((existing & 0xFF) * MINI_BG_DIM) | 0;
      const g = (((existing >> 8) & 0xFF) * MINI_BG_DIM) | 0;
      const b = (((existing >> 16) & 0xFF) * MINI_BG_DIM) | 0;
      rgbaBuffer[idx] = 0xFF000000 | (b << 16) | (g << 8) | r;
    }
  }

  // Draw border
  drawHLine(mx, my, mw, MINI_BORDER);
  drawHLine(mx, my + mh - 1, mw, MINI_BORDER);
  drawVLine(mx, my, mh, MINI_BORDER);
  drawVLine(mx + mw - 1, my, mh, MINI_BORDER);

  // Always centered on player for minimap
  drawLines(playerX, playerY, miniScale);
  drawThings(playerX, playerY, miniScale);
  drawPlayerArrow(playerX, playerY, playerAngle, playerX, playerY, miniScale, MINI_ARROW_SIZE);

  blendMode = false;
}

// ---- Shared drawing routines (use current viewport vpX/vpY/vpW/vpH) ----

function drawLines(cx: number, cy: number, s: number): void {
  if (!map) return;
  const verts = map.vertices;
  for (const line of map.linedefs) {
    const color = getLineColor(line);
    if (color === 0) continue;
    const v1 = verts[line.v1];
    const v2 = verts[line.v2];
    const sx1 = toScreenX(v1.x, cx, s);
    const sy1 = toScreenY(v1.y, cy, s);
    const sx2 = toScreenX(v2.x, cx, s);
    const sy2 = toScreenY(v2.y, cy, s);
    drawLine(sx1, sy1, sx2, sy2, color);
  }
}

function drawThings(cx: number, cy: number, s: number): void {
  if (revealLevel < 2) return;
  const things = getMapObjects();
  for (const mobj of things) {
    if (mobj.health <= 0) continue;
    const sx = toScreenX(mobj.x, cx, s);
    const sy = toScreenY(mobj.y, cy, s);
    const color = (mobj.flags & MF_COUNTKILL) ? 0xFF0000FC : THINGCOLOR;
    drawDot(sx, sy, color);
  }
}

function drawPlayerArrow(
  px: number, py: number, angle: number,
  cx: number, cy: number, s: number, arrowSize: number,
): void {
  const scrX = toScreenX(px, cx, s);
  const scrY = toScreenY(py, cy, s);
  const rad = (angle >>> 0) * Math.PI / 0x80000000;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  for (const [ax1, ay1, ax2, ay2] of ARROW_LINES) {
    const sx1 = scrX + Math.round((ax1 * cos - ay1 * sin) * arrowSize);
    const sy1 = scrY - Math.round((ax1 * sin + ay1 * cos) * arrowSize);
    const sx2 = scrX + Math.round((ax2 * cos - ay2 * sin) * arrowSize);
    const sy2 = scrY - Math.round((ax2 * sin + ay2 * cos) * arrowSize);
    drawLine(sx1, sy1, sx2, sy2, PLAYERCOLOR);
  }
}

// ---- Coordinate conversion (viewport-relative) ----

function toScreenX(mx: number, cx: number, s: number): number {
  return Math.round(vpX + vpW / 2 + ((mx - cx) / FRACUNIT) * s);
}

function toScreenY(my: number, cy: number, s: number): number {
  return Math.round(vpY + vpH / 2 - ((my - cy) / FRACUNIT) * s);
}

// ---- Scale computation ----

function computeScales(): void {
  if (!map || map.vertices.length === 0) return;

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const v of map.vertices) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }

  const mapWidth = (maxX - minX) / FRACUNIT;
  const mapHeight = (maxY - minY) / FRACUNIT;

  if (mapWidth > 0 && mapHeight > 0) {
    // Fullscreen scale
    const margin = 0.9;
    scale = Math.min(
      (SCREENWIDTH * margin) / mapWidth,
      (SCREENHEIGHT * margin) / mapHeight,
    );
    scale = Math.max(MIN_SCALE, Math.min(scale, MAX_SCALE));

    // Minimap scale — zoom in more so local area is visible
    const miniW = Math.round(SCREENWIDTH * MINI_FRAC_W);
    const miniH = Math.round(SCREENHEIGHT * MINI_FRAC_H);
    miniScale = Math.min(miniW, miniH) / 600; // ~600 map units visible
    miniScale = Math.max(MIN_SCALE, Math.min(miniScale, MAX_SCALE));
  }

  viewX = (minX + maxX) >> 1;
  viewY = (minY + maxY) >> 1;
}

// ---- Line color ----

function getLineColor(line: LineDef): number {
  if (line.flags & ML_DONTDRAW) {
    return revealLevel >= 1 ? TSWALLCOLOR : 0;
  }
  if (revealLevel < 1 && !(line.flags & ML_MAPPED)) {
    return 0;
  }
  if (!(line.flags & ML_TWOSIDED)) {
    return WALLCOLOR;
  }
  if (line.flags & ML_SECRET) {
    return SECRETCOLOR;
  }
  if (line.frontsector && line.backsector) {
    if (line.frontsector.floorHeight !== line.backsector.floorHeight) {
      return FDWALLCOLOR;
    }
    if (line.frontsector.ceilingHeight !== line.backsector.ceilingHeight) {
      return CDWALLCOLOR;
    }
  }
  if (revealLevel >= 1) return TSWALLCOLOR;
  return 0;
}

// ---- Primitives (viewport-clipped) ----

/** Write or blend a single pixel depending on blendMode */
function plotPixel(idx: number, color: number): void {
  if (!blendMode) {
    rgbaBuffer[idx] = color;
    return;
  }
  // Alpha-blend: lerp between existing pixel and color
  const a = MINI_LINE_ALPHA;
  const inv = 1 - a;
  const existing = rgbaBuffer[idx];
  const er = existing & 0xFF;
  const eg = (existing >> 8) & 0xFF;
  const eb = (existing >> 16) & 0xFF;
  const cr = color & 0xFF;
  const cg = (color >> 8) & 0xFF;
  const cb = (color >> 16) & 0xFF;
  const r = (cr * a + er * inv) | 0;
  const g = (cg * a + eg * inv) | 0;
  const b = (cb * a + eb * inv) | 0;
  rgbaBuffer[idx] = 0xFF000000 | (b << 16) | (g << 8) | r;
}

function drawLine(
  x0: number, y0: number, x1: number, y1: number, color: number,
): void {
  const clip = clipLine(x0, y0, x1, y1);
  if (!clip) return;
  [x0, y0, x1, y1] = clip;

  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  for (;;) {
    if (x0 >= vpX && x0 < vpX + vpW && y0 >= vpY && y0 < vpY + vpH) {
      plotPixel(y0 * SCREENWIDTH + x0, color);
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

function drawDot(sx: number, sy: number, color: number): void {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = sx + dx;
      const py = sy + dy;
      if (px >= vpX && px < vpX + vpW && py >= vpY && py < vpY + vpH) {
        plotPixel(py * SCREENWIDTH + px, color);
      }
    }
  }
}

function drawHLine(x: number, y: number, w: number, color: number): void {
  if (y < 0 || y >= SCREENHEIGHT) return;
  const row = y * SCREENWIDTH;
  const x2 = Math.min(x + w, SCREENWIDTH);
  for (let px = Math.max(x, 0); px < x2; px++) {
    rgbaBuffer[row + px] = color;
  }
}

function drawVLine(x: number, y: number, h: number, color: number): void {
  if (x < 0 || x >= SCREENWIDTH) return;
  const y2 = Math.min(y + h, SCREENHEIGHT);
  for (let py = Math.max(y, 0); py < y2; py++) {
    rgbaBuffer[py * SCREENWIDTH + x] = color;
  }
}

// ---- Cohen–Sutherland clipping (against current viewport) ----
const INSIDE = 0, LEFT = 1, RIGHT = 2, BOTTOM = 4, TOP = 8;

function outcode(x: number, y: number): number {
  let code = INSIDE;
  if (x < vpX) code |= LEFT;
  else if (x >= vpX + vpW) code |= RIGHT;
  if (y < vpY) code |= TOP;
  else if (y >= vpY + vpH) code |= BOTTOM;
  return code;
}

function clipLine(
  x0: number, y0: number, x1: number, y1: number,
): [number, number, number, number] | null {
  let oc0 = outcode(x0, y0);
  let oc1 = outcode(x1, y1);

  const xmin = vpX, ymin = vpY;
  const xmax = vpX + vpW - 1, ymax = vpY + vpH - 1;

  for (let i = 0; i < 20; i++) {
    if (!(oc0 | oc1)) return [x0, y0, x1, y1];
    if (oc0 & oc1) return null;

    const oc = oc0 || oc1;
    let x = 0, y = 0;
    if (oc & TOP) {
      x = x0 + ((x1 - x0) * (ymin - y0)) / (y1 - y0);
      y = ymin;
    } else if (oc & BOTTOM) {
      x = x0 + ((x1 - x0) * (ymax - y0)) / (y1 - y0);
      y = ymax;
    } else if (oc & RIGHT) {
      y = y0 + ((y1 - y0) * (xmax - x0)) / (x1 - x0);
      x = xmax;
    } else if (oc & LEFT) {
      y = y0 + ((y1 - y0) * (xmin - x0)) / (x1 - x0);
      x = xmin;
    }

    x = Math.round(x);
    y = Math.round(y);

    if (oc === oc0) {
      x0 = x; y0 = y;
      oc0 = outcode(x0, y0);
    } else {
      x1 = x; y1 = y;
      oc1 = outcode(x1, y1);
    }
  }
  return null;
}
