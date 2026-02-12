// ============================================================
// Cheat Code System
// Reference: st_stuff.c / m_cheat.c — cheat code detection & effects
// ============================================================
//
// How it works:
//   1. Every keydown event feeds a character into a circular buffer
//   2. After each character, all cheat sequences are checked against
//      the tail of the buffer
//   3. On match, the cheat effect is applied and a HUD message shown
//
// IDBEHOLD is two-stage: first "idbehold", then a single letter (R/I/V/A/L/S)

import { WeaponType, AmmoType, MAX_AMMO } from './weapons';
import { PowerType, INVULNTICS, INVISTICS, IRONTICS, INFRATICS } from './player';
import { setGameAction, setPendingWarpMap, GameAction } from './gamestate';
import { FRACBITS } from '../math';
import { areCheatsDisabled } from './skill';
import { FX_Music } from '../../game/effects';
import { Music } from '../../game/sounds';

// ---- Cheat flags (bitfield on Player.cheats) ----
export const CF_GODMODE = 1;
export const CF_NOCLIP  = 2;

// ---- Key buffer ----
const BUFFER_SIZE = 32;
const keyBuffer: string[] = new Array(BUFFER_SIZE).fill('');
let bufferPos = 0;

// ---- IDBEHOLD state ----
let awaitingBeholdKey = false;

// ---- Player interface (minimal subset needed for cheats) ----
export interface CheatPlayer {
  health: number;
  armor: number;
  armortype: number;
  keys: boolean[];
  ammo: number[];
  maxammo: number[];
  weaponowned: boolean[];
  pendingweapon: WeaponType;
  powers: number[];
  cheats: number;
  message: string | null;
  x: number;
  y: number;
  z: number;
  angle: number;
}

// ---- Cheat definitions ----
interface CheatDef {
  sequence: string;
  handler: (player: CheatPlayer, extra?: string) => void;
  /** If true, the sequence is a prefix and extra chars are captured */
  paramCount?: number;
}

