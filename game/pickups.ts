// ============================================================
// Item / Weapon Pickup System
// Reference: p_inter.c — P_TouchSpecialThing
// ============================================================
// When the player walks over a thing, this module handles:
//  1. Checking collision (radius overlap)
//  2. Applying the pickup effect (health, armor, ammo, weapon, key, powerup)
//  3. Marking the thing as removed so it stops rendering

import { FRACBITS, FRACUNIT } from './math';
import { MapThing } from '../src/map';

import { WeaponType, AmmoType, weaponinfo, MAX_AMMO, CLIP_AMMO } from './weapons';
import { PowerType, INVULNTICS, INVISTICS, IRONTICS, INFRATICS } from './player';
import { getDroppedItems, removeDroppedItem } from './mobj';
import { isDoubleAmmo } from './skill';
import { FX_Sound } from './effects';
import { Sfx } from './sounds';
import { addPlayerItem } from '../src/game/intermission';

// Touch radius for pickups (20 map units — matches DOOM's MELEERANGE check)
const PICKUP_RADIUS = 20 << FRACBITS;

// Maximum health/armor values
const MAXHEALTH = 200;
const MAXARMOR = 200;

/** Set of thing indices that have been picked up and should no longer render */
export const removedThings: Set<number> = new Set();

/** Clear removed things (level change) */
export function clearRemovedThings(): void {
  removedThings.clear();
}

/** Restore removed things from save data */
export function setRemovedThings(indices: number[]): void {
  removedThings.clear();
  for (const idx of indices) removedThings.add(idx);
}

/** Pickup result — what bonus flash / message to show */
interface PickupResult {
  picked: boolean;
  message?: string;
  sound?: Sfx;
}

/**
 * Check all map things for pickup collisions with the player.
 * Called each tick from the player's tick() method.
 */
export function checkPickups(
  player: {
    x: number; y: number; z: number;
    health: number; armor: number;
    ammo: number[]; maxammo: number[];
    weaponowned: boolean[];
    keys: boolean[];
    bonuscount: number;
    readyweapon: WeaponType;
    pendingweapon: WeaponType;
    powers: number[];
    message: string | null;
  },
  things: MapThing[]
): void {
  for (let i = 0; i < things.length; i++) {
    if (removedThings.has(i)) continue;
    const thing = things[i];

    // Skip non-pickup thing types
    if (!isPickupType(thing.type)) continue;

    // Check distance (simple radius overlap in XY plane)
    const dx = Math.abs(player.x - (thing.x << FRACBITS));
    const dy = Math.abs(player.y - (thing.y << FRACBITS));
    if (dx > PICKUP_RADIUS || dy > PICKUP_RADIUS) continue;

    // Try to pick up the item
    const result = touchSpecialThing(thing.type, player);
    if (result.picked) {
      removedThings.add(i);
      player.bonuscount = 6; // gold screen flash for 6 tics
      addPlayerItem();
      if (result.message) {
        player.message = result.message;
      }
      // Pickup sound
      FX_Sound(null, result.sound ?? Sfx.itemup);
    }
  }

  // Also check dropped items (weapons/ammo from killed monsters)
  const drops = getDroppedItems();
  for (let i = drops.length - 1; i >= 0; i--) {
    const drop = drops[i];
    if (!isPickupType(drop.thingType)) continue;

    const dx = Math.abs(player.x - drop.x);
    const dy = Math.abs(player.y - drop.y);
    if (dx > PICKUP_RADIUS || dy > PICKUP_RADIUS) continue;

    const result = touchSpecialThing(drop.thingType, player);
    if (result.picked) {
      removeDroppedItem(i);
      player.bonuscount = 6;
      if (result.message) {
        player.message = result.message;
      }
      FX_Sound(null, result.sound ?? Sfx.itemup);
    }
  }
}

/** Check if a thing type is a pickup (items, weapons, ammo, keys, powerups) */
function isPickupType(type: number): boolean {
  return PICKUP_EFFECTS.hasOwnProperty(type);
}

/**
 * Apply the effect of touching a special thing.
 * Mirrors P_TouchSpecialThing from p_inter.c.
 */
function touchSpecialThing(
  type: number,
  player: {
    health: number; armor: number;
    ammo: number[]; maxammo: number[];
    weaponowned: boolean[];
    keys: boolean[];
    readyweapon: WeaponType;
    pendingweapon: WeaponType;
    powers: number[];
  }
): PickupResult {
  const effect = PICKUP_EFFECTS[type];
  if (!effect) return { picked: false };
  return effect(player);
}

// ---- Helper functions ----

function giveHealth(player: { health: number }, amount: number, max: number): boolean {
  if (player.health >= max) return false;
  player.health = Math.min(player.health + amount, max);
  return true;
}

