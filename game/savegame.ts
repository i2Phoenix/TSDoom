// ============================================================
// Save/Load Game System
// Reference: p_saveg.c, g_game.c (G_DoSaveGame, G_DoLoadGame)
// ============================================================

import type { GameMap, Sector } from './map-types';
import { FRACBITS } from './math';
import { Player, PlayerState } from './player';
import { WeaponType, StateNum, getWeaponState, createPspDef } from './weapons';
import { getLevelTime, getThinkersList, setLevelTime, clearThinkers, Thinker } from './thinkers';
import { getRemovedThings, setRemovedThings } from './pickups';
import { getMapObjects, setMapObjects, getDroppedItems, setDroppedItems, MapObjState, DroppedItem } from './mobj';
import { getThingAnimStates, setThingAnimStates, ThingAnimState, MobjLifecycle } from './animations';
import { GameInstance } from './game-instance';
import {
  DoorType, PlatType, PlatStatus, FloorType,
  DoorThinker, PlatThinker, FloorThinker,
  getSectorSpecialData, clearSpecialsState,
  restoreDoorThinker, restorePlatThinker, restoreFloorThinker,
} from './specials';
import {
  FireFlickerThinker, LightFlashThinker, StrobeFlashThinker, GlowThinker,
  restoreFireFlicker, restoreLightFlash, restoreStrobeFlash, restoreGlow,
} from './lights';
import { SkillLevel, setGameSkill } from './skill';

// ============================================================
// GameSaveData — JSON-friendly save format
// ============================================================

/** Serializable psprite state */
interface SavedPsprite {
  stateNum: number;
  tics: number;
  sx: number;
  sy: number;
}

/** Serializable player state */
interface SavedPlayer {
  x: number; y: number; z: number;
  angle: number;
  viewz: number;
  viewheight: number;
  deltaviewheight: number;
  bob: number;
  health: number;
  armor: number;
  armortype: number;
  powers: number[];
  keys: boolean[];
  readyweapon: number;
  pendingweapon: number;
  weaponowned: boolean[];
  ammo: number[];
  maxammo: number[];
  attackdown: boolean;
  refire: number;
  damagecount: number;
  bonuscount: number;
  playerstate: number;
  psprites: SavedPsprite[];
}

/** Serializable sector delta */
interface SavedSector {
  floorHeight: number;
  ceilingHeight: number;
  lightLevel: number;
  special: number;
}

/** Serializable linedef delta */
interface SavedLine {
  flags: number;
  special: number;
}

/** Serializable sidedef textures */
interface SavedSide {
  topTexture: number;
  midTexture: number;
  bottomTexture: number;
}

/** Thinker type tags for serialization */
type ThinkerTag = 'door' | 'plat' | 'floor' | 'fireflicker' | 'lightflash' | 'strobe' | 'glow';

/** Serializable thinker */
interface SavedThinker {
  tag: ThinkerTag;
  sectorIndex: number;
  data: Record<string, unknown>;
}

/** Serializable thing anim state */
interface SavedThingAnim {
  thingIndex: number;
  thingType: number;
  stateIdx: number;
  tics: number;
  sprite: string;
  frame: number;
  mobjState: MobjLifecycle;
}

/** Root save data structure */
export interface GameSaveData {
  version: number;
  mapName: string;
  description: string;
  timestamp: number;
  levelTime: number;
  prndIndex: number;
  gameskill: SkillLevel;
  player: SavedPlayer;
  sectors: SavedSector[];
  lines: SavedLine[];
  sides: SavedSide[][];   // sides[lineIndex] = [front, back?]
  thinkers: SavedThinker[];
  removedThings: number[];
  mapObjects: MapObjState[];
  droppedItems: DroppedItem[];
  thingAnims: SavedThingAnim[];
}

const SAVE_VERSION = 1;
const STORAGE_PREFIX = 'tsdoom_save_';
const QUICKSAVE_KEY = 'tsdoom_quicksave';

// ============================================================
// captureGameState — snapshot current state
// ============================================================

