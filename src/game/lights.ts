// ============================================================
// Sector Light Effects
// Reference: p_lights.c — flicker, strobe, glow thinkers
// ============================================================

import { Sector, GameMap } from '../map';
import { addThinker, Thinker } from './thinkers';

// ---- Saved original sector state (for respawn) ----
let savedSectorSpecials: number[] = [];
let savedSectorLightLevels: number[] = [];

/** Save original sector state — call once at initial level load */
export function saveSectorState(map: GameMap): void {
  savedSectorSpecials = map.sectors.map(s => s.special);
  savedSectorLightLevels = map.sectors.map(s => s.lightLevel);
}

/** Restore original sector state — call before re-init on respawn */
export function restoreSectorState(map: GameMap): void {
  for (let i = 0; i < map.sectors.length; i++) {
    map.sectors[i].special = savedSectorSpecials[i] ?? map.sectors[i].special;
    map.sectors[i].lightLevel = savedSectorLightLevels[i] ?? map.sectors[i].lightLevel;
  }
}

// ---- Constants from p_spec.h ----
const GLOWSPEED    = 8;
const STROBEBRIGHT = 5;
const FASTDARK     = 15;
const SLOWDARK     = 35;

// ---- P_FindMinSurroundingLight ----
// Finds the minimum light level of all sectors neighboring `sector`
// via shared two-sided linedefs.
function findMinSurroundingLight(sector: Sector, max: number, map: GameMap): number {
  let min = max;
  for (const line of map.linedefs) {
    let neighbor: Sector | null = null;
    if (line.frontsector === sector && line.backsector) {
      neighbor = line.backsector;
    } else if (line.backsector === sector && line.frontsector) {
      neighbor = line.frontsector;
    }
    if (neighbor && neighbor.lightLevel < min) {
      min = neighbor.lightLevel;
    }
  }
  return min;
}

// Simple DOOM-compatible P_Random (0–255)
function pRandom(): number {
  return (Math.random() * 256) | 0;
}

// ===========================================================
// 1) Fire Flicker (sector special 17)
// ===========================================================
// Random flicker: every 4 tics, lightlevel = maxlight - random(0..48)
// clamped to minlight.

export interface FireFlickerThinker extends Thinker {
  sector: Sector;
  maxlight: number;
  minlight: number;
  count: number;
}

function T_FireFlicker(t: Thinker): void {
  const flick = t as FireFlickerThinker;
  if (--flick.count > 0) return;

  const amount = (pRandom() & 3) * 16;

  if (flick.sector.lightLevel - amount < flick.minlight) {
    flick.sector.lightLevel = flick.minlight;
  } else {
    flick.sector.lightLevel = flick.maxlight - amount;
  }

  flick.count = 4;
}

function spawnFireFlicker(sector: Sector, map: GameMap): void {
  const maxlight = sector.lightLevel;
  const minlight = findMinSurroundingLight(sector, sector.lightLevel, map) + 16;

  sector.special = 0;

  const flick: FireFlickerThinker = {
    action: T_FireFlicker,
    removed: false,
    sector,
    maxlight,
    minlight,
    count: 4,
  };
  addThinker(flick);
}

// ===========================================================
// 2) Broken Light Flash (sector special 1)
// ===========================================================
// Random on/off: bright for random(0..63)+1 tics, dark for
// random(0..7)+1 tics.

export interface LightFlashThinker extends Thinker {
  sector: Sector;
  maxlight: number;
  minlight: number;
  maxtime: number;
  mintime: number;
  count: number;
}

function T_LightFlash(t: Thinker): void {
  const flash = t as LightFlashThinker;
  if (--flash.count > 0) return;

  if (flash.sector.lightLevel === flash.maxlight) {
    flash.sector.lightLevel = flash.minlight;
    flash.count = (pRandom() & flash.mintime) + 1;
  } else {
    flash.sector.lightLevel = flash.maxlight;
    flash.count = (pRandom() & flash.maxtime) + 1;
  }
}

