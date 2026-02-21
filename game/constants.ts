// ============================================================
// Shared Game Constants
// Reference: p_local.h
// ============================================================

import { FRACBITS, FRACUNIT } from './math';

/** Player height in fixed-point (56 units) */
export const PLAYERHEIGHT = 56 << FRACBITS;

/** Melee attack range (64 units) */
export const MELEERANGE = 64 * FRACUNIT;

/** Missile attack range (32*64 units) */
export const MISSILERANGE = 32 * 64 * FRACUNIT;