export function captureGameState(
  player: Player,
  map: GameMap,
  description: string,
  gi: GameInstance
): GameSaveData {
  // Player
  const savedPlayer: SavedPlayer = {
    x: player.x, y: player.y, z: player.z,
    angle: player.angle,
    viewz: player.viewz,
    viewheight: player.viewheight,
    deltaviewheight: player.deltaviewheight,
    bob: player.bob,
    health: player.health,
    armor: player.armor,
    armortype: player.armortype,
    powers: [...player.powers],
    keys: [...player.keys],
    readyweapon: player.readyweapon,
    pendingweapon: player.pendingweapon,
    weaponowned: [...player.weaponowned],
    ammo: [...player.ammo],
    maxammo: [...player.maxammo],
    attackdown: player.attackdown,
    refire: player.refire,
    damagecount: player.damagecount,
    bonuscount: player.bonuscount,
    playerstate: player.playerstate,
    psprites: player.psprites.map(p => ({
      stateNum: p.stateNum ?? StateNum.S_NULL,
      tics: p.tics,
      sx: p.sx,
      sy: p.sy,
    })),
  };

  // Sectors
  const sectors: SavedSector[] = map.sectors.map(s => ({
    floorHeight: s.floorHeight,
    ceilingHeight: s.ceilingHeight,
    lightLevel: s.lightLevel,
    special: s.special,
  }));

  // Lines and sides
  const lines: SavedLine[] = [];
  const sides: SavedSide[][] = [];
  for (const ld of map.linedefs) {
    lines.push({ flags: ld.flags, special: ld.special });
    const sideArr: SavedSide[] = [];
    if (ld.sidenum[0] !== -1) {
      const sd = map.sidedefs[ld.sidenum[0]];
      sideArr.push({
        topTexture: sd.topTexture,
        midTexture: sd.midTexture,
        bottomTexture: sd.bottomTexture,
      });
    }
    if (ld.sidenum[1] !== -1) {
      const sd = map.sidedefs[ld.sidenum[1]];
      sideArr.push({
        topTexture: sd.topTexture,
        midTexture: sd.midTexture,
        bottomTexture: sd.bottomTexture,
      });
    }
    sides.push(sideArr);
  }

  // Thinkers (specials)
  const thinkerList = getThinkersList(gi);
  const savedThinkers: SavedThinker[] = [];
  for (const t of thinkerList) {
    if (t.removed) continue;
    const st = serializeThinker(t, map);
    if (st) savedThinkers.push(st);
  }

  // Thing anims
  const thingAnims: SavedThingAnim[] = [];
  for (const [idx, anim] of getThingAnimStates()) {
    thingAnims.push({
      thingIndex: idx,
      thingType: anim.thingType,
      stateIdx: anim.stateIdx,
      tics: anim.tics,
      sprite: anim.sprite,
      frame: anim.frame,
      mobjState: anim.mobjState,
    });
  }

  return {
    version: SAVE_VERSION,
    mapName: map.name,
    description,
    timestamp: Date.now(),
    levelTime: getLevelTime(gi),
    prndIndex: gi.prndindex,
    gameskill: gi.gameskill,
    player: savedPlayer,
    sectors,
    lines,
    sides,
    thinkers: savedThinkers,
    removedThings: Array.from(getRemovedThings(gi)),
    mapObjects: getMapObjects(gi).map(o => ({ ...o })),
    droppedItems: [...getDroppedItems(gi)],
    thingAnims,
  };
}

// ============================================================
// Thinker serialization
// ============================================================

function sectorIndex(sector: Sector, map: GameMap): number {
  return map.sectors.indexOf(sector);
}

function serializeThinker(t: Thinker, map: GameMap): SavedThinker | null {
  // Door
  if ('topheight' in t && 'topcountdown' in t && 'sector' in t) {
    const d = t as DoorThinker;
    return {
      tag: 'door', sectorIndex: sectorIndex(d.sector, map),
      data: { type: d.type, topheight: d.topheight, speed: d.speed, direction: d.direction, topwait: d.topwait, topcountdown: d.topcountdown },
    };
  }
  // Plat
  if ('low' in t && 'high' in t && 'status' in t && 'tag' in t && 'sector' in t) {
    const p = t as PlatThinker;
    return {
      tag: 'plat', sectorIndex: sectorIndex(p.sector, map),
      data: { type: p.type, speed: p.speed, low: p.low, high: p.high, wait: p.wait, count: p.count, status: p.status, oldstatus: p.oldstatus, crush: p.crush, tag: p.tag },
    };
  }
  // Floor
  if ('floordestheight' in t && 'crush' in t && 'direction' in t && 'sector' in t) {
    const f = t as FloorThinker;
    return {
      tag: 'floor', sectorIndex: sectorIndex(f.sector, map),
      data: { type: f.type, speed: f.speed, floordestheight: f.floordestheight, crush: f.crush, direction: f.direction },
    };
  }
  // Light thinkers
  if ('maxlight' in t && 'minlight' in t && 'sector' in t) {
    const lt = t as { sector: Sector; maxlight: number; minlight: number; count?: number; darktime?: number; brighttime?: number; direction?: number };
    const si = sectorIndex(lt.sector, map);
    if ('darktime' in lt && 'brighttime' in lt) {
      const s = t as StrobeFlashThinker;
      return { tag: 'strobe', sectorIndex: si, data: { maxlight: s.maxlight, minlight: s.minlight, darktime: s.darktime, brighttime: s.brighttime, count: s.count } };
    }
    if ('direction' in lt && !('count' in lt)) {
      const g = t as GlowThinker;
      return { tag: 'glow', sectorIndex: si, data: { maxlight: g.maxlight, minlight: g.minlight, direction: g.direction } };
    }
    if ('maxtime' in t) {
      const lf = t as LightFlashThinker;
      return { tag: 'lightflash', sectorIndex: si, data: { maxlight: lf.maxlight, minlight: lf.minlight, count: lf.count } };
    }
    // FireFlicker has count but no darktime/maxtime
    if ('count' in lt) {
      const ff = t as FireFlickerThinker;
      return { tag: 'fireflicker', sectorIndex: si, data: { maxlight: ff.maxlight, minlight: ff.minlight, count: ff.count } };
    }
  }
  return null;
}

