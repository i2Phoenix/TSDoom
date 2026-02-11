// ============================================================
// Monster Object Info Table
// Reference: info.h (mobjtype_t), info.c (mobjinfo[])
// Only includes monsters/projectiles relevant for AI system
// ============================================================

import { FRACUNIT } from '../math';

// --- MF_* flags from p_mobj.h ---
export const MF_SPECIAL      = 0x0001;
export const MF_SOLID         = 0x0002;
export const MF_SHOOTABLE     = 0x0004;
export const MF_NOSECTOR      = 0x0008;
export const MF_NOBLOCKMAP    = 0x0010;
export const MF_AMBUSH        = 0x0020;
export const MF_JUSTHIT       = 0x0040;
export const MF_JUSTATTACKED  = 0x0080;
export const MF_SPAWNCEILING  = 0x0100;
export const MF_NOGRAVITY     = 0x0200;
export const MF_DROPOFF       = 0x0400;
export const MF_PICKUP        = 0x0800;
export const MF_NOCLIP        = 0x1000;
export const MF_SLIDE         = 0x2000;
export const MF_FLOAT         = 0x4000;
export const MF_TELEPORT      = 0x8000;
export const MF_MISSILE       = 0x10000;
export const MF_DROPPED       = 0x20000;
export const MF_SHADOW        = 0x40000;
export const MF_NOBLOOD       = 0x80000;
export const MF_CORPSE        = 0x100000;
export const MF_INFLOAT       = 0x200000;
export const MF_COUNTKILL     = 0x400000;
export const MF_COUNTITEM     = 0x800000;
export const MF_SKULLFLY      = 0x1000000;
export const MF_NOTDMATCH     = 0x2000000;

// --- Monster type enum (from info.h, AI-relevant subset) ---
export enum MT {
  MT_PLAYER = 0,
  MT_POSSESSED,    // Zombieman
  MT_SHOTGUY,      // Shotgun Guy
  MT_VILE,         // Arch-vile
  MT_FIRE,         // Arch-vile fire
  MT_UNDEAD,       // Revenant
  MT_TRACER,       // Revenant missile
  MT_SMOKE,        // Revenant missile smoke trail
  MT_FATSO,        // Mancubus
  MT_FATSHOT,      // Mancubus fireball
  MT_CHAINGUY,     // Chaingunner
  MT_TROOP,        // Imp
  MT_SERGEANT,     // Demon (Pinky)
  MT_SHADOWS,      // Spectre
  MT_HEAD,         // Cacodemon
  MT_BRUISER,      // Baron of Hell
  MT_BRUISERSHOT,  // Baron/Knight fireball
  MT_KNIGHT,       // Hell Knight
  MT_SKULL,        // Lost Soul
  MT_SPIDER,       // Spider Mastermind
  MT_BABY,         // Arachnotron
  MT_CYBORG,       // Cyberdemon
  MT_PAIN,         // Pain Elemental
  MT_WOLFSS,       // Wolf SS
  MT_KEEN,         // Commander Keen
  MT_BOSSBRAIN,    // Icon of Sin brain
  MT_BOSSSPIT,     // Icon of Sin eye
  MT_BOSSTARGET,   // Spawn target
  MT_SPAWNSHOT,    // Spawn shot
  MT_SPAWNFIRE,    // Spawn fire
  MT_BARREL,       // Barrel
  MT_TROOPSHOT,    // Imp fireball
  MT_HEADSHOT,     // Cacodemon fireball
  MT_ROCKET,       // Rocket
  MT_PLASMA,       // Plasma
  MT_BFG,          // BFG shot
  MT_ARACHPLAZ,    // Arachnotron plasma
  MT_PUFF,         // Bullet puff
  MT_BLOOD,        // Blood splat
}