function giveArmor(player: { armor: number }, amount: number, max: number): boolean {
  if (player.armor >= max) return false;
  player.armor = Math.min(player.armor + amount, max);
  return true;
}

function giveAmmo(
  player: { ammo: number[]; maxammo: number[] },
  type: AmmoType,
  count: number
): boolean {
  if (type < 0) return false;
  if (player.ammo[type] >= player.maxammo[type]) return false;

  // Double ammo on Baby and Nightmare
  if (isDoubleAmmo()) count *= 2;

  player.ammo[type] = Math.min(player.ammo[type] + count, player.maxammo[type]);
  return true;
}

function giveWeapon(
  player: {
    weaponowned: boolean[];
    ammo: number[]; maxammo: number[];
    pendingweapon: WeaponType;
  },
  weapon: WeaponType
): boolean {
  const alreadyOwned = player.weaponowned[weapon];

  // Give the weapon
  player.weaponowned[weapon] = true;

  // Give ammo that comes with the weapon (clip amount)
  const ammoType = weaponinfo[weapon]?.ammo;
  let gaveSomething = !alreadyOwned;

  if (ammoType !== undefined && ammoType >= 0) {
    const clipAmount = CLIP_AMMO[ammoType] ?? 0;
    // Weapons give 2x clip amount on pickup
    if (giveAmmo(player, ammoType, clipAmount * 2)) {
      gaveSomething = true;
    }
  }

  if (!gaveSomething) return false; // already had weapon + full ammo

  // Auto-switch to new weapon if it's "better"
  if (!alreadyOwned) {
    player.pendingweapon = weapon;
  }

  return true;
}

function giveKey(player: { keys: boolean[] }, keyIdx: number): boolean {
  if (player.keys[keyIdx]) return false;
  player.keys[keyIdx] = true;
  return true;
}

// ============================================================
// Pickup Effects Table
// Maps thing type → function that applies the pickup effect
// ============================================================

type PickupFn = (player: {
  health: number; armor: number;
  ammo: number[]; maxammo: number[];
  weaponowned: boolean[];
  keys: boolean[];
  readyweapon: WeaponType;
  pendingweapon: WeaponType;
  powers: number[];
}) => PickupResult;

