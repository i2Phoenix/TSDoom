// ============================================================
// Animation Systems
// Reference: p_spec.c (flat/texture anims), info.c (sprite states)
// ============================================================

import { levelTime } from './thinkers';
import { FRACUNIT } from './math';
import type { SideDef, LineDef } from './map-types';

// ===========================================================
// 1) Flat / Wall Texture Animations (P_UpdateSpecials)
// ===========================================================
// DOOM defines animation sequences as first→last flat/texture name pairs.
// Each tick, the engine cycles the displayed texture for all flats/textures
// in the sequence. The animation rate is 8 tics per frame.

const ANIM_SPEED = 8; // tics per frame (DOOM default)

interface AnimDef {
  isTexture: boolean;       // false = flat, true = wall texture
  lastName: string;         // last frame name
  firstName: string;        // first frame name
  speed: number;            // tics per frame
}

// From p_spec.c animdefs[] — DOOM1 animation definitions
const ANIMDEFS: AnimDef[] = [
  // Flats
  { isTexture: false, lastName: 'NUKAGE3', firstName: 'NUKAGE1', speed: ANIM_SPEED },
  { isTexture: false, lastName: 'FWATER4', firstName: 'FWATER1', speed: ANIM_SPEED },
  { isTexture: false, lastName: 'SWATER4', firstName: 'SWATER1', speed: ANIM_SPEED },
  { isTexture: false, lastName: 'LAVA4', firstName: 'LAVA1', speed: ANIM_SPEED },
  { isTexture: false, lastName: 'BLOOD3', firstName: 'BLOOD1', speed: ANIM_SPEED },
  { isTexture: false, lastName: 'RROCK08', firstName: 'RROCK05', speed: ANIM_SPEED },
  { isTexture: false, lastName: 'SLIME04', firstName: 'SLIME01', speed: ANIM_SPEED },
  { isTexture: false, lastName: 'SLIME08', firstName: 'SLIME05', speed: ANIM_SPEED },
  { isTexture: false, lastName: 'SLIME12', firstName: 'SLIME09', speed: ANIM_SPEED },

  // Wall textures
  { isTexture: true, lastName: 'BLODGR4', firstName: 'BLODGR1', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'SLADRIP3', firstName: 'SLADRIP1', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'BLODRIP4', firstName: 'BLODRIP1', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'FIREWALL', firstName: 'FIREWALA', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'GSTFONT3', firstName: 'GSTFONT1', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'FIRELAVA', firstName: 'FIRELAV3', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'FIREMAG3', firstName: 'FIREMAG1', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'FIREBLU2', firstName: 'FIREBLU1', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'ROCKRED3', firstName: 'ROCKRED1', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'BFALL4', firstName: 'BFALL1', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'SFALL4', firstName: 'SFALL1', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'WFALL4', firstName: 'WFALL1', speed: ANIM_SPEED },
  { isTexture: true, lastName: 'DBRAIN4', firstName: 'DBRAIN1', speed: ANIM_SPEED },
];

/** Resolved animation: indices into flatList or texture array */
interface AnimSequence {
  isTexture: boolean;
  basePic: number;          // index of first frame
  numFrames: number;        // total frames in sequence
  speed: number;
}

let animSequences: AnimSequence[] = [];

// Translation tables: original picnum → current animated picnum
// Indexed by original flat/texture index, value is the current display index
let flatTranslation: number[] = [];
let textureTranslation: number[] = [];

// Scrolling wall lines (linedef special 48)
let scrollLines: SideDef[] = [];

/**
 * Initialize animation sequences.
 * Call after textures/flats are loaded.
 */
export function initAnimations(
  flatNumForName: (name: string) => number,
  textureNumForName: (name: string) => number,
  flatCount: number,
  textureCount: number
): void {
  animSequences = [];

  // Build identity translation tables
  flatTranslation = [];
  for (let i = 0; i < flatCount; i++) flatTranslation[i] = i;
  textureTranslation = [];
  for (let i = 0; i < textureCount; i++) textureTranslation[i] = i;

  for (const def of ANIMDEFS) {
    const lookup = def.isTexture ? textureNumForName : flatNumForName;
    const firstPic = lookup(def.firstName);
    const lastPic = lookup(def.lastName);
    if (firstPic < 0 || lastPic < 0 || lastPic < firstPic) continue;

    animSequences.push({
      isTexture: def.isTexture,
      basePic: firstPic,
      numFrames: lastPic - firstPic + 1,
      speed: def.speed,
    });
  }

  console.log(`[anims] ${animSequences.length} animation sequences initialized`);
}

/**
 * Update animation translations each tick (called from game loop).
 * Mirrors P_UpdateSpecials from p_spec.c.
 */
export function updateAnimations(): void {
  for (const anim of animSequences) {
    const frameIdx = Math.floor(levelTime / anim.speed) % anim.numFrames;
    const currentPic = anim.basePic + frameIdx;
    const table = anim.isTexture ? textureTranslation : flatTranslation;
    // Update ALL frames in this sequence to point to the current frame
    for (let i = 0; i < anim.numFrames; i++) {
      table[anim.basePic + i] = currentPic;
    }
  }
  updateScrollLines();
}

/**
 * Initialize scrolling line specials.
 * Collects all linedefs with special 48 (Scroll Texture Left).
 * Call after map is loaded.
 */
export function initScrollLines(linedefs: LineDef[], sidedefs: SideDef[]): void {
  scrollLines = [];
  for (const line of linedefs) {
    if (line.special === 48 && line.sidenum[0] >= 0) {
      const side = sidedefs[line.sidenum[0]];
      if (side) scrollLines.push(side);
    }
  }
  if (scrollLines.length > 0) {
    console.log(`[anims] ${scrollLines.length} scrolling wall lines`);
  }
}

/** Get the current animated flat index for an original flat picnum */
export function getAnimatedFlat(picnum: number): number {
  return flatTranslation[picnum] ?? picnum;
}

/** Get the current animated texture index for an original texture picnum */
export function getAnimatedTexture(picnum: number): number {
  return textureTranslation[picnum] ?? picnum;
}

/**
 * Update scrolling line textures each tick.
 * Original DOOM: sides[line->sidenum[0]].textureoffset += FRACUNIT;
 */
function updateScrollLines(): void {
  for (let i = 0; i < scrollLines.length; i++) {
    scrollLines[i].textureOffset += FRACUNIT;
  }
}


// ===========================================================
// 2) Sprite / Thing State Machine Animations
// ===========================================================
// DOOM things have states defined in info.c. Each state has:
// - sprite name, frame, duration (tics), next state
// Things cycle through states on each tick.

export interface ThingState {
  sprite: string;
  frame: number;
  tics: number;       // -1 = infinite (no cycling)
  nextState: number;  // index into stateList for this thing type
  action?: string;    // action function name (e.g. 'A_Look', 'A_Chase', 'A_PosAttack')
}

/** Per-thing-type animation definition: array of states */
export interface ThingAnimDef {
  states: ThingState[];
  spawnState: number;    // index of initial state
  painState?: number;    // index of pain state (monsters only)
  deathState?: number;   // index of death state (monsters only)
  xdeathState?: number;  // index of gib/extreme death state
  seeState?: number;     // index of walk/chase state (monsters only)
  meleeState?: number;   // index of melee attack state
  missileState?: number; // index of ranged attack state
  painChance?: number;   // 0-255, probability of entering pain on hit
  dropItem?: number;     // thing type to drop on death (0 = none)
  // Monster sounds (from mobjinfo[], Sfx enum values)
  seeSound?: number[];   // array for random selection on wake-up
  painSound?: number;    // pain sound
  deathSound?: number[]; // array for random selection on death
  activeSound?: number;  // random idle noise during A_Chase
  attackSound?: number;  // melee attack sound (played when entering meleeState)
}