// ============================================================
// applyGameState — restore state onto map + player
// ============================================================

export function applyGameState(
  data: GameSaveData,
  player: Player,
  map: GameMap,
  gi: GameInstance
): void {
  // Player
  const p = data.player;
  player.x = p.x; player.y = p.y; player.z = p.z;
  player.angle = p.angle;
  player.viewz = p.viewz;
  player.viewheight = p.viewheight;
  player.deltaviewheight = p.deltaviewheight;
  player.bob = p.bob;
  player.health = p.health;
  player.armor = p.armor;
  player.armortype = p.armortype;
  player.powers = [...p.powers];
  player.keys = [...p.keys];
  player.readyweapon = p.readyweapon as WeaponType;
  player.pendingweapon = p.pendingweapon as WeaponType;
  player.weaponowned = [...p.weaponowned];
  player.ammo = [...p.ammo];
  player.maxammo = [...p.maxammo];
  player.attackdown = p.attackdown;
  player.refire = p.refire;
  player.damagecount = p.damagecount;
  player.bonuscount = p.bonuscount;
  player.playerstate = p.playerstate as PlayerState;
  // Restore psprites — tics/sx/sy/stateNum + resolve state object from stateNum
  if (p.psprites) {
    // Ensure psprites array has enough slots (on cold load, it may be empty)
    while (player.psprites.length < p.psprites.length) {
      player.psprites.push(createPspDef());
    }
    for (let i = 0; i < p.psprites.length && i < player.psprites.length; i++) {
      player.psprites[i].tics = p.psprites[i].tics;
      player.psprites[i].sx = p.psprites[i].sx;
      player.psprites[i].sy = p.psprites[i].sy;
      const sn = p.psprites[i].stateNum as StateNum;
      player.psprites[i].stateNum = sn;
      // Resolve the state object from stateNum (critical — without this,
      // getPspriteInfo crashes because psp.state is null)
      player.psprites[i].state = sn !== StateNum.S_NULL ? getWeaponState(sn) : null;
    }
  }

  // Sectors
  for (let i = 0; i < data.sectors.length && i < map.sectors.length; i++) {
    const s = data.sectors[i];
    map.sectors[i].floorHeight = s.floorHeight;
    map.sectors[i].ceilingHeight = s.ceilingHeight;
    map.sectors[i].lightLevel = s.lightLevel;
    map.sectors[i].special = s.special;
  }

  // Lines & sides
  for (let i = 0; i < data.lines.length && i < map.linedefs.length; i++) {
    map.linedefs[i].flags = data.lines[i].flags;
    map.linedefs[i].special = data.lines[i].special;
    const sArr = data.sides[i];
    const ld = map.linedefs[i];
    if (sArr && sArr[0] && ld.sidenum[0] !== -1) {
      const sd = map.sidedefs[ld.sidenum[0]];
      sd.topTexture = sArr[0].topTexture;
      sd.midTexture = sArr[0].midTexture;
      sd.bottomTexture = sArr[0].bottomTexture;
    }
    if (sArr && sArr[1] && ld.sidenum[1] !== -1) {
      const sd = map.sidedefs[ld.sidenum[1]];
      sd.topTexture = sArr[1].topTexture;
      sd.midTexture = sArr[1].midTexture;
      sd.bottomTexture = sArr[1].bottomTexture;
    }
  }

  // Clear existing thinkers and specials state, then restore
  clearThinkers(gi);
  clearSpecialsState(gi);

  for (const st of data.thinkers) {
    const sector = map.sectors[st.sectorIndex];
    if (!sector) continue;
    const d = st.data;
    switch (st.tag) {
      case 'door':
        restoreDoorThinker(sector, d.type as DoorType, d.topheight as number, d.speed as number, d.direction as number, d.topwait as number, d.topcountdown as number, gi);
        break;
      case 'plat':
        restorePlatThinker(sector, d.type as PlatType, d.speed as number, d.low as number, d.high as number, d.wait as number, d.count as number, d.status as PlatStatus, d.oldstatus as PlatStatus, d.crush as boolean, d.tag as number, gi);
        break;
      case 'floor':
        restoreFloorThinker(sector, d.type as FloorType, d.speed as number, d.floordestheight as number, d.crush as boolean, d.direction as number, gi);
        break;
      case 'fireflicker':
        restoreFireFlicker(sector, d.maxlight as number, d.minlight as number, d.count as number, gi);
        break;
      case 'lightflash':
        restoreLightFlash(sector, d.maxlight as number, d.minlight as number, d.count as number, gi);
        break;
      case 'strobe':
        restoreStrobeFlash(sector, d.maxlight as number, d.minlight as number, d.darktime as number, d.brighttime as number, d.count as number, gi);
        break;
      case 'glow':
        restoreGlow(sector, d.maxlight as number, d.minlight as number, d.direction as number, gi);
        break;
    }
  }

  // Map objects
  setMapObjects(data.mapObjects.map(o => ({ ...o })), gi);
  setDroppedItems([...data.droppedItems], gi);

  // Removed things
  setRemovedThings(data.removedThings, gi);

  // Thing animations
  const animMap = new Map<number, ThingAnimState>();
  for (const a of data.thingAnims) {
    animMap.set(a.thingIndex, {
      thingType: a.thingType,
      stateIdx: a.stateIdx,
      tics: a.tics,
      sprite: a.sprite,
      frame: a.frame,
      mobjState: a.mobjState,
    });
  }
  setThingAnimStates(animMap);

  // Timing & random
  setLevelTime(data.levelTime, gi);
  gi.prndindex = data.prndIndex & 0xff;

  // Skill level
  if (data.gameskill !== undefined) {
    setGameSkill(data.gameskill, gi);
  }

  console.log(`[savegame] State applied: map=${data.mapName} skill=${data.gameskill ?? '?'} levelTime=${data.levelTime}`);
}