// --- Mobjinfo interface ---
export interface MobjInfo {
  doomednum: number;    // DoomEd thing type (-1 = not placed)
  spawnhealth: number;
  reactiontime: number;
  speed: number;        // movement speed (map units/tic)
  radius: number;       // fixed_t
  height: number;       // fixed_t
  mass: number;
  damage: number;       // for missiles: direct impact damage
  painchance: number;   // 0-256
  flags: number;        // MF_* flags
  // State indicators (boolean: does this type have the state?)
  hasSeeState: boolean;
  hasMeleeState: boolean;
  hasMissileState: boolean;
  hasRaiseState: boolean;
}

// --- DoomEd type → MT mapping ---
const doomedToMT = new Map<number, MT>();

// --- Mobjinfo table (from info.c) ---
// Only monster and projectile types needed for AI
export const mobjinfo: Record<number, MobjInfo> = {
  [MT.MT_PLAYER]: {
    doomednum: -1, spawnhealth: 100, reactiontime: 0, speed: 0,
    radius: 16 * FRACUNIT, height: 56 * FRACUNIT, mass: 100, damage: 0,
    painchance: 255, flags: MF_SOLID | MF_SHOOTABLE | MF_DROPOFF | MF_PICKUP | MF_NOTDMATCH,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: false,
  },
  [MT.MT_POSSESSED]: {
    doomednum: 3004, spawnhealth: 20, reactiontime: 8, speed: 8,
    radius: 20 * FRACUNIT, height: 56 * FRACUNIT, mass: 100, damage: 0,
    painchance: 200, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_SHOTGUY]: {
    doomednum: 9, spawnhealth: 30, reactiontime: 8, speed: 8,
    radius: 20 * FRACUNIT, height: 56 * FRACUNIT, mass: 100, damage: 0,
    painchance: 170, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_VILE]: {
    doomednum: 64, spawnhealth: 700, reactiontime: 8, speed: 15,
    radius: 20 * FRACUNIT, height: 56 * FRACUNIT, mass: 500, damage: 0,
    painchance: 10, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: false,
  },
  [MT.MT_FIRE]: {
    doomednum: -1, spawnhealth: 1000, reactiontime: 8, speed: 0,
    radius: 20 * FRACUNIT, height: 16 * FRACUNIT, mass: 100, damage: 0,
    painchance: 0, flags: MF_NOBLOCKMAP | MF_NOGRAVITY,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_UNDEAD]: {
    doomednum: 66, spawnhealth: 300, reactiontime: 8, speed: 10,
    radius: 20 * FRACUNIT, height: 56 * FRACUNIT, mass: 500, damage: 0,
    painchance: 100, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: true, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_TRACER]: {
    doomednum: -1, spawnhealth: 1000, reactiontime: 8, speed: 10 * FRACUNIT,
    radius: 11 * FRACUNIT, height: 8 * FRACUNIT, mass: 100, damage: 10,
    painchance: 0, flags: MF_NOBLOCKMAP | MF_MISSILE | MF_DROPOFF | MF_NOGRAVITY,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_SMOKE]: {
    doomednum: -1, spawnhealth: 1000, reactiontime: 8, speed: 0,
    radius: 20 * FRACUNIT, height: 16 * FRACUNIT, mass: 100, damage: 0,
    painchance: 0, flags: MF_NOBLOCKMAP | MF_NOGRAVITY,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_FATSO]: {
    doomednum: 67, spawnhealth: 600, reactiontime: 8, speed: 8,
    radius: 48 * FRACUNIT, height: 64 * FRACUNIT, mass: 1000, damage: 0,
    painchance: 80, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_FATSHOT]: {
    doomednum: -1, spawnhealth: 1000, reactiontime: 8, speed: 20 * FRACUNIT,
    radius: 6 * FRACUNIT, height: 8 * FRACUNIT, mass: 100, damage: 8,
    painchance: 0, flags: MF_NOBLOCKMAP | MF_MISSILE | MF_DROPOFF | MF_NOGRAVITY,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_CHAINGUY]: {
    doomednum: 65, spawnhealth: 70, reactiontime: 8, speed: 8,
    radius: 20 * FRACUNIT, height: 56 * FRACUNIT, mass: 100, damage: 0,
    painchance: 170, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_TROOP]: {
    doomednum: 3001, spawnhealth: 60, reactiontime: 8, speed: 8,
    radius: 20 * FRACUNIT, height: 56 * FRACUNIT, mass: 100, damage: 0,
    painchance: 200, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: true, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_SERGEANT]: {
    doomednum: 3002, spawnhealth: 150, reactiontime: 8, speed: 10,
    radius: 30 * FRACUNIT, height: 56 * FRACUNIT, mass: 400, damage: 0,
    painchance: 180, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: true, hasMissileState: false, hasRaiseState: true,
  },
  [MT.MT_SHADOWS]: {
    doomednum: 58, spawnhealth: 150, reactiontime: 8, speed: 10,
    radius: 30 * FRACUNIT, height: 56 * FRACUNIT, mass: 400, damage: 0,
    painchance: 180, flags: MF_SOLID | MF_SHOOTABLE | MF_SHADOW | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: true, hasMissileState: false, hasRaiseState: true,
  },
  [MT.MT_HEAD]: {
    doomednum: 3005, spawnhealth: 400, reactiontime: 8, speed: 8,
    radius: 31 * FRACUNIT, height: 56 * FRACUNIT, mass: 400, damage: 0,
    painchance: 128, flags: MF_SOLID | MF_SHOOTABLE | MF_FLOAT | MF_NOGRAVITY | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_BRUISER]: {
    doomednum: 3003, spawnhealth: 1000, reactiontime: 8, speed: 8,
    radius: 24 * FRACUNIT, height: 64 * FRACUNIT, mass: 1000, damage: 0,
    painchance: 50, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: true, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_BRUISERSHOT]: {
    doomednum: -1, spawnhealth: 1000, reactiontime: 8, speed: 15 * FRACUNIT,
    radius: 6 * FRACUNIT, height: 8 * FRACUNIT, mass: 100, damage: 8,
    painchance: 0, flags: MF_NOBLOCKMAP | MF_MISSILE | MF_DROPOFF | MF_NOGRAVITY,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_KNIGHT]: {
    doomednum: 69, spawnhealth: 500, reactiontime: 8, speed: 8,
    radius: 24 * FRACUNIT, height: 64 * FRACUNIT, mass: 1000, damage: 0,
    painchance: 50, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: true, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_SKULL]: {
    doomednum: 3006, spawnhealth: 100, reactiontime: 8, speed: 8,
    radius: 16 * FRACUNIT, height: 56 * FRACUNIT, mass: 50, damage: 3,
    painchance: 256, flags: MF_SOLID | MF_SHOOTABLE | MF_FLOAT | MF_NOGRAVITY,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: false,
  },
  [MT.MT_SPIDER]: {
    doomednum: 7, spawnhealth: 3000, reactiontime: 8, speed: 12,
    radius: 128 * FRACUNIT, height: 100 * FRACUNIT, mass: 1000, damage: 0,
    painchance: 40, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: false,
  },
  [MT.MT_BABY]: {
    doomednum: 68, spawnhealth: 500, reactiontime: 8, speed: 12,
    radius: 64 * FRACUNIT, height: 64 * FRACUNIT, mass: 600, damage: 0,
    painchance: 128, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_CYBORG]: {
    doomednum: 16, spawnhealth: 4000, reactiontime: 8, speed: 16,
    radius: 40 * FRACUNIT, height: 110 * FRACUNIT, mass: 1000, damage: 0,
    painchance: 20, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: false,
  },
  [MT.MT_PAIN]: {
    doomednum: 71, spawnhealth: 400, reactiontime: 8, speed: 8,
    radius: 31 * FRACUNIT, height: 56 * FRACUNIT, mass: 400, damage: 0,
    painchance: 128, flags: MF_SOLID | MF_SHOOTABLE | MF_FLOAT | MF_NOGRAVITY | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_WOLFSS]: {
    doomednum: 84, spawnhealth: 50, reactiontime: 8, speed: 8,
    radius: 20 * FRACUNIT, height: 56 * FRACUNIT, mass: 100, damage: 0,
    painchance: 170, flags: MF_SOLID | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: true, hasMeleeState: false, hasMissileState: true, hasRaiseState: true,
  },
  [MT.MT_KEEN]: {
    doomednum: 72, spawnhealth: 100, reactiontime: 8, speed: 0,
    radius: 16 * FRACUNIT, height: 72 * FRACUNIT, mass: 10000000, damage: 0,
    painchance: 256, flags: MF_SOLID | MF_SPAWNCEILING | MF_NOGRAVITY | MF_SHOOTABLE | MF_COUNTKILL,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_BOSSBRAIN]: {
    doomednum: 88, spawnhealth: 250, reactiontime: 8, speed: 0,
    radius: 16 * FRACUNIT, height: 16 * FRACUNIT, mass: 10000000, damage: 0,
    painchance: 255, flags: MF_SOLID | MF_SHOOTABLE,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_BOSSSPIT]: {
    doomednum: 89, spawnhealth: 1000, reactiontime: 8, speed: 0,
    radius: 20 * FRACUNIT, height: 32 * FRACUNIT, mass: 100, damage: 0,
    painchance: 0, flags: MF_NOBLOCKMAP | MF_NOSECTOR,
    hasSeeState: true, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_BOSSTARGET]: {
    doomednum: 87, spawnhealth: 1000, reactiontime: 8, speed: 0,
    radius: 20 * FRACUNIT, height: 32 * FRACUNIT, mass: 100, damage: 0,
    painchance: 0, flags: MF_NOBLOCKMAP | MF_NOSECTOR,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_BARREL]: {
    doomednum: 2035, spawnhealth: 20, reactiontime: 8, speed: 0,
    radius: 10 * FRACUNIT, height: 42 * FRACUNIT, mass: 100, damage: 0,
    painchance: 0, flags: MF_SOLID | MF_SHOOTABLE | MF_NOBLOOD,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_TROOPSHOT]: {
    doomednum: -1, spawnhealth: 1000, reactiontime: 8, speed: 10 * FRACUNIT,
    radius: 6 * FRACUNIT, height: 8 * FRACUNIT, mass: 100, damage: 3,
    painchance: 0, flags: MF_NOBLOCKMAP | MF_MISSILE | MF_DROPOFF | MF_NOGRAVITY,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_HEADSHOT]: {
    doomednum: -1, spawnhealth: 1000, reactiontime: 8, speed: 10 * FRACUNIT,
    radius: 6 * FRACUNIT, height: 8 * FRACUNIT, mass: 100, damage: 5,
    painchance: 0, flags: MF_NOBLOCKMAP | MF_MISSILE | MF_DROPOFF | MF_NOGRAVITY,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
  [MT.MT_ARACHPLAZ]: {
    doomednum: -1, spawnhealth: 1000, reactiontime: 8, speed: 25 * FRACUNIT,
    radius: 13 * FRACUNIT, height: 8 * FRACUNIT, mass: 100, damage: 5,
    painchance: 0, flags: MF_NOBLOCKMAP | MF_MISSILE | MF_DROPOFF | MF_NOGRAVITY,
    hasSeeState: false, hasMeleeState: false, hasMissileState: false, hasRaiseState: false,
  },
};

// --- Build doomednum → MT lookup ---
for (const [mtStr, info] of Object.entries(mobjinfo)) {
  const mt = Number(mtStr);
  if (info.doomednum > 0) {
    doomedToMT.set(info.doomednum, mt);
  }
}

/** Look up MT type from DoomEd thing type number */
export function getMTForDoomedNum(doomednum: number): MT | undefined {
  return doomedToMT.get(doomednum);
}

/** Check if a given MT type is a monster (has AI states) */
export function isMonsterType(mt: MT): boolean {
  const info = mobjinfo[mt];
  return info !== undefined && info.hasSeeState && (info.flags & MF_SHOOTABLE) !== 0;
}