function spawnLightFlash(sector: Sector, map: GameMap): void {
  const maxlight = sector.lightLevel;
  const minlight = findMinSurroundingLight(sector, sector.lightLevel, map);

  sector.special = 0;

  const flash: LightFlashThinker = {
    action: T_LightFlash,
    removed: false,
    sector,
    maxlight,
    minlight,
    maxtime: 64,
    mintime: 7,
    count: (pRandom() & 64) + 1,
  };
  addThinker(flash);
}

// ===========================================================
// 3) Strobe Flash (sector specials 2, 3, 4, 12, 13)
// ===========================================================
// Regular on/off: bright for STROBEBRIGHT tics, dark for
// fastOrSlow tics. If inSync, all start at same time.

export interface StrobeFlashThinker extends Thinker {
  sector: Sector;
  maxlight: number;
  minlight: number;
  darktime: number;
  brighttime: number;
  count: number;
}

function T_StrobeFlash(t: Thinker): void {
  const flash = t as StrobeFlashThinker;
  if (--flash.count > 0) return;

  if (flash.sector.lightLevel === flash.minlight) {
    flash.sector.lightLevel = flash.maxlight;
    flash.count = flash.brighttime;
  } else {
    flash.sector.lightLevel = flash.minlight;
    flash.count = flash.darktime;
  }
}

function spawnStrobeFlash(sector: Sector, map: GameMap, fastOrSlow: number, inSync: boolean): void {
  const maxlight = sector.lightLevel;
  let minlight = findMinSurroundingLight(sector, sector.lightLevel, map);

  if (minlight === maxlight) {
    minlight = 0;
  }

  sector.special = 0;

  const flash: StrobeFlashThinker = {
    action: T_StrobeFlash,
    removed: false,
    sector,
    maxlight,
    minlight,
    darktime: fastOrSlow,
    brighttime: STROBEBRIGHT,
    count: inSync ? 1 : (pRandom() & 7) + 1,
  };
  addThinker(flash);
}

// ===========================================================
// 4) Glowing Light (sector special 8)
// ===========================================================
// Smooth oscillation between maxlight and minlight.

export interface GlowThinker extends Thinker {
  sector: Sector;
  maxlight: number;
  minlight: number;
  direction: number; // -1 = dimming, 1 = brightening
}

function T_Glow(t: Thinker): void {
  const g = t as GlowThinker;

  switch (g.direction) {
    case -1:
      // dimming
      g.sector.lightLevel -= GLOWSPEED;
      if (g.sector.lightLevel <= g.minlight) {
        g.sector.lightLevel += GLOWSPEED;
        g.direction = 1;
      }
      break;

    case 1:
      // brightening
      g.sector.lightLevel += GLOWSPEED;
      if (g.sector.lightLevel >= g.maxlight) {
        g.sector.lightLevel -= GLOWSPEED;
        g.direction = -1;
      }
      break;
  }
}

function spawnGlowingLight(sector: Sector, map: GameMap): void {
  const maxlight = sector.lightLevel;
  const minlight = findMinSurroundingLight(sector, sector.lightLevel, map);

  sector.special = 0;

  const g: GlowThinker = {
    action: T_Glow,
    removed: false,
    sector,
    maxlight,
    minlight,
    direction: -1,
  };
  addThinker(g);
}

// ===========================================================
// P_SpawnSpecials — light portion
// ===========================================================
// Called at level load. Scans all sectors for light specials
// and spawns the appropriate thinkers.

export function spawnSectorLights(map: GameMap): void {
  let count = 0;
  for (const sector of map.sectors) {
    if (!sector.special) continue;

    switch (sector.special) {
      case 1:
        // FLICKERING LIGHTS
        spawnLightFlash(sector, map);
        count++;
        break;

      case 2:
        // STROBE FAST
        spawnStrobeFlash(sector, map, FASTDARK, false);
        count++;
        break;

      case 3:
        // STROBE SLOW
        spawnStrobeFlash(sector, map, SLOWDARK, false);
        count++;
        break;

      case 4:
        // STROBE FAST / DEATH SLIME
        spawnStrobeFlash(sector, map, FASTDARK, false);
        sector.special = 4; // restore for damage logic
        count++;
        break;

      case 8:
        // GLOWING LIGHT
        spawnGlowingLight(sector, map);
        count++;
        break;

      case 12:
        // SYNC STROBE SLOW
        spawnStrobeFlash(sector, map, SLOWDARK, true);
        count++;
        break;

      case 13:
        // SYNC STROBE FAST
        spawnStrobeFlash(sector, map, FASTDARK, true);
        count++;
        break;

      case 17:
        // FIRE FLICKER
        spawnFireFlicker(sector, map);
        count++;
        break;
    }
  }

  console.log(`[lights] ${count} sector light effects spawned`);
}