// ============================================================
// localStorage save/load
// ============================================================

function slotKey(slot: number): string {
  return slot === -1 ? QUICKSAVE_KEY : `${STORAGE_PREFIX}${slot}`;
}

export function saveToSlot(slot: number, data: GameSaveData): boolean {
  try {
    const json = JSON.stringify(data);
    localStorage.setItem(slotKey(slot), json);
    console.log(`[savegame] Saved to slot ${slot} (${(json.length / 1024).toFixed(1)} KB)`);
    return true;
  } catch (e) {
    console.error('[savegame] Save failed:', e);
    return false;
  }
}

export function loadFromSlot(slot: number): GameSaveData | null {
  try {
    const json = localStorage.getItem(slotKey(slot));
    if (!json) return null;
    const data = JSON.parse(json) as GameSaveData;
    if (data.version !== SAVE_VERSION) {
      console.warn(`[savegame] Version mismatch: save=${data.version} current=${SAVE_VERSION}`);
    }
    return data;
  } catch (e) {
    console.error('[savegame] Load failed:', e);
    return null;
  }
}

export interface SlotInfo {
  description: string;
  mapName: string;
  timestamp: number;
}

export function getSlotInfo(slot: number): SlotInfo | null {
  try {
    const json = localStorage.getItem(slotKey(slot));
    if (!json) return null;
    const data = JSON.parse(json) as GameSaveData;
    return {
      description: data.description,
      mapName: data.mapName,
      timestamp: data.timestamp,
    };
  } catch {
    return null;
  }
}

/** Get info for all 6 slots + quicksave */
export function getAllSlotInfo(): (SlotInfo | null)[] {
  const result: (SlotInfo | null)[] = [];
  for (let i = 0; i < 6; i++) result.push(getSlotInfo(i));
  return result;
}