const cheats: CheatDef[] = [
  // ---- IDDQD — God Mode ----
  {
    sequence: 'iddqd',
    handler: (p) => {
      p.cheats ^= CF_GODMODE;
      if (p.cheats & CF_GODMODE) {
        p.health = 100;
        p.message = 'Degreelessness Mode ON';
      } else {
        p.message = 'Degreelessness Mode OFF';
      }
    },
  },

  // ---- IDKFA — All weapons, max ammo, 200% armor, all keys ----
  {
    sequence: 'idkfa',
    handler: (p) => {
      p.armortype = 2;
      p.armor = 200;
      // Give all weapons
      for (let i = 0; i < WeaponType.NUMWEAPONS; i++) {
        p.weaponowned[i] = true;
      }
      // Max ammo
      for (let i = 0; i < AmmoType.NUMAMMO; i++) {
        p.maxammo[i] = (MAX_AMMO[i] ?? 0) * 2; // backpack doubled
        p.ammo[i] = p.maxammo[i];
      }
      // All keys
      for (let i = 0; i < 6; i++) {
        p.keys[i] = true;
      }
      p.message = 'Very Happy Ammo Added';
    },
  },

  // ---- IDFA — All weapons, max ammo, 200% armor (no keys) ----
  {
    sequence: 'idfa',
    handler: (p) => {
      p.armortype = 2;
      p.armor = 200;
      for (let i = 0; i < WeaponType.NUMWEAPONS; i++) {
        p.weaponowned[i] = true;
      }
      for (let i = 0; i < AmmoType.NUMAMMO; i++) {
        p.maxammo[i] = (MAX_AMMO[i] ?? 0) * 2;
        p.ammo[i] = p.maxammo[i];
      }
      p.message = 'Ammo (No Keys) Added';
    },
  },

  // ---- IDSPISPOPD — Noclip (Doom 1) ----
  {
    sequence: 'idspispopd',
    handler: (p) => {
      p.cheats ^= CF_NOCLIP;
      p.message = (p.cheats & CF_NOCLIP)
        ? 'No Clipping Mode ON'
        : 'No Clipping Mode OFF';
    },
  },

  // ---- IDCLIP — Noclip (Doom 2) ----
  {
    sequence: 'idclip',
    handler: (p) => {
      p.cheats ^= CF_NOCLIP;
      p.message = (p.cheats & CF_NOCLIP)
        ? 'No Clipping Mode ON'
        : 'No Clipping Mode OFF';
    },
  },

  // ---- IDCHOPPERS — Give chainsaw ----
  {
    sequence: 'idchoppers',
    handler: (p) => {
      p.weaponowned[WeaponType.chainsaw] = true;
      p.pendingweapon = WeaponType.chainsaw;
      p.message = '... Strstrings this chainsaw got a lot of ...';
    },
  },

  // ---- IDBEHOLD — Power-up toggle (prefix, needs one more key) ----
  {
    sequence: 'idbehold',
    handler: (_p) => {
      awaitingBeholdKey = true;
      _p.message = 'inVuln, Str, Inviso, Rad, Allmap, or Lite-amp';
    },
  },

  // ---- IDMYPOS — Show position ----
  {
    sequence: 'idmypos',
    handler: (p) => {
      const x = (p.x >> FRACBITS).toString(16);
      const y = (p.y >> FRACBITS).toString(16);
      const ang = Math.round((p.angle / 0x100000000) * 360);
      p.message = `ang=0x${ang.toString(16)} (${ang}) x=0x${x} y=0x${y}`;
    },
  },

  // ---- IDCLEV## — Level warp (2 digit parameter) ----
  {
    sequence: 'idclev',
    paramCount: 2,
    handler: (_p, extra) => {
      if (!extra || extra.length < 2) return;
      const d1 = parseInt(extra[0]);
      const d2 = parseInt(extra[1]);
      if (isNaN(d1) || isNaN(d2)) return;

      // Build map name: E#M# for episode maps, MAP## for Doom 2
      // Since this is Doom 1 (DOOM.WAD), use E#M# format
      const mapName = `E${d1}M${d2}`;
      setPendingWarpMap(mapName);
      setGameAction(GameAction.ga_warp);
      _p.message = null; // message will be hidden by wipe
      console.log(`[cheats] IDCLEV: warping to ${mapName}`);
    },
  },

  // ---- IDMUS## — Change music ----
  {
    sequence: 'idmus',
    paramCount: 2,
    handler: (p, extra) => {
      if (!extra || extra.length < 2) return;
      const d1 = parseInt(extra[0]);
      const d2 = parseInt(extra[1]);
      if (isNaN(d1) || isNaN(d2)) return;

      // Doom I: digits are episode and map → music index = (ep-1)*9 + map
      const musIdx = (d1 - 1) * 9 + d2;
      if (musIdx < 1 || musIdx >= Music.NUMMUSIC) {
        p.message = 'IMPOSSIBLE SELECTION';
        return;
      }
      FX_Music(musIdx, true);
      p.message = 'Music Change';
    },
  },
];

/**
 * Handle IDBEHOLD follow-up key.
 * Called when awaitingBeholdKey is true and a new key arrives.
 */