// Animation definitions for thing types that have cycling animations.
// Extracted from DOOM's info.c mobjinfo[] and states[].
// Only includes things with multiple frames (animated decorations, pickups, etc.)
const THING_ANIM_DEFS: Record<number, ThingAnimDef> = {
  // ============================================================
  // Monsters (from DOOM info.c / mobjinfo[])
  // States: spawn → see → melee → missile → pain → death → xdeath
  // Action callbacks: A_Look (idle), A_Chase (walk), A_FaceTarget, A_*Attack
  // ============================================================

  // Zombieman (MT_POSSESSED) — drops clip
  3004: {
    states: [
      // 0-1: spawn (idle) — A_Look each tick
      { sprite: 'POSS', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'POSS', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'POSS', frame: 6, tics: 3, nextState: 3 },
      { sprite: 'POSS', frame: 6, tics: 3, nextState: 18 },  // pain → seeState
      // 4-8: death
      { sprite: 'POSS', frame: 7, tics: 5, nextState: 5 },
      { sprite: 'POSS', frame: 8, tics: 5, nextState: 6 },
      { sprite: 'POSS', frame: 9, tics: 5, nextState: 7 },
      { sprite: 'POSS', frame: 10, tics: 5, nextState: 8 },
      { sprite: 'POSS', frame: 11, tics: -1, nextState: 8 },
      // 9-17: xdeath
      { sprite: 'POSS', frame: 12, tics: 5, nextState: 10 },
      { sprite: 'POSS', frame: 13, tics: 5, nextState: 11 },
      { sprite: 'POSS', frame: 14, tics: 5, nextState: 12 },
      { sprite: 'POSS', frame: 15, tics: 5, nextState: 13 },
      { sprite: 'POSS', frame: 16, tics: 5, nextState: 14 },
      { sprite: 'POSS', frame: 17, tics: 5, nextState: 15 },
      { sprite: 'POSS', frame: 18, tics: 5, nextState: 16 },
      { sprite: 'POSS', frame: 19, tics: 5, nextState: 17 },
      { sprite: 'POSS', frame: 20, tics: -1, nextState: 17 },
      // 18-21: see (walk cycle) — A_Chase
      { sprite: 'POSS', frame: 0, tics: 4, nextState: 19, action: 'A_Chase' },
      { sprite: 'POSS', frame: 1, tics: 4, nextState: 20, action: 'A_Chase' },
      { sprite: 'POSS', frame: 2, tics: 4, nextState: 21, action: 'A_Chase' },
      { sprite: 'POSS', frame: 3, tics: 4, nextState: 18, action: 'A_Chase' },
      // 22-24: missile (ranged attack)
      { sprite: 'POSS', frame: 4, tics: 10, nextState: 23, action: 'A_FaceTarget' },
      { sprite: 'POSS', frame: 5, tics: 8, nextState: 24, action: 'A_PosAttack' },
      { sprite: 'POSS', frame: 4, tics: 8, nextState: 18 },
    ],
    spawnState: 0, painState: 2, deathState: 4, xdeathState: 9,
    seeState: 18, missileState: 22,
    painChance: 200, dropItem: 2007,
    seeSound: [45, 46, 47], painSound: 36, deathSound: [68, 69, 70], activeSound: 84,
  },
  // Shotgun Guy (MT_SHOTGUY) — drops shotgun
  9: {
    states: [
      // 0-1: spawn
      { sprite: 'SPOS', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'SPOS', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'SPOS', frame: 6, tics: 3, nextState: 3 },
      { sprite: 'SPOS', frame: 6, tics: 3, nextState: 18 },
      // 4-8: death
      { sprite: 'SPOS', frame: 7, tics: 5, nextState: 5 },
      { sprite: 'SPOS', frame: 8, tics: 5, nextState: 6 },
      { sprite: 'SPOS', frame: 9, tics: 5, nextState: 7 },
      { sprite: 'SPOS', frame: 10, tics: 5, nextState: 8 },
      { sprite: 'SPOS', frame: 11, tics: -1, nextState: 8 },
      // 9-17: xdeath
      { sprite: 'SPOS', frame: 12, tics: 5, nextState: 10 },
      { sprite: 'SPOS', frame: 13, tics: 5, nextState: 11 },
      { sprite: 'SPOS', frame: 14, tics: 5, nextState: 12 },
      { sprite: 'SPOS', frame: 15, tics: 5, nextState: 13 },
      { sprite: 'SPOS', frame: 16, tics: 5, nextState: 14 },
      { sprite: 'SPOS', frame: 17, tics: 5, nextState: 15 },
      { sprite: 'SPOS', frame: 18, tics: 5, nextState: 16 },
      { sprite: 'SPOS', frame: 19, tics: 5, nextState: 17 },
      { sprite: 'SPOS', frame: 20, tics: -1, nextState: 17 },
      // 18-21: see
      { sprite: 'SPOS', frame: 0, tics: 3, nextState: 19, action: 'A_Chase' },
      { sprite: 'SPOS', frame: 1, tics: 3, nextState: 20, action: 'A_Chase' },
      { sprite: 'SPOS', frame: 2, tics: 3, nextState: 21, action: 'A_Chase' },
      { sprite: 'SPOS', frame: 3, tics: 3, nextState: 18, action: 'A_Chase' },
      // 22-24: missile
      { sprite: 'SPOS', frame: 4, tics: 10, nextState: 23, action: 'A_FaceTarget' },
      { sprite: 'SPOS', frame: 5, tics: 10, nextState: 24, action: 'A_SPosAttack' },
      { sprite: 'SPOS', frame: 4, tics: 10, nextState: 18 },
    ],
    spawnState: 0, painState: 2, deathState: 4, xdeathState: 9,
    seeState: 18, missileState: 22,
    painChance: 170, dropItem: 2001,
    seeSound: [45, 46, 47], painSound: 36, deathSound: [68, 69, 70], activeSound: 84,
  },
  // Imp (MT_TROOP) — melee + fireball
  3001: {
    states: [
      // 0-1: spawn
      { sprite: 'TROO', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'TROO', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'TROO', frame: 7, tics: 2, nextState: 3 },
      { sprite: 'TROO', frame: 7, tics: 2, nextState: 18 },
      // 4-8: death
      { sprite: 'TROO', frame: 8, tics: 8, nextState: 5 },
      { sprite: 'TROO', frame: 9, tics: 8, nextState: 6 },
      { sprite: 'TROO', frame: 10, tics: 6, nextState: 7 },
      { sprite: 'TROO', frame: 11, tics: 6, nextState: 8 },
      { sprite: 'TROO', frame: 12, tics: -1, nextState: 8 },
      // 9-16: xdeath
      { sprite: 'TROO', frame: 13, tics: 5, nextState: 10 },
      { sprite: 'TROO', frame: 14, tics: 5, nextState: 11 },
      { sprite: 'TROO', frame: 15, tics: 5, nextState: 12 },
      { sprite: 'TROO', frame: 16, tics: 5, nextState: 13 },
      { sprite: 'TROO', frame: 17, tics: 5, nextState: 14 },
      { sprite: 'TROO', frame: 18, tics: 5, nextState: 15 },
      { sprite: 'TROO', frame: 19, tics: 5, nextState: 16 },
      { sprite: 'TROO', frame: 20, tics: -1, nextState: 16 },
      // 17: (gap) — not used
      // 18-25: see
      { sprite: 'TROO', frame: 0, tics: 3, nextState: 19, action: 'A_Chase' },
      { sprite: 'TROO', frame: 1, tics: 3, nextState: 20, action: 'A_Chase' },
      { sprite: 'TROO', frame: 2, tics: 3, nextState: 21, action: 'A_Chase' },
      { sprite: 'TROO', frame: 3, tics: 3, nextState: 18, action: 'A_Chase' },
      // 22-24: melee
      { sprite: 'TROO', frame: 4, tics: 8, nextState: 23, action: 'A_FaceTarget' },
      { sprite: 'TROO', frame: 5, tics: 8, nextState: 24, action: 'A_TroopAttack' },
      { sprite: 'TROO', frame: 6, tics: 6, nextState: 18 },
      // 25-27: missile
      { sprite: 'TROO', frame: 4, tics: 8, nextState: 26, action: 'A_FaceTarget' },
      { sprite: 'TROO', frame: 5, tics: 8, nextState: 27, action: 'A_TroopAttack' },
      { sprite: 'TROO', frame: 6, tics: 6, nextState: 18 },
    ],
    spawnState: 0, painState: 2, deathState: 4, xdeathState: 9,
    seeState: 18, meleeState: 22, missileState: 25,
    painChance: 200, attackSound: 26,
    seeSound: [48, 49], painSound: 36, deathSound: [71, 72], activeSound: 85,
  },
  // Demon (MT_SERGEANT) — melee only
  3002: {
    states: [
      // 0-1: spawn
      { sprite: 'SARG', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'SARG', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'SARG', frame: 7, tics: 2, nextState: 3 },
      { sprite: 'SARG', frame: 7, tics: 2, nextState: 10 },
      // 4-9: death
      { sprite: 'SARG', frame: 8, tics: 8, nextState: 5 },
      { sprite: 'SARG', frame: 9, tics: 8, nextState: 6 },
      { sprite: 'SARG', frame: 10, tics: 4, nextState: 7 },
      { sprite: 'SARG', frame: 11, tics: 4, nextState: 8 },
      { sprite: 'SARG', frame: 12, tics: 4, nextState: 9 },
      { sprite: 'SARG', frame: 13, tics: -1, nextState: 9 },
      // 10-17: see
      { sprite: 'SARG', frame: 0, tics: 2, nextState: 11, action: 'A_Chase' },
      { sprite: 'SARG', frame: 1, tics: 2, nextState: 12, action: 'A_Chase' },
      { sprite: 'SARG', frame: 2, tics: 2, nextState: 13, action: 'A_Chase' },
      { sprite: 'SARG', frame: 3, tics: 2, nextState: 14, action: 'A_Chase' },
      { sprite: 'SARG', frame: 4, tics: 2, nextState: 15, action: 'A_Chase' },
      { sprite: 'SARG', frame: 5, tics: 2, nextState: 16, action: 'A_Chase' },
      { sprite: 'SARG', frame: 6, tics: 2, nextState: 17, action: 'A_Chase' },
      { sprite: 'SARG', frame: 7, tics: 2, nextState: 10, action: 'A_Chase' },
      // 18-20: melee
      { sprite: 'SARG', frame: 4, tics: 8, nextState: 19, action: 'A_FaceTarget' },
      { sprite: 'SARG', frame: 5, tics: 8, nextState: 20, action: 'A_FaceTarget' },
      { sprite: 'SARG', frame: 6, tics: 8, nextState: 10, action: 'A_SargAttack' },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 10, meleeState: 18,
    painChance: 180,
    seeSound: [50], painSound: 35, deathSound: [73], activeSound: 86,
  },
  // Spectre (MT_SHADOWS) — same as Demon
  58: {
    states: [
      { sprite: 'SARG', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'SARG', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      { sprite: 'SARG', frame: 7, tics: 2, nextState: 3 },
      { sprite: 'SARG', frame: 7, tics: 2, nextState: 10 },
      { sprite: 'SARG', frame: 8, tics: 8, nextState: 5 },
      { sprite: 'SARG', frame: 9, tics: 8, nextState: 6 },
      { sprite: 'SARG', frame: 10, tics: 4, nextState: 7 },
      { sprite: 'SARG', frame: 11, tics: 4, nextState: 8 },
      { sprite: 'SARG', frame: 12, tics: 4, nextState: 9 },
      { sprite: 'SARG', frame: 13, tics: -1, nextState: 9 },
      { sprite: 'SARG', frame: 0, tics: 2, nextState: 11, action: 'A_Chase' },
      { sprite: 'SARG', frame: 1, tics: 2, nextState: 12, action: 'A_Chase' },
      { sprite: 'SARG', frame: 2, tics: 2, nextState: 13, action: 'A_Chase' },
      { sprite: 'SARG', frame: 3, tics: 2, nextState: 14, action: 'A_Chase' },
      { sprite: 'SARG', frame: 4, tics: 2, nextState: 15, action: 'A_Chase' },
      { sprite: 'SARG', frame: 5, tics: 2, nextState: 16, action: 'A_Chase' },
      { sprite: 'SARG', frame: 6, tics: 2, nextState: 17, action: 'A_Chase' },
      { sprite: 'SARG', frame: 7, tics: 2, nextState: 10, action: 'A_Chase' },
      { sprite: 'SARG', frame: 4, tics: 8, nextState: 19, action: 'A_FaceTarget' },
      { sprite: 'SARG', frame: 5, tics: 8, nextState: 20, action: 'A_FaceTarget' },
      { sprite: 'SARG', frame: 6, tics: 8, nextState: 10, action: 'A_SargAttack' },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 10, meleeState: 18,
    painChance: 180, attackSound: 67,
    seeSound: [50], painSound: 35, deathSound: [73], activeSound: 86,
  },
  // Lost Soul (MT_SKULL) — charge attack only
  3006: {
    states: [
      { sprite: 'SKUL', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'SKUL', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'SKUL', frame: 6, tics: 3, nextState: 3 },
      { sprite: 'SKUL', frame: 7, tics: 3, nextState: 10 },
      // 4-9: death
      { sprite: 'SKUL', frame: 8, tics: 6, nextState: 5 },
      { sprite: 'SKUL', frame: 9, tics: 6, nextState: 6 },
      { sprite: 'SKUL', frame: 10, tics: 6, nextState: 7 },
      { sprite: 'SKUL', frame: 11, tics: 6, nextState: 8 },
      { sprite: 'SKUL', frame: 12, tics: 6, nextState: 9 },
      { sprite: 'SKUL', frame: 13, tics: -1, nextState: 9 },
      // 10-13: see
      { sprite: 'SKUL', frame: 0, tics: 6, nextState: 11, action: 'A_Chase' },
      { sprite: 'SKUL', frame: 1, tics: 6, nextState: 10, action: 'A_Chase' },
      // 12-13: missile (skull attack)
      { sprite: 'SKUL', frame: 2, tics: 10, nextState: 13, action: 'A_FaceTarget' },
      { sprite: 'SKUL', frame: 3, tics: 4, nextState: 14, action: 'A_SkullAttack' },
      { sprite: 'SKUL', frame: 4, tics: 4, nextState: 15 },
      { sprite: 'SKUL', frame: 5, tics: 4, nextState: 12 },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 10, missileState: 12,
    painChance: 256,
    seeSound: [], painSound: 35, deathSound: [26], activeSound: 86,
  },
  // Cacodemon (MT_HEAD) — melee + fireball
  3005: {
    states: [
      { sprite: 'HEAD', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'HEAD', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-4: pain
      { sprite: 'HEAD', frame: 7, tics: 3, nextState: 3 },
      { sprite: 'HEAD', frame: 7, tics: 3, nextState: 4 },
      { sprite: 'HEAD', frame: 7, tics: 6, nextState: 11 },
      // 5-10: death
      { sprite: 'HEAD', frame: 8, tics: 8, nextState: 6 },
      { sprite: 'HEAD', frame: 9, tics: 8, nextState: 7 },
      { sprite: 'HEAD', frame: 10, tics: 8, nextState: 8 },
      { sprite: 'HEAD', frame: 11, tics: 8, nextState: 9 },
      { sprite: 'HEAD', frame: 12, tics: 8, nextState: 10 },
      { sprite: 'HEAD', frame: 13, tics: -1, nextState: 10 },
      // 11-16: see
      { sprite: 'HEAD', frame: 0, tics: 3, nextState: 12, action: 'A_Chase' },
      { sprite: 'HEAD', frame: 1, tics: 3, nextState: 13, action: 'A_Chase' },
      { sprite: 'HEAD', frame: 2, tics: 3, nextState: 14, action: 'A_Chase' },
      { sprite: 'HEAD', frame: 3, tics: 3, nextState: 15, action: 'A_Chase' },
      { sprite: 'HEAD', frame: 4, tics: 3, nextState: 16, action: 'A_Chase' },
      { sprite: 'HEAD', frame: 5, tics: 3, nextState: 11, action: 'A_Chase' },
      // 17-19: missile
      { sprite: 'HEAD', frame: 4, tics: 5, nextState: 18, action: 'A_FaceTarget' },
      { sprite: 'HEAD', frame: 5, tics: 5, nextState: 19, action: 'A_FaceTarget' },
      { sprite: 'HEAD', frame: 6, tics: 5, nextState: 11, action: 'A_HeadAttack' },
    ],
    spawnState: 0, painState: 2, deathState: 5,
    seeState: 11, meleeState: 17, missileState: 17,
    painChance: 128, attackSound: 26,
    seeSound: [51], painSound: 35, deathSound: [74], activeSound: 86,
  },
  // Baron of Hell (MT_BRUISER) — melee + fireball
  3003: {
    states: [
      { sprite: 'BOSS', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'BOSS', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'BOSS', frame: 7, tics: 8, nextState: 3 },
      { sprite: 'BOSS', frame: 7, tics: 8, nextState: 11 },
      // 4-10: death
      { sprite: 'BOSS', frame: 8, tics: 8, nextState: 5 },
      { sprite: 'BOSS', frame: 9, tics: 8, nextState: 6 },
      { sprite: 'BOSS', frame: 10, tics: 8, nextState: 7 },
      { sprite: 'BOSS', frame: 11, tics: 8, nextState: 8 },
      { sprite: 'BOSS', frame: 12, tics: 8, nextState: 9 },
      { sprite: 'BOSS', frame: 13, tics: 8, nextState: 10 },
      { sprite: 'BOSS', frame: 14, tics: -1, nextState: 10 },
      // 11-14: see
      { sprite: 'BOSS', frame: 0, tics: 3, nextState: 12, action: 'A_Chase' },
      { sprite: 'BOSS', frame: 1, tics: 3, nextState: 13, action: 'A_Chase' },
      { sprite: 'BOSS', frame: 2, tics: 3, nextState: 14, action: 'A_Chase' },
      { sprite: 'BOSS', frame: 3, tics: 3, nextState: 11, action: 'A_Chase' },
      // 15-17: melee
      { sprite: 'BOSS', frame: 4, tics: 8, nextState: 16, action: 'A_FaceTarget' },
      { sprite: 'BOSS', frame: 5, tics: 8, nextState: 17, action: 'A_FaceTarget' },
      { sprite: 'BOSS', frame: 6, tics: 8, nextState: 11, action: 'A_BruisAttack' },
      // 18-20: missile
      { sprite: 'BOSS', frame: 4, tics: 8, nextState: 19, action: 'A_FaceTarget' },
      { sprite: 'BOSS', frame: 5, tics: 8, nextState: 20, action: 'A_FaceTarget' },
      { sprite: 'BOSS', frame: 6, tics: 8, nextState: 11, action: 'A_BruisAttack' },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 11, meleeState: 15, missileState: 18,
    painChance: 50, attackSound: 26,
    seeSound: [52], painSound: 35, deathSound: [76], activeSound: 86,
  },
  // Hell Knight (MT_KNIGHT) — same attack as Baron
  69: {
    states: [
      { sprite: 'BOS2', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'BOS2', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      { sprite: 'BOS2', frame: 7, tics: 8, nextState: 3 },
      { sprite: 'BOS2', frame: 7, tics: 8, nextState: 11 },
      { sprite: 'BOS2', frame: 8, tics: 8, nextState: 5 },
      { sprite: 'BOS2', frame: 9, tics: 8, nextState: 6 },
      { sprite: 'BOS2', frame: 10, tics: 8, nextState: 7 },
      { sprite: 'BOS2', frame: 11, tics: 8, nextState: 8 },
      { sprite: 'BOS2', frame: 12, tics: 8, nextState: 9 },
      { sprite: 'BOS2', frame: 13, tics: 8, nextState: 10 },
      { sprite: 'BOS2', frame: 14, tics: -1, nextState: 10 },
      // 11-14: see
      { sprite: 'BOS2', frame: 0, tics: 3, nextState: 12, action: 'A_Chase' },
      { sprite: 'BOS2', frame: 1, tics: 3, nextState: 13, action: 'A_Chase' },
      { sprite: 'BOS2', frame: 2, tics: 3, nextState: 14, action: 'A_Chase' },
      { sprite: 'BOS2', frame: 3, tics: 3, nextState: 11, action: 'A_Chase' },
      // 15-20: melee + missile (same structure as Baron)
      { sprite: 'BOS2', frame: 4, tics: 8, nextState: 16, action: 'A_FaceTarget' },
      { sprite: 'BOS2', frame: 5, tics: 8, nextState: 17, action: 'A_FaceTarget' },
      { sprite: 'BOS2', frame: 6, tics: 8, nextState: 11, action: 'A_BruisAttack' },
      { sprite: 'BOS2', frame: 4, tics: 8, nextState: 19, action: 'A_FaceTarget' },
      { sprite: 'BOS2', frame: 5, tics: 8, nextState: 20, action: 'A_FaceTarget' },
      { sprite: 'BOS2', frame: 6, tics: 8, nextState: 11, action: 'A_BruisAttack' },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 11, meleeState: 15, missileState: 18,
    painChance: 50, attackSound: 26,
    seeSound: [52], painSound: 35, deathSound: [76], activeSound: 86,
  },
  // Cyberdemon (MT_CYBORG) — missile only (rockets)
  16: {
    states: [
      { sprite: 'CYBR', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'CYBR', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'CYBR', frame: 9, tics: 10, nextState: 3 },
      { sprite: 'CYBR', frame: 9, tics: 10, nextState: 14 },
      // 4-13: death
      { sprite: 'CYBR', frame: 10, tics: 10, nextState: 5 },
      { sprite: 'CYBR', frame: 11, tics: 10, nextState: 6 },
      { sprite: 'CYBR', frame: 12, tics: 10, nextState: 7 },
      { sprite: 'CYBR', frame: 13, tics: 10, nextState: 8 },
      { sprite: 'CYBR', frame: 14, tics: 10, nextState: 9 },
      { sprite: 'CYBR', frame: 15, tics: 10, nextState: 10 },
      { sprite: 'CYBR', frame: 16, tics: 10, nextState: 11 },
      { sprite: 'CYBR', frame: 17, tics: 10, nextState: 12 },
      { sprite: 'CYBR', frame: 18, tics: 10, nextState: 13 },
      { sprite: 'CYBR', frame: 19, tics: -1, nextState: 13 },
      // 14-17: see
      { sprite: 'CYBR', frame: 0, tics: 3, nextState: 15, action: 'A_Hoof' },
      { sprite: 'CYBR', frame: 1, tics: 3, nextState: 16, action: 'A_Chase' },
      { sprite: 'CYBR', frame: 2, tics: 3, nextState: 17, action: 'A_Chase' },
      { sprite: 'CYBR', frame: 3, tics: 3, nextState: 14, action: 'A_Chase' },
      // 18-20: missile
      { sprite: 'CYBR', frame: 4, tics: 6, nextState: 19, action: 'A_FaceTarget' },
      { sprite: 'CYBR', frame: 5, tics: 12, nextState: 20, action: 'A_CyberAttack' },
      { sprite: 'CYBR', frame: 4, tics: 12, nextState: 21, action: 'A_FaceTarget' },
      { sprite: 'CYBR', frame: 5, tics: 12, nextState: 22, action: 'A_CyberAttack' },
      { sprite: 'CYBR', frame: 4, tics: 12, nextState: 23, action: 'A_FaceTarget' },
      { sprite: 'CYBR', frame: 5, tics: 12, nextState: 14, action: 'A_CyberAttack' },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 14, missileState: 18,
    painChance: 20,
    seeSound: [53], deathSound: [77], activeSound: 86,
  },
  // Spider Mastermind (MT_SPIDER) — super chaingun
  7: {
    states: [
      { sprite: 'SPID', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'SPID', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'SPID', frame: 8, tics: 3, nextState: 3 },
      { sprite: 'SPID', frame: 8, tics: 3, nextState: 10 },
      // 4-14: death
      { sprite: 'SPID', frame: 9, tics: 20, nextState: 5 },
      { sprite: 'SPID', frame: 10, tics: 10, nextState: 6 },
      { sprite: 'SPID', frame: 11, tics: 10, nextState: 7 },
      { sprite: 'SPID', frame: 12, tics: 10, nextState: 8 },
      { sprite: 'SPID', frame: 13, tics: 10, nextState: 9 },
      { sprite: 'SPID', frame: 14, tics: 10, nextState: 10 },
      // idx 10 is reused — spider uses long death
      { sprite: 'SPID', frame: 15, tics: 10, nextState: 11 },
      { sprite: 'SPID', frame: 16, tics: 10, nextState: 12 },
      { sprite: 'SPID', frame: 17, tics: 10, nextState: 13 },
      { sprite: 'SPID', frame: 18, tics: 10, nextState: 14 },
      { sprite: 'SPID', frame: 19, tics: -1, nextState: 14 },
      // 15-20: see
      { sprite: 'SPID', frame: 0, tics: 3, nextState: 16, action: 'A_Metal' },
      { sprite: 'SPID', frame: 1, tics: 3, nextState: 17, action: 'A_Chase' },
      { sprite: 'SPID', frame: 2, tics: 3, nextState: 18, action: 'A_Chase' },
      { sprite: 'SPID', frame: 3, tics: 3, nextState: 19, action: 'A_Chase' },
      { sprite: 'SPID', frame: 4, tics: 3, nextState: 20, action: 'A_Metal' },
      { sprite: 'SPID', frame: 5, tics: 3, nextState: 15, action: 'A_Chase' },
      // 21-23: missile
      { sprite: 'SPID', frame: 5, tics: 20, nextState: 22, action: 'A_FaceTarget' },
      { sprite: 'SPID', frame: 6, tics: 4, nextState: 23, action: 'A_SPosAttack' },
      { sprite: 'SPID', frame: 7, tics: 4, nextState: 22, action: 'A_SpidRefire' },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 15, missileState: 21,
    painChance: 40,
    seeSound: [54], painSound: 35, deathSound: [78], activeSound: 86,
  },
  // Chaingunner (MT_CHAINGUY) — rapid fire, drops chaingun
  65: {
    states: [
      // 0-1: spawn (idle) — A_Look
      { sprite: 'CPOS', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'CPOS', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'CPOS', frame: 5, tics: 3, nextState: 3 },
      { sprite: 'CPOS', frame: 5, tics: 3, nextState: 16 },  // pain → seeState
      // 4-10: death
      { sprite: 'CPOS', frame: 6, tics: 5, nextState: 5 },
      { sprite: 'CPOS', frame: 7, tics: 5, nextState: 6 },
      { sprite: 'CPOS', frame: 8, tics: 5, nextState: 7 },
      { sprite: 'CPOS', frame: 9, tics: 5, nextState: 8 },
      { sprite: 'CPOS', frame: 10, tics: 5, nextState: 9 },
      { sprite: 'CPOS', frame: 11, tics: 5, nextState: 10 },
      { sprite: 'CPOS', frame: 12, tics: -1, nextState: 10 },
      // 11-15: xdeath
      { sprite: 'CPOS', frame: 13, tics: 5, nextState: 12 },
      { sprite: 'CPOS', frame: 14, tics: 5, nextState: 13 },
      { sprite: 'CPOS', frame: 15, tics: 5, nextState: 14 },
      { sprite: 'CPOS', frame: 16, tics: 5, nextState: 15 },
      { sprite: 'CPOS', frame: 17, tics: -1, nextState: 15 },
      // 16-19: see (walk cycle) — A_Chase
      { sprite: 'CPOS', frame: 0, tics: 3, nextState: 17, action: 'A_Chase' },
      { sprite: 'CPOS', frame: 1, tics: 3, nextState: 18, action: 'A_Chase' },
      { sprite: 'CPOS', frame: 2, tics: 3, nextState: 19, action: 'A_Chase' },
      { sprite: 'CPOS', frame: 3, tics: 3, nextState: 16, action: 'A_Chase' },
      // 20-22: missile (attack loop with refire)
      { sprite: 'CPOS', frame: 4, tics: 10, nextState: 21, action: 'A_FaceTarget' },
      { sprite: 'CPOS', frame: 5, tics: 4, nextState: 22, action: 'A_CPosAttack' },
      { sprite: 'CPOS', frame: 4, tics: 4, nextState: 21, action: 'A_CPosRefire' },
    ],
    spawnState: 0, painState: 2, deathState: 4, xdeathState: 11,
    seeState: 16, missileState: 20,
    painChance: 170, dropItem: 2002,
    seeSound: [45, 46, 47], painSound: 36, deathSound: [68, 69, 70], activeSound: 84,
  },

  // Arch-vile (MT_VILE) — fire attack + resurrect
  // Original DOOM: sprite VILE, DoomEd 64
  64: {
    states: [
      // 0-1: spawn (idle)
      { sprite: 'VILE', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'VILE', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'VILE', frame: 16, tics: 5, nextState: 3 },
      { sprite: 'VILE', frame: 16, tics: 5, nextState: 12 },  // pain → seeState
      // 4-11: death (S_VILE_DIE1..DIE10)
      { sprite: 'VILE', frame: 16, tics: 7, nextState: 5 },
      { sprite: 'VILE', frame: 17, tics: 7, nextState: 6 },
      { sprite: 'VILE', frame: 18, tics: 7, nextState: 7 },
      { sprite: 'VILE', frame: 19, tics: 7, nextState: 8 },
      { sprite: 'VILE', frame: 20, tics: 7, nextState: 9 },
      { sprite: 'VILE', frame: 21, tics: 7, nextState: 10 },
      { sprite: 'VILE', frame: 22, tics: 7, nextState: 11 },
      { sprite: 'VILE', frame: 23, tics: -1, nextState: 11 },
      // 12-23: see (walk/chase) — A_VileChase (like A_Chase but can resurrect)
      { sprite: 'VILE', frame: 0, tics: 2, nextState: 13, action: 'A_VileChase' },
      { sprite: 'VILE', frame: 0, tics: 2, nextState: 14, action: 'A_VileChase' },
      { sprite: 'VILE', frame: 1, tics: 2, nextState: 15, action: 'A_VileChase' },
      { sprite: 'VILE', frame: 1, tics: 2, nextState: 16, action: 'A_VileChase' },
      { sprite: 'VILE', frame: 2, tics: 2, nextState: 17, action: 'A_VileChase' },
      { sprite: 'VILE', frame: 2, tics: 2, nextState: 18, action: 'A_VileChase' },
      { sprite: 'VILE', frame: 3, tics: 2, nextState: 19, action: 'A_VileChase' },
      { sprite: 'VILE', frame: 3, tics: 2, nextState: 20, action: 'A_VileChase' },
      { sprite: 'VILE', frame: 4, tics: 2, nextState: 21, action: 'A_VileChase' },
      { sprite: 'VILE', frame: 4, tics: 2, nextState: 22, action: 'A_VileChase' },
      { sprite: 'VILE', frame: 5, tics: 2, nextState: 23, action: 'A_VileChase' },
      { sprite: 'VILE', frame: 5, tics: 2, nextState: 12, action: 'A_VileChase' },
      // 24-33: missile (attack sequence)
      // S_VILE_ATK1: face target, play vilatk sound
      { sprite: 'VILE', frame: 6, tics: 0, nextState: 25, action: 'A_VileStart' },
      // S_VILE_ATK2: raise arms, spawn fire
      { sprite: 'VILE', frame: 6, tics: 10, nextState: 26, action: 'A_VileTarget' },
      // S_VILE_ATK3-ATK10: wind-up frames (fire tracks target)
      { sprite: 'VILE', frame: 7, tics: 8, nextState: 27, action: 'A_FaceTarget' },
      { sprite: 'VILE', frame: 8, tics: 8, nextState: 28, action: 'A_FaceTarget' },
      { sprite: 'VILE', frame: 9, tics: 8, nextState: 29, action: 'A_FaceTarget' },
      { sprite: 'VILE', frame: 10, tics: 8, nextState: 30, action: 'A_FaceTarget' },
      { sprite: 'VILE', frame: 11, tics: 8, nextState: 31, action: 'A_FaceTarget' },
      { sprite: 'VILE', frame: 12, tics: 8, nextState: 32, action: 'A_FaceTarget' },
      { sprite: 'VILE', frame: 13, tics: 8, nextState: 33, action: 'A_FaceTarget' },
      // S_VILE_ATK11: actual attack — damage + launch
      { sprite: 'VILE', frame: 14, tics: 8, nextState: 34, action: 'A_VileAttack' },
      // Return to see state
      { sprite: 'VILE', frame: 15, tics: 20, nextState: 12 },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 12, missileState: 24,
    painChance: 10,
    seeSound: [57], painSound: 37, deathSound: [80], activeSound: 89,
  },

  // Revenant (MT_UNDEAD) — melee punch + homing missile
  // DoomEd 66, sprite SKEL
  66: {
    states: [
      // 0-1: spawn (idle)
      { sprite: 'SKEL', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'SKEL', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'SKEL', frame: 11, tics: 5, nextState: 3 },
      { sprite: 'SKEL', frame: 11, tics: 5, nextState: 12 },  // pain → seeState
      // 4-10: death
      { sprite: 'SKEL', frame: 11, tics: 7, nextState: 5 },
      { sprite: 'SKEL', frame: 12, tics: 7, nextState: 6 },
      { sprite: 'SKEL', frame: 13, tics: 7, nextState: 7 },
      { sprite: 'SKEL', frame: 14, tics: 7, nextState: 8 },
      { sprite: 'SKEL', frame: 15, tics: 7, nextState: 9 },
      { sprite: 'SKEL', frame: 16, tics: 7, nextState: 10 },
      // Extra death frames (revenant has long fall)
      { sprite: 'SKEL', frame: 16, tics: 7, nextState: 11 },
      { sprite: 'SKEL', frame: 16, tics: -1, nextState: 11 },
      // 12-23: see (walk cycle, 12 frames)
      { sprite: 'SKEL', frame: 0, tics: 2, nextState: 13, action: 'A_Chase' },
      { sprite: 'SKEL', frame: 0, tics: 2, nextState: 14, action: 'A_Chase' },
      { sprite: 'SKEL', frame: 1, tics: 2, nextState: 15, action: 'A_Chase' },
      { sprite: 'SKEL', frame: 1, tics: 2, nextState: 16, action: 'A_Chase' },
      { sprite: 'SKEL', frame: 2, tics: 2, nextState: 17, action: 'A_Chase' },
      { sprite: 'SKEL', frame: 2, tics: 2, nextState: 18, action: 'A_Chase' },
      { sprite: 'SKEL', frame: 3, tics: 2, nextState: 19, action: 'A_Chase' },
      { sprite: 'SKEL', frame: 3, tics: 2, nextState: 20, action: 'A_Chase' },
      { sprite: 'SKEL', frame: 4, tics: 2, nextState: 21, action: 'A_Chase' },
      { sprite: 'SKEL', frame: 4, tics: 2, nextState: 22, action: 'A_Chase' },
      { sprite: 'SKEL', frame: 5, tics: 2, nextState: 23, action: 'A_Chase' },
      { sprite: 'SKEL', frame: 5, tics: 2, nextState: 12, action: 'A_Chase' },
      // 24-26: melee (fist punch)
      { sprite: 'SKEL', frame: 6, tics: 6, nextState: 25, action: 'A_FaceTarget' },
      { sprite: 'SKEL', frame: 7, tics: 6, nextState: 26, action: 'A_SkelWhoosh' },
      { sprite: 'SKEL', frame: 8, tics: 6, nextState: 12, action: 'A_SkelFist' },
      // 27-28: missile (tracer launch)
      { sprite: 'SKEL', frame: 9, tics: 0, nextState: 28, action: 'A_FaceTarget' },
      { sprite: 'SKEL', frame: 9, tics: 10, nextState: 29, action: 'A_SkelMissile' },
      { sprite: 'SKEL', frame: 10, tics: 10, nextState: 30 },
      { sprite: 'SKEL', frame: 10, tics: 10, nextState: 12, action: 'A_FaceTarget' },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 12, meleeState: 24, missileState: 27,
    painChance: 100, attackSound: 62,  // Sfx.skepch
    seeSound: [115], painSound: 62, deathSound: [83], activeSound: 114,
  },

  // Mancubus (MT_FATSO) — triple-spread fireball attack
  // DoomEd 67, sprite FATT
  67: {
    states: [
      // 0-1: spawn (idle)
      { sprite: 'FATT', frame: 0, tics: 15, nextState: 1, action: 'A_Look' },
      { sprite: 'FATT', frame: 1, tics: 15, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'FATT', frame: 9, tics: 3, nextState: 3 },
      { sprite: 'FATT', frame: 9, tics: 3, nextState: 12 },  // pain → seeState
      // 4-11: death
      { sprite: 'FATT', frame: 10, tics: 6, nextState: 5 },
      { sprite: 'FATT', frame: 11, tics: 6, nextState: 6 },
      { sprite: 'FATT', frame: 12, tics: 6, nextState: 7 },
      { sprite: 'FATT', frame: 13, tics: 6, nextState: 8 },
      { sprite: 'FATT', frame: 14, tics: 6, nextState: 9 },
      { sprite: 'FATT', frame: 15, tics: 6, nextState: 10 },
      { sprite: 'FATT', frame: 16, tics: 6, nextState: 11 },
      { sprite: 'FATT', frame: 17, tics: -1, nextState: 11 },
      // 12-23: see (walk cycle, 12 frames)
      { sprite: 'FATT', frame: 0, tics: 4, nextState: 13, action: 'A_Chase' },
      { sprite: 'FATT', frame: 0, tics: 4, nextState: 14, action: 'A_Chase' },
      { sprite: 'FATT', frame: 1, tics: 4, nextState: 15, action: 'A_Chase' },
      { sprite: 'FATT', frame: 1, tics: 4, nextState: 16, action: 'A_Chase' },
      { sprite: 'FATT', frame: 2, tics: 4, nextState: 17, action: 'A_Chase' },
      { sprite: 'FATT', frame: 2, tics: 4, nextState: 18, action: 'A_Chase' },
      { sprite: 'FATT', frame: 3, tics: 4, nextState: 19, action: 'A_Chase' },
      { sprite: 'FATT', frame: 3, tics: 4, nextState: 20, action: 'A_Chase' },
      { sprite: 'FATT', frame: 4, tics: 4, nextState: 21, action: 'A_Chase' },
      { sprite: 'FATT', frame: 4, tics: 4, nextState: 22, action: 'A_Chase' },
      { sprite: 'FATT', frame: 5, tics: 4, nextState: 23, action: 'A_Chase' },
      { sprite: 'FATT', frame: 5, tics: 4, nextState: 12, action: 'A_Chase' },
      // 24-29: missile (3 volleys: FatAttack1, FatAttack2, FatAttack3)
      { sprite: 'FATT', frame: 6, tics: 20, nextState: 25, action: 'A_FatRaise' },
      { sprite: 'FATT', frame: 7, tics: 10, nextState: 26, action: 'A_FatAttack1' },
      { sprite: 'FATT', frame: 8, tics: 5, nextState: 27, action: 'A_FaceTarget' },
      { sprite: 'FATT', frame: 6, tics: 5, nextState: 28, action: 'A_FatAttack2' },
      { sprite: 'FATT', frame: 7, tics: 5, nextState: 29, action: 'A_FaceTarget' },
      { sprite: 'FATT', frame: 8, tics: 5, nextState: 12, action: 'A_FatAttack3' },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 12, missileState: 24,
    painChance: 80,
    seeSound: [58], painSound: 38, deathSound: [109], activeSound: 86,
  },

  // Arachnotron (MT_BABY) — rapid-fire plasma
  // DoomEd 68, sprite BSPI
  68: {
    states: [
      // 0-1: spawn (idle)
      { sprite: 'BSPI', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'BSPI', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'BSPI', frame: 8, tics: 3, nextState: 3 },
      { sprite: 'BSPI', frame: 8, tics: 3, nextState: 12 },  // pain → seeState
      // 4-10: death
      { sprite: 'BSPI', frame: 9, tics: 20, nextState: 5 },
      { sprite: 'BSPI', frame: 10, tics: 7, nextState: 6 },
      { sprite: 'BSPI', frame: 11, tics: 7, nextState: 7 },
      { sprite: 'BSPI', frame: 12, tics: 7, nextState: 8 },
      { sprite: 'BSPI', frame: 13, tics: 7, nextState: 9 },
      { sprite: 'BSPI', frame: 14, tics: 7, nextState: 10 },
      { sprite: 'BSPI', frame: 15, tics: 7, nextState: 11 },
      { sprite: 'BSPI', frame: 15, tics: -1, nextState: 11 },
      // 12-23: see (walk cycle, 12 frames with BabyMetal footstep)
      { sprite: 'BSPI', frame: 0, tics: 3, nextState: 13, action: 'A_BabyMetal' },
      { sprite: 'BSPI', frame: 0, tics: 3, nextState: 14, action: 'A_Chase' },
      { sprite: 'BSPI', frame: 1, tics: 3, nextState: 15, action: 'A_Chase' },
      { sprite: 'BSPI', frame: 1, tics: 3, nextState: 16, action: 'A_Chase' },
      { sprite: 'BSPI', frame: 2, tics: 3, nextState: 17, action: 'A_Chase' },
      { sprite: 'BSPI', frame: 2, tics: 3, nextState: 18, action: 'A_Chase' },
      { sprite: 'BSPI', frame: 3, tics: 3, nextState: 19, action: 'A_BabyMetal' },
      { sprite: 'BSPI', frame: 3, tics: 3, nextState: 20, action: 'A_Chase' },
      { sprite: 'BSPI', frame: 4, tics: 3, nextState: 21, action: 'A_Chase' },
      { sprite: 'BSPI', frame: 4, tics: 3, nextState: 22, action: 'A_Chase' },
      { sprite: 'BSPI', frame: 5, tics: 3, nextState: 23, action: 'A_Chase' },
      { sprite: 'BSPI', frame: 5, tics: 3, nextState: 12, action: 'A_Chase' },
      // 24-26: missile (plasma rapid fire with refire)
      { sprite: 'BSPI', frame: 0, tics: 20, nextState: 25, action: 'A_FaceTarget' },
      { sprite: 'BSPI', frame: 6, tics: 4, nextState: 26, action: 'A_BspiAttack' },
      { sprite: 'BSPI', frame: 7, tics: 4, nextState: 25, action: 'A_SpidRefire' },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 12, missileState: 24,
    painChance: 128,
    seeSound: [55], painSound: 35, deathSound: [79], activeSound: 87,
  },

  // Pain Elemental (MT_PAIN) — spawns Lost Souls
  // DoomEd 71, sprite PAIN
  71: {
    states: [
      // 0-2: spawn (idle, 3 frames)
      { sprite: 'PAIN', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'PAIN', frame: 1, tics: 10, nextState: 2, action: 'A_Look' },
      { sprite: 'PAIN', frame: 2, tics: 10, nextState: 0, action: 'A_Look' },
      // 3-4: pain
      { sprite: 'PAIN', frame: 6, tics: 6, nextState: 4 },
      { sprite: 'PAIN', frame: 6, tics: 6, nextState: 9 },  // pain → seeState
      // 5-8: death (A_PainDie spawns 3 lost souls)
      { sprite: 'PAIN', frame: 7, tics: 8, nextState: 6, action: 'A_PainDie' },
      { sprite: 'PAIN', frame: 8, tics: 8, nextState: 7 },
      { sprite: 'PAIN', frame: 9, tics: 8, nextState: 8 },
      { sprite: 'PAIN', frame: 10, tics: -1, nextState: 8 },
      // 9-14: see (float/chase, 6 frames)
      { sprite: 'PAIN', frame: 0, tics: 3, nextState: 10, action: 'A_Chase' },
      { sprite: 'PAIN', frame: 0, tics: 3, nextState: 11, action: 'A_Chase' },
      { sprite: 'PAIN', frame: 1, tics: 3, nextState: 12, action: 'A_Chase' },
      { sprite: 'PAIN', frame: 1, tics: 3, nextState: 13, action: 'A_Chase' },
      { sprite: 'PAIN', frame: 2, tics: 3, nextState: 14, action: 'A_Chase' },
      { sprite: 'PAIN', frame: 2, tics: 3, nextState: 9, action: 'A_Chase' },
      // 15-17: missile (spawn Lost Soul)
      { sprite: 'PAIN', frame: 3, tics: 5, nextState: 16, action: 'A_FaceTarget' },
      { sprite: 'PAIN', frame: 4, tics: 5, nextState: 17, action: 'A_FaceTarget' },
      { sprite: 'PAIN', frame: 5, tics: 5, nextState: 18, action: 'A_FaceTarget' },
      { sprite: 'PAIN', frame: 5, tics: 0, nextState: 9, action: 'A_PainAttack' },
    ],
    spawnState: 0, painState: 3, deathState: 5,
    seeState: 9, missileState: 15,
    painChance: 128,
    seeSound: [59], painSound: 39, deathSound: [82], activeSound: 86,
  },

  // Boss Brain (MT_BOSSBRAIN) — stationary, takes damage, exits level on death
  // DoomEd 88, sprite BBRN
  88: {
    states: [
      // 0: spawn (static)
      { sprite: 'BBRN', frame: 0, tics: -1, nextState: 0, action: 'A_Look' },
      // 1-2: pain
      { sprite: 'BBRN', frame: 1, tics: 36, nextState: 2, action: 'A_BrainPain' },
      { sprite: 'BBRN', frame: 0, tics: -1, nextState: 2 },  // back to idle
      // 3-6: death (A_BrainScream → explode frames → A_BrainDie)
      { sprite: 'BBRN', frame: 0, tics: 100, nextState: 4, action: 'A_BrainScream' },
      { sprite: 'BBRN', frame: 0, tics: 10, nextState: 5, action: 'A_BrainExplode' },
      { sprite: 'BBRN', frame: 0, tics: 10, nextState: 6, action: 'A_BrainExplode' },
      { sprite: 'BBRN', frame: 0, tics: -1, nextState: 6, action: 'A_BrainDie' },
    ],
    spawnState: 0, painState: 1, deathState: 3,
    painChance: 255,
    painSound: 106,  // Sfx.bospn
  },

  // Boss Eye (MT_BOSSSPIT) — fires spawn cubes at targets
  // DoomEd 89, invisible (MF_NOSECTOR) but needs animation for A_BrainSpit
  89: {
    states: [
      // 0: spawn — wait for player
      { sprite: 'BBRN', frame: 0, tics: -1, nextState: 0, action: 'A_Look' },
      // 1: see/awake — play sound then start spit cycle
      { sprite: 'BBRN', frame: 0, tics: 181, nextState: 2, action: 'A_BrainAwake' },
      // 2-3: spit cycle — fire a cube then wait and repeat
      { sprite: 'BBRN', frame: 0, tics: 150, nextState: 3, action: 'A_BrainSpit' },
      { sprite: 'BBRN', frame: 0, tics: 1, nextState: 2 },
    ],
    spawnState: 0, seeState: 1,
  },

  // Wolf SS (MT_WOLFSS) — hitscan attack (reuses A_SPosAttack)
  // DoomEd 84, sprite SSWV
  84: {
    states: [
      // 0-1: spawn (idle)
      { sprite: 'SSWV', frame: 0, tics: 10, nextState: 1, action: 'A_Look' },
      { sprite: 'SSWV', frame: 1, tics: 10, nextState: 0, action: 'A_Look' },
      // 2-3: pain
      { sprite: 'SSWV', frame: 7, tics: 3, nextState: 3 },
      { sprite: 'SSWV', frame: 7, tics: 3, nextState: 10 },  // pain → seeState
      // 4-8: death
      { sprite: 'SSWV', frame: 8, tics: 5, nextState: 5 },
      { sprite: 'SSWV', frame: 9, tics: 5, nextState: 6 },
      { sprite: 'SSWV', frame: 10, tics: 5, nextState: 7 },
      { sprite: 'SSWV', frame: 11, tics: 5, nextState: 8 },
      { sprite: 'SSWV', frame: 12, tics: -1, nextState: 8 },
      // 9: gap (unused)
      { sprite: 'SSWV', frame: 0, tics: 1, nextState: 10 },
      // 10-13: see (walk cycle)
      { sprite: 'SSWV', frame: 0, tics: 3, nextState: 11, action: 'A_Chase' },
      { sprite: 'SSWV', frame: 1, tics: 3, nextState: 12, action: 'A_Chase' },
      { sprite: 'SSWV', frame: 2, tics: 3, nextState: 13, action: 'A_Chase' },
      { sprite: 'SSWV', frame: 3, tics: 3, nextState: 10, action: 'A_Chase' },
      // 14-16: missile (hitscan attack, same as Shotgun Guy)
      { sprite: 'SSWV', frame: 4, tics: 10, nextState: 15, action: 'A_FaceTarget' },
      { sprite: 'SSWV', frame: 5, tics: 10, nextState: 16, action: 'A_FaceTarget' },
      { sprite: 'SSWV', frame: 6, tics: 10, nextState: 10, action: 'A_SPosAttack' },
    ],
    spawnState: 0, painState: 2, deathState: 4,
    seeState: 10, missileState: 14,
    painChance: 170, dropItem: 2012,  // drops clip
    seeSound: [45, 46, 47], painSound: 36, deathSound: [68, 69, 70], activeSound: 84,
  },

  // ============================================================
  // Decorations & Pickups
  // ============================================================

  // Barrel (BAR1 A/B)
  2035: {
    states: [
      { sprite: 'BAR1', frame: 0, tics: 6, nextState: 1 },
      { sprite: 'BAR1', frame: 1, tics: 6, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Tall blue torch (TBLU A-D)
  44: {
    states: [
      { sprite: 'TBLU', frame: 0, tics: 4, nextState: 1 },
      { sprite: 'TBLU', frame: 1, tics: 4, nextState: 2 },
      { sprite: 'TBLU', frame: 2, tics: 4, nextState: 3 },
      { sprite: 'TBLU', frame: 3, tics: 4, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Tall green torch (TGRN A-D)
  45: {
    states: [
      { sprite: 'TGRN', frame: 0, tics: 4, nextState: 1 },
      { sprite: 'TGRN', frame: 1, tics: 4, nextState: 2 },
      { sprite: 'TGRN', frame: 2, tics: 4, nextState: 3 },
      { sprite: 'TGRN', frame: 3, tics: 4, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Tall red torch (TRED A-D)
  46: {
    states: [
      { sprite: 'TRED', frame: 0, tics: 4, nextState: 1 },
      { sprite: 'TRED', frame: 1, tics: 4, nextState: 2 },
      { sprite: 'TRED', frame: 2, tics: 4, nextState: 3 },
      { sprite: 'TRED', frame: 3, tics: 4, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Short blue torch (SMBT A-D)
  55: {
    states: [
      { sprite: 'SMBT', frame: 0, tics: 4, nextState: 1 },
      { sprite: 'SMBT', frame: 1, tics: 4, nextState: 2 },
      { sprite: 'SMBT', frame: 2, tics: 4, nextState: 3 },
      { sprite: 'SMBT', frame: 3, tics: 4, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Short green torch (SMGT A-D)
  56: {
    states: [
      { sprite: 'SMGT', frame: 0, tics: 4, nextState: 1 },
      { sprite: 'SMGT', frame: 1, tics: 4, nextState: 2 },
      { sprite: 'SMGT', frame: 2, tics: 4, nextState: 3 },
      { sprite: 'SMGT', frame: 3, tics: 4, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Short red torch (SMRT A-D)
  57: {
    states: [
      { sprite: 'SMRT', frame: 0, tics: 4, nextState: 1 },
      { sprite: 'SMRT', frame: 1, tics: 4, nextState: 2 },
      { sprite: 'SMRT', frame: 2, tics: 4, nextState: 3 },
      { sprite: 'SMRT', frame: 3, tics: 4, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Health bonus (BON1: bounce 0,1,2,3,2,1)
  2014: {
    states: [
      { sprite: 'BON1', frame: 0, tics: 6, nextState: 1 },
      { sprite: 'BON1', frame: 1, tics: 6, nextState: 2 },
      { sprite: 'BON1', frame: 2, tics: 6, nextState: 3 },
      { sprite: 'BON1', frame: 3, tics: 6, nextState: 4 },
      { sprite: 'BON1', frame: 2, tics: 6, nextState: 5 },
      { sprite: 'BON1', frame: 1, tics: 6, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Armor bonus (BON2: bounce 0,1,2,3,2,1)
  2015: {
    states: [
      { sprite: 'BON2', frame: 0, tics: 6, nextState: 1 },
      { sprite: 'BON2', frame: 1, tics: 6, nextState: 2 },
      { sprite: 'BON2', frame: 2, tics: 6, nextState: 3 },
      { sprite: 'BON2', frame: 3, tics: 6, nextState: 4 },
      { sprite: 'BON2', frame: 2, tics: 6, nextState: 5 },
      { sprite: 'BON2', frame: 1, tics: 6, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Soulsphere (SOUL: bounce 0,1,2,3,2,1)
  2013: {
    states: [
      { sprite: 'SOUL', frame: 0, tics: 6, nextState: 1 },
      { sprite: 'SOUL', frame: 1, tics: 6, nextState: 2 },
      { sprite: 'SOUL', frame: 2, tics: 6, nextState: 3 },
      { sprite: 'SOUL', frame: 3, tics: 6, nextState: 4 },
      { sprite: 'SOUL', frame: 2, tics: 6, nextState: 5 },
      { sprite: 'SOUL', frame: 1, tics: 6, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Invulnerability (PINV A-D)
  2022: {
    states: [
      { sprite: 'PINV', frame: 0, tics: 6, nextState: 1 },
      { sprite: 'PINV', frame: 1, tics: 6, nextState: 2 },
      { sprite: 'PINV', frame: 2, tics: 6, nextState: 3 },
      { sprite: 'PINV', frame: 3, tics: 6, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Partial invisibility (PINS A-D) — thing type 2024, NOT 2023 (Berserk)
  2024: {
    states: [
      { sprite: 'PINS', frame: 0, tics: 6, nextState: 1 },
      { sprite: 'PINS', frame: 1, tics: 6, nextState: 2 },
      { sprite: 'PINS', frame: 2, tics: 6, nextState: 3 },
      { sprite: 'PINS', frame: 3, tics: 6, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Candelabra (CBRA A) - static, 1 frame => no animation needed
  // But keeping it here for completeness if you want fullbright

  // Keys (cycle A/B)
  13: {
    states: [
      { sprite: 'RKEY', frame: 0, tics: 10, nextState: 1 },
      { sprite: 'RKEY', frame: 1, tics: 10, nextState: 0 },
    ],
    spawnState: 0,
  },
  6: {
    states: [
      { sprite: 'BKEY', frame: 0, tics: 10, nextState: 1 },
      { sprite: 'BKEY', frame: 1, tics: 10, nextState: 0 },
    ],
    spawnState: 0,
  },
  5: {
    states: [
      { sprite: 'YKEY', frame: 0, tics: 10, nextState: 1 },
      { sprite: 'YKEY', frame: 1, tics: 10, nextState: 0 },
    ],
    spawnState: 0,
  },
  38: {
    states: [
      { sprite: 'RSKU', frame: 0, tics: 10, nextState: 1 },
      { sprite: 'RSKU', frame: 1, tics: 10, nextState: 0 },
    ],
    spawnState: 0,
  },
  39: {
    states: [
      { sprite: 'BSKU', frame: 0, tics: 10, nextState: 1 },
      { sprite: 'BSKU', frame: 1, tics: 10, nextState: 0 },
    ],
    spawnState: 0,
  },
  40: {
    states: [
      { sprite: 'YSKU', frame: 0, tics: 10, nextState: 1 },
      { sprite: 'YSKU', frame: 1, tics: 10, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Twitching impaled (POL6 A/B)
  26: {
    states: [
      { sprite: 'POL6', frame: 0, tics: 6, nextState: 1 },
      { sprite: 'POL6', frame: 1, tics: 6, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Hanging victim twitching (GOR1 A-C)
  49: {
    states: [
      { sprite: 'GOR1', frame: 0, tics: 10, nextState: 1 },
      { sprite: 'GOR1', frame: 1, tics: 15, nextState: 2 },
      { sprite: 'GOR1', frame: 2, tics: 8, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Tech column (ELEC A)
  48: {
    states: [
      { sprite: 'ELEC', frame: 0, tics: -1, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Computer area map (PMAP: bounce 0,1,2,3,2,1)
  2026: {
    states: [
      { sprite: 'PMAP', frame: 0, tics: 6, nextState: 1 },
      { sprite: 'PMAP', frame: 1, tics: 6, nextState: 2 },
      { sprite: 'PMAP', frame: 2, tics: 6, nextState: 3 },
      { sprite: 'PMAP', frame: 3, tics: 6, nextState: 4 },
      { sprite: 'PMAP', frame: 2, tics: 6, nextState: 5 },
      { sprite: 'PMAP', frame: 1, tics: 6, nextState: 0 },
    ],
    spawnState: 0,
  },
  // Light amp goggles (PVIS A-B)
  2045: {
    states: [
      { sprite: 'PVIS', frame: 0, tics: 6, nextState: 1 },
      { sprite: 'PVIS', frame: 1, tics: 6, nextState: 0 },
    ],
    spawnState: 0,
  },
};

/** Monster lifecycle state */
export type MobjLifecycle = 'alive' | 'chasing' | 'attacking' | 'pain' | 'dying' | 'dead';

/** Runtime animation state for a single thing instance */
export interface ThingAnimState {
  thingType: number;
  stateIdx: number;       // current state index in THING_ANIM_DEFS[type].states
  tics: number;           // remaining tics in current state
  sprite: string;         // current sprite name
  frame: number;          // current frame number
  mobjState: MobjLifecycle; // monster lifecycle (decorations always 'alive')
}

/** Map of thing index (in map.things array) → animation state */
const thingAnimStates: Map<number, ThingAnimState> = new Map();

/**
 * Initialize thing animation states for all things on the map.
 * Call after map is loaded.
 */
export function initThingAnimations(things: { type: number }[]): void {
  thingAnimStates.clear();
  for (let i = 0; i < things.length; i++) {
    const def = THING_ANIM_DEFS[things[i].type];
    if (!def) continue;
    const state = def.states[def.spawnState];
    // Monsters always get an animation state (even if tics=-1 for static spawn)
    const isMonster = def.deathState !== undefined;
    if (!state || (state.tics === -1 && !isMonster)) continue;
    thingAnimStates.set(i, {
      thingType: things[i].type,
      stateIdx: def.spawnState,
      tics: state.tics === -1 ? -1 : state.tics,
      sprite: state.sprite,
      frame: state.frame,
      mobjState: 'alive',
    });
  }
  console.log(`[anims] ${thingAnimStates.size} animated things initialized`);
}

/**
 * Action callback registry. AI functions register here so animations
 * can call them by name without circular imports.
 */
const actionCallbacks: Record<string, (thingIndex: number) => void> = {};

/** Register an action callback by name (called from enemy.ts on init) */
export function registerActionCallback(name: string, fn: (thingIndex: number) => void): void {
  actionCallbacks[name] = fn;
}

/**
 * Update thing animation states each tick.
 * Handles monster lifecycle: pain returns to alive/chasing, death reaches terminal.
 * Calls action callbacks on state entry.
 */
export function updateThingAnimations(): void {
  for (const [idx, anim] of thingAnimStates) {
    // Terminal state (tics = -1) — don't advance, but call action for A_Look
    if (anim.tics === -1) {
      // Call action every tick for terminal idle states (A_Look needs this)
      const def = THING_ANIM_DEFS[anim.thingType];
      if (def) {
        const state = def.states[anim.stateIdx];
        if (state.action && actionCallbacks[state.action]) {
          actionCallbacks[state.action](idx);
        }
      }
      continue;
    }

    anim.tics--;
    if (anim.tics <= 0) {
      const def = THING_ANIM_DEFS[anim.thingType];
      if (!def) continue;
      const nextIdx = def.states[anim.stateIdx].nextState;
      // Bounds check: if nextState is invalid, reset to spawnState
      if (nextIdx < 0 || nextIdx >= def.states.length) {
        anim.stateIdx = def.spawnState;
        const fallback = def.states[def.spawnState];
        anim.sprite = fallback.sprite;
        anim.frame = fallback.frame;
        anim.tics = fallback.tics;
        anim.mobjState = 'alive';
        continue;
      }
      anim.stateIdx = nextIdx;
      const nextState = def.states[nextIdx];
      anim.sprite = nextState.sprite;
      anim.frame = nextState.frame;

      if (nextState.tics === -1) {
        // Reached terminal state
        anim.tics = -1;
        if (anim.mobjState === 'dying') {
          anim.mobjState = 'dead';
        }
      } else {
        anim.tics = nextState.tics;
        // Pain returning → back to seeState if chasing, otherwise spawnState
        if (anim.mobjState === 'pain') {
          const returnIdx = (anim.mobjState === 'pain' && def.seeState !== undefined)
            ? def.seeState : def.spawnState;
          if (nextIdx === returnIdx || nextIdx < (def.painState ?? Infinity)) {
            anim.mobjState = 'chasing';
          }
        }
      }

      // Call action callback on state entry
      if (nextState.action && actionCallbacks[nextState.action]) {
        actionCallbacks[nextState.action](idx);
      }
    }
  }
}

// ============================================================
// Monster State Control — called from mobj.ts combat system
// ============================================================

/**
 * Switch a monster to its pain animation state.
 * Called when a monster takes non-lethal damage and pain chance succeeds.
 */
export function setMonsterPain(thingIndex: number, thingType: number): void {
  const def = THING_ANIM_DEFS[thingType];
  if (!def || def.painState === undefined) return;

  let anim = thingAnimStates.get(thingIndex);
  if (!anim) {
    // Create animation state if not yet tracked
    const state = def.states[def.painState];
    anim = {
      thingType,
      stateIdx: def.painState,
      tics: state.tics,
      sprite: state.sprite,
      frame: state.frame,
      mobjState: 'pain',
    };
    thingAnimStates.set(thingIndex, anim);
    return;
  }

  // Don't interrupt death animation
  if (anim.mobjState === 'dying' || anim.mobjState === 'dead') return;

  const state = def.states[def.painState];
  anim.stateIdx = def.painState;
  anim.tics = state.tics;
  anim.sprite = state.sprite;
  anim.frame = state.frame;
  anim.mobjState = 'pain';
}

/**
 * Switch a monster to its death (or xdeath) animation state.
 * Called when a monster is killed.
 * @param overkill true if health dropped below negative spawn health (gib)
 */
export function setMonsterDeath(thingIndex: number, thingType: number, overkill: boolean): void {
  const def = THING_ANIM_DEFS[thingType];
  if (!def) return;

  // Use xdeath if available and overkill, otherwise normal death
  const stateIdx = (overkill && def.xdeathState !== undefined)
    ? def.xdeathState
    : (def.deathState ?? def.spawnState);

  let anim = thingAnimStates.get(thingIndex);
  if (!anim) {
    const state = def.states[stateIdx];
    anim = {
      thingType,
      stateIdx,
      tics: state.tics,
      sprite: state.sprite,
      frame: state.frame,
      mobjState: 'dying',
    };
    thingAnimStates.set(thingIndex, anim);
    return;
  }

  const state = def.states[stateIdx];
  anim.stateIdx = stateIdx;
  anim.tics = state.tics;
  anim.sprite = state.sprite;
  anim.frame = state.frame;
  anim.mobjState = 'dying';
}

/**
 * Check if a monster's death animation has completed (reached terminal frame).
 */
export function isMonsterDead(thingIndex: number): boolean {
  const anim = thingAnimStates.get(thingIndex);
  return anim?.mobjState === 'dead';
}

/**
 * Get the animation definition for a thing type.
 * Used by mobj.ts to check painChance and dropItem.
 */
export function getThingAnimDef(thingType: number): ThingAnimDef | undefined {
  return THING_ANIM_DEFS[thingType];
}

/**
 * Get the current sprite name and frame for a thing.
 * Returns null if the thing has no animation (use static THING_INFO).
 */
export function getThingAnimFrame(thingIndex: number): { sprite: string; frame: number } | null {
  const anim = thingAnimStates.get(thingIndex);
  if (!anim) return null;
  return { sprite: anim.sprite, frame: anim.frame };
}

/** Get all thing animation states (for save) */
export function getThingAnimStates(): Map<number, ThingAnimState> {
  return thingAnimStates;
}

/** Restore thing animation states (for load) */
export function setThingAnimStates(states: Map<number, ThingAnimState>): void {
  thingAnimStates.clear();
  for (const [k, v] of states) thingAnimStates.set(k, v);
}

/**
 * Switch a monster's animation to a specific state index.
 * Used by AI to transition to seeState, meleeState, missileState, spawnState.
 */
export function setMonsterState(thingIndex: number, thingType: number, stateIdx: number, lifecycle: MobjLifecycle): void {
  const def = THING_ANIM_DEFS[thingType];
  if (!def || stateIdx >= def.states.length) return;

  let anim = thingAnimStates.get(thingIndex);
  if (!anim) {
    const state = def.states[stateIdx];
    anim = {
      thingType,
      stateIdx,
      tics: state.tics,
      sprite: state.sprite,
      frame: state.frame,
      mobjState: lifecycle,
    };
    thingAnimStates.set(thingIndex, anim);
  } else {
    // Don't interrupt death
    if (anim.mobjState === 'dying' || anim.mobjState === 'dead') return;

    const state = def.states[stateIdx];
    anim.stateIdx = stateIdx;
    anim.tics = state.tics;
    anim.sprite = state.sprite;
    anim.frame = state.frame;
    anim.mobjState = lifecycle;
  }

  // Call action on state entry
  const state = def.states[stateIdx];
  if (state.action && actionCallbacks[state.action]) {
    actionCallbacks[state.action](thingIndex);
  }
}

/** Get a thing's current animation state (for AI inspection) */
export function getThingAnimState(thingIndex: number): ThingAnimState | undefined {
  return thingAnimStates.get(thingIndex);
}
