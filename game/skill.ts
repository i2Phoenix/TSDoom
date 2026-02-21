// ============================================================
// Skill / Difficulty Level System
// Reference: doomdef.h, g_game.c — skill levels and their effects
// ============================================================

import { GameInstance } from './game-instance';

/**
 * DOOM skill levels (matches original enum order).
 * Maps directly to save-game byte value.
 */
export enum SkillLevel {
  sk_baby = 0,       // I'm Too Young to Die
  sk_easy = 1,       // Hey, Not Too Rough
  sk_medium = 2,     // Hurt Me Plenty
  sk_hard = 3,       // Ultra-Violence
  sk_nightmare = 4,  // Nightmare!
}

// ---- Setters ----
export function setGameSkill(skill: SkillLevel, gi: GameInstance): void {
  gi.gameskill = skill;
  gi.fastMonsters = skill === SkillLevel.sk_nightmare;
}

// ============================================================
// Skill-dependent gameplay queries
// ============================================================

/**
 * Double ammo on skills 1 (Baby) and 5 (Nightmare).
 * Original DOOM: if (gameskill == sk_baby || gameskill == sk_nightmare)
 */
export function isDoubleAmmo(gi: GameInstance): boolean {
  const gameskill = gi.gameskill;
  return gameskill === SkillLevel.sk_baby || gameskill === SkillLevel.sk_nightmare;
}

/**
 * Damage multiplier applied to player damage.
 * Baby: 50% damage. All others: 100%.
 * Original DOOM: damage >>= 1 when sk_baby
 */
export function getDamageMultiplier(gi: GameInstance): number {
  return gi.gameskill === SkillLevel.sk_baby ? 0.5 : 1.0;
}

/**
 * Fast monsters — Nightmare or -fast param.
 * Affects monster reaction time and movement speed.
 */
export function isFastMonsters(gi: GameInstance): boolean {
  return gi.fastMonsters;
}

/**
 * Monster respawn — Nightmare only (~12 seconds).
 * Stub: monster AI will check this.
 */
export function isRespawnMonsters(gi: GameInstance): boolean {
  return gi.gameskill === SkillLevel.sk_nightmare;
}

/**
 * Cheats are completely disabled on Nightmare.
 * Original DOOM: checks gameskill in ST_Responder.
 */
export function areCheatsDisabled(gi: GameInstance): boolean {
  return gi.gameskill === SkillLevel.sk_nightmare;
}

/**
 * Check whether a thing should spawn on the current skill.
 * MapThing.options bits 0–2 encode difficulty presence:
 *   bit 0 (mask 1): skills 1 & 2 (Baby, Easy)
 *   bit 1 (mask 2): skill 3 (Medium)
 *   bit 2 (mask 4): skills 4 & 5 (Hard, Nightmare)
 *
 * A thing spawns only if its corresponding bit is set.
 * Things with options === 0 (no bits) are never spawned.
 */
export function shouldSpawnThing(options: number, gi: GameInstance): boolean {
  const gameskill = gi.gameskill;
  switch (gameskill) {
    case SkillLevel.sk_baby:
    case SkillLevel.sk_easy:
      return (options & 1) !== 0;
    case SkillLevel.sk_medium:
      return (options & 2) !== 0;
    case SkillLevel.sk_hard:
    case SkillLevel.sk_nightmare:
      return (options & 4) !== 0;
    default:
      return true;
  }
}

// ---- Skill name labels (for menu / HUD) ----
export const SKILL_NAMES: string[] = [
  "I'm too young to die.",
  'Hey, not too rough.',
  'Hurt me plenty.',
  'Ultra-Violence.',
  'Nightmare!',
];