// ===========================================================
// Linedef-triggered light events
// Reference: p_lights.c EV_LightTurnOn, EV_TurnTagLightsOff,
//            EV_StartLightStrobing
// ===========================================================

/**
 * EV_LightTurnOn — set light level for sectors matching line tag.
 * If bright > 0: set to bright.
 * If bright === 0: search for highest neighbor light level.
 */
export function evLightTurnOn(tag: number, bright: number, map: GameMap): void {
  for (const sector of map.sectors) {
    if (sector.tag !== tag) continue;

    if (!bright) {
      // Search for highest light level in surrounding sectors
      let maxLight = 0;
      for (const line of map.linedefs) {
        let neighbor: Sector | null = null;
        if (line.frontsector === sector && line.backsector) {
          neighbor = line.backsector;
        } else if (line.backsector === sector && line.frontsector) {
          neighbor = line.frontsector;
        }
        if (neighbor && neighbor.lightLevel > maxLight) {
          maxLight = neighbor.lightLevel;
        }
      }
      sector.lightLevel = maxLight;
    } else {
      sector.lightLevel = bright;
    }
  }
}

/**
 * EV_TurnTagLightsOff — set each tagged sector's light to
 * the minimum light of its neighbors.
 */
export function evTurnTagLightsOff(tag: number, map: GameMap): void {
  for (const sector of map.sectors) {
    if (sector.tag !== tag) continue;

    let min = sector.lightLevel;
    for (const line of map.linedefs) {
      let neighbor: Sector | null = null;
      if (line.frontsector === sector && line.backsector) {
        neighbor = line.backsector;
      } else if (line.backsector === sector && line.frontsector) {
        neighbor = line.frontsector;
      }
      if (neighbor && neighbor.lightLevel < min) {
        min = neighbor.lightLevel;
      }
    }
    sector.lightLevel = min;
  }
}

/**
 * EV_StartLightStrobing — spawn strobe flash in tagged sectors.
 * Triggered by linedef special 17.
 */
export function evStartLightStrobing(tag: number, map: GameMap): void {
  for (const sector of map.sectors) {
    if (sector.tag !== tag) continue;
    // Don't spawn if sector already has a special thinker
    // (we skip this check as original uses specialdata, we don't track that for lights)
    spawnStrobeFlash(sector, map, SLOWDARK, false);
  }
}

// ===========================================================
// Save/Load helpers for light thinkers
// ===========================================================

export function restoreFireFlicker(sector: Sector, maxlight: number, minlight: number, count: number): void {
  const flick: FireFlickerThinker = { action: T_FireFlicker, removed: false, sector, maxlight, minlight, count };
  addThinker(flick);
}

export function restoreLightFlash(sector: Sector, maxlight: number, minlight: number, count: number): void {
  const flash: LightFlashThinker = { action: T_LightFlash, removed: false, sector, maxlight, minlight, maxtime: 64, mintime: 7, count };
  addThinker(flash);
}

export function restoreStrobeFlash(sector: Sector, maxlight: number, minlight: number, darktime: number, brighttime: number, count: number): void {
  const flash: StrobeFlashThinker = { action: T_StrobeFlash, removed: false, sector, maxlight, minlight, darktime, brighttime, count };
  addThinker(flash);
}

export function restoreGlow(sector: Sector, maxlight: number, minlight: number, direction: number): void {
  const g: GlowThinker = { action: T_Glow, removed: false, sector, maxlight, minlight, direction };
  addThinker(g);
}