function handleBeholdKey(char: string, player: CheatPlayer): boolean {
  awaitingBeholdKey = false;
  const c = char.toLowerCase();

  switch (c) {
    case 'v': // inVulnerability
      player.powers[PowerType.invulnerability] =
        player.powers[PowerType.invulnerability] ? 0 : INVULNTICS;
      player.message = 'Invulnerability ' +
        (player.powers[PowerType.invulnerability] ? 'ON' : 'OFF');
      return true;
    case 's': // Strength (Berserk)
      player.powers[PowerType.strength] =
        player.powers[PowerType.strength] ? 0 : 1;
      player.message = 'Berserk ' +
        (player.powers[PowerType.strength] ? 'ON' : 'OFF');
      return true;
    case 'i': // Invisibility
      player.powers[PowerType.invisibility] =
        player.powers[PowerType.invisibility] ? 0 : INVISTICS;
      player.message = 'Invisibility ' +
        (player.powers[PowerType.invisibility] ? 'ON' : 'OFF');
      return true;
    case 'r': // Radiation suit
      player.powers[PowerType.ironfeet] =
        player.powers[PowerType.ironfeet] ? 0 : IRONTICS;
      player.message = 'Radiation Shielding Suit ' +
        (player.powers[PowerType.ironfeet] ? 'ON' : 'OFF');
      return true;
    case 'a': // Allmap
      player.powers[PowerType.allmap] =
        player.powers[PowerType.allmap] ? 0 : 1;
      player.message = 'Computer Area Map ' +
        (player.powers[PowerType.allmap] ? 'ON' : 'OFF');
      return true;
    case 'l': // Lite-amp
      player.powers[PowerType.infrared] =
        player.powers[PowerType.infrared] ? 0 : INFRATICS;
      player.message = 'Light Amplification Visor ' +
        (player.powers[PowerType.infrared] ? 'ON' : 'OFF');
      return true;
    default:
      return false;
  }
}

// ---- Parameterized cheat tracking ----
// When a cheat with paramCount is partially matched (sequence found),
// we accumulate the next N characters as parameters.
let pendingParamCheat: CheatDef | null = null;
let pendingParamChars = '';
let pendingParamPlayer: CheatPlayer | null = null;

/**
 * Feed a typed character into the cheat buffer and check for matches.
 * Called from the keydown handler in main.ts.
 *
 * @param char The typed character (e.key from KeyboardEvent)
 * @param player The current player
 * @returns true if a cheat was activated (to optionally suppress input)
 */
export function feedCheatKey(char: string, player: CheatPlayer): boolean {
  // Only single printable characters
  if (char.length !== 1) return false;

  // Cheats are disabled on Nightmare
  if (areCheatsDisabled()) return false;

  const lc = char.toLowerCase();

  // Handle IDBEHOLD follow-up
  if (awaitingBeholdKey) {
    return handleBeholdKey(lc, player);
  }

  // Handle parameterized cheat accumulation
  if (pendingParamCheat && pendingParamPlayer) {
    pendingParamChars += lc;
    if (pendingParamChars.length >= (pendingParamCheat.paramCount ?? 0)) {
      pendingParamCheat.handler(pendingParamPlayer, pendingParamChars);
      pendingParamCheat = null;
      pendingParamChars = '';
      pendingParamPlayer = null;
      return true;
    }
    return false; // still accumulating
  }

  // Push to buffer
  keyBuffer[bufferPos] = lc;
  bufferPos = (bufferPos + 1) % BUFFER_SIZE;

  // Check all cheats against buffer tail
  for (const cheat of cheats) {
    const seq = cheat.sequence;
    if (seq.length > BUFFER_SIZE) continue;

    let match = true;
    for (let i = 0; i < seq.length; i++) {
      const bufIdx = (bufferPos - seq.length + i + BUFFER_SIZE) % BUFFER_SIZE;
      if (keyBuffer[bufIdx] !== seq[i]) {
        match = false;
        break;
      }
    }

    if (match) {
      if (cheat.paramCount) {
        // Start accumulating parameters
        pendingParamCheat = cheat;
        pendingParamChars = '';
        pendingParamPlayer = player;
        return false; // wait for param chars
      }
      cheat.handler(player);
      // Clear buffer to prevent re-triggering
      keyBuffer.fill('');
      bufferPos = 0;
      console.log(`[cheats] Activated: ${seq}`);
      return true;
    }
  }

  return false;
}

/** Reset cheat state (e.g. on level change) */
export function resetCheatBuffer(): void {
  keyBuffer.fill('');
  bufferPos = 0;
  awaitingBeholdKey = false;
  pendingParamCheat = null;
  pendingParamChars = '';
  pendingParamPlayer = null;
}