const PICKUP_EFFECTS: Record<number, PickupFn> = {
  // ---- Health ----
  // Stimpack (+10 health, max 100)
  2011: (p) => ({ picked: giveHealth(p, 10, 100), message: 'Picked up a stimpack.' }),
  // Medikit (+25 health, max 100)
  2012: (p) => ({ picked: giveHealth(p, 25, 100), message: 'Picked up a medikit.' }),
  // Health bonus (+1 health, max 200)
  2014: (p) => ({ picked: giveHealth(p, 1, MAXHEALTH), message: 'Picked up a health bonus.' }),
  // Soulsphere (+100 health, max 200)
  2013: (p) => ({ picked: giveHealth(p, 100, MAXHEALTH), message: 'Supercharge!' }),

  // ---- Armor ----
  // Green armor (set to 100 if less)
  2018: (p) => {
    if (p.armor >= 100) return { picked: false };
    p.armor = 100;
    return { picked: true, message: 'Picked up the armor.' };
  },
  // Blue armor (set to 200 if less)
  2019: (p) => {
    if (p.armor >= 200) return { picked: false };
    p.armor = 200;
    return { picked: true, message: 'Picked up the MegaArmor!' };
  },
  // Armor bonus (+1 armor, max 200)
  2015: (p) => ({ picked: giveArmor(p, 1, MAXARMOR), message: 'Picked up an armor bonus.' }),

  // ---- Keys ----
  // Blue keycard
  6:  (p) => ({ picked: giveKey(p, 0), message: 'Picked up a blue keycard.' }),
  // Yellow keycard
  5:  (p) => ({ picked: giveKey(p, 1), message: 'Picked up a yellow keycard.' }),
  // Red keycard
  13: (p) => ({ picked: giveKey(p, 2), message: 'Picked up a red keycard.' }),
  // Blue skull key
  39: (p) => ({ picked: giveKey(p, 3), message: 'Picked up a blue skull key.' }),
  // Yellow skull key
  40: (p) => ({ picked: giveKey(p, 4), message: 'Picked up a yellow skull key.' }),
  // Red skull key
  38: (p) => ({ picked: giveKey(p, 5), message: 'Picked up a red skull key.' }),

  // ---- Ammo ----
  // Clip (10 bullets)
  2007: (p) => ({ picked: giveAmmo(p, AmmoType.clip, CLIP_AMMO[AmmoType.clip]), message: 'Picked up a clip.' }),
  // Box of bullets (50)
  2048: (p) => ({ picked: giveAmmo(p, AmmoType.clip, CLIP_AMMO[AmmoType.clip] * 5), message: 'Picked up a box of bullets.' }),
  // Shotgun shells (4)
  2008: (p) => ({ picked: giveAmmo(p, AmmoType.shell, CLIP_AMMO[AmmoType.shell]), message: 'Picked up 4 shotgun shells.' }),
  // Box of shells (20)
  2049: (p) => ({ picked: giveAmmo(p, AmmoType.shell, CLIP_AMMO[AmmoType.shell] * 5), message: 'Picked up a box of shotgun shells.' }),
  // Rocket
  2010: (p) => ({ picked: giveAmmo(p, AmmoType.misl, CLIP_AMMO[AmmoType.misl]), message: 'Picked up a rocket.' }),
  // Box of rockets (5)
  2046: (p) => ({ picked: giveAmmo(p, AmmoType.misl, CLIP_AMMO[AmmoType.misl] * 5), message: 'Picked up a box of rockets.' }),
  // Cell charge (20)
  2047: (p) => ({ picked: giveAmmo(p, AmmoType.cell, CLIP_AMMO[AmmoType.cell]), message: 'Picked up an energy cell.' }),
  // Cell charge pack (100)
  17:   (p) => ({ picked: giveAmmo(p, AmmoType.cell, CLIP_AMMO[AmmoType.cell] * 5), message: 'Picked up an energy cell pack.' }),
  // Backpack (doubles max ammo, gives one clip of each)
  8: (p) => {
    // Double max ammo
    for (let a = 0; a < AmmoType.NUMAMMO; a++) {
      p.maxammo[a] = (MAX_AMMO[a] ?? 0) * 2;
    }
    // Give one clip of each ammo type
    giveAmmo(p, AmmoType.clip, CLIP_AMMO[AmmoType.clip]);
    giveAmmo(p, AmmoType.shell, CLIP_AMMO[AmmoType.shell]);
    giveAmmo(p, AmmoType.cell, CLIP_AMMO[AmmoType.cell]);
    giveAmmo(p, AmmoType.misl, CLIP_AMMO[AmmoType.misl]);
    return { picked: true, message: 'Picked up a backpack full of ammo!' };
  },

  // ---- Weapons ----
  // Shotgun
  2001: (p) => ({ picked: giveWeapon(p, WeaponType.shotgun), message: 'You got the shotgun!', sound: Sfx.wpnup }),
  // Super shotgun (DOOM2)
  82:   (p) => ({ picked: giveWeapon(p, WeaponType.supershotgun), message: 'You got the super shotgun!', sound: Sfx.wpnup }),
  // Chaingun
  2002: (p) => ({ picked: giveWeapon(p, WeaponType.chaingun), message: 'You got the chaingun!', sound: Sfx.wpnup }),
  // Rocket launcher
  2003: (p) => ({ picked: giveWeapon(p, WeaponType.missile), message: 'A rocket launcher!', sound: Sfx.wpnup }),
  // Plasma rifle
  2004: (p) => ({ picked: giveWeapon(p, WeaponType.plasma), message: 'You got the plasma rifle!', sound: Sfx.wpnup }),
  // BFG9000
  2006: (p) => ({ picked: giveWeapon(p, WeaponType.bfg), message: 'You got the BFG9000!  Oh, yes.', sound: Sfx.wpnup }),
  // Chainsaw
  2005: (p) => ({ picked: giveWeapon(p, WeaponType.chainsaw), message: 'A chainsaw!  Find some meat!', sound: Sfx.wpnup }),

  // ---- Powerups ----
  // Berserk (full health + berserk mode)
  2023: (p) => {
    giveHealth(p, 100, 100); // always tops up to 100
    p.powers[PowerType.strength] = 1; // starts at 1, counts up each tick
    return { picked: true, message: 'Berserk!', sound: Sfx.getpow };
  },
  // Invulnerability
  2022: (p) => {
    p.powers[PowerType.invulnerability] = INVULNTICS;
    return { picked: true, message: 'Invulnerability!', sound: Sfx.getpow };
  },
  // Partial invisibility
  2024: (p) => {
    p.powers[PowerType.invisibility] = INVISTICS;
    return { picked: true, message: 'Partial Invisibility', sound: Sfx.getpow };
  },
  // Radiation suit
  2025: (p) => {
    p.powers[PowerType.ironfeet] = IRONTICS;
    return { picked: true, message: 'Radiation Shielding Suit', sound: Sfx.getpow };
  },
  // Computer area map
  2026: (p) => {
    p.powers[PowerType.allmap] = 1;
    return { picked: true, message: 'Computer Area Map' };
  },
  // Light amplification goggles
  2045: (p) => {
    p.powers[PowerType.infrared] = INFRATICS;
    return { picked: true, message: 'Light Amplification Visor' };
  },
};
