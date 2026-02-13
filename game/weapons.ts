// ============================================================
// Weapons System — State Machine & Psprite Logic
// Reference: p_pspr.c, d_items.c, info.c
// ============================================================

import { FRACBITS, FRACUNIT, FINEMASK, finesine, finecosine, fixedMul } from './math';
import { FX_Sound, FX_SetExtraLight, FX_Vibrate } from './effects';
import { Sfx } from './sounds';
import { levelTime } from './thinkers';
import { P_Random } from './random';

import {
  P_BulletSlope, P_GunShot, P_AimLineAttack, P_LineAttack,
  getBulletSlope, MELEERANGE,
  linetarget,
} from './combat';
import { spawnPlayerProjectile, ProjectileType } from './projectiles';
import { MapObjState, DI_NODIR } from './mobj';
import { getWorld } from './world';
import { MF_SHOOTABLE } from './mobjinfo';
import { P_NoiseAlert } from './enemy';

// ---- Constants ----
const LOWERSPEED = FRACUNIT * 6;
const RAISESPEED = FRACUNIT * 6;
const WEAPONBOTTOM = 128 * FRACUNIT;
const WEAPONTOP = 32 * FRACUNIT;
const FINEANGLES = 8192;

// ---- Weapon types ----
export enum WeaponType {
  fist,
  pistol,
  shotgun,
  chaingun,
  missile,
  plasma,
  bfg,
  chainsaw,
  supershotgun,
  NUMWEAPONS,
  nochange = -1,
}

// ---- Ammo types ----
export enum AmmoType {
  clip,   // pistol / chaingun
  shell,  // shotgun
  cell,   // plasma / bfg
  misl,   // rocket
  NUMAMMO,
  noammo = -1,
}

// Max ammo (no backpack)
export const MAX_AMMO: Record<number, number> = {
  [AmmoType.clip]: 200,
  [AmmoType.shell]: 50,
  [AmmoType.cell]: 300,
  [AmmoType.misl]: 50,
};

// Clip size for ammo pickups
export const CLIP_AMMO: Record<number, number> = {
  [AmmoType.clip]: 10,
  [AmmoType.shell]: 4,
  [AmmoType.cell]: 20,
  [AmmoType.misl]: 1,
};

// ---- Psprite slots ----
const PS_WEAPON = 0;
const PS_FLASH = 1;

// ---- State IDs (matching DOOM's info.c) ----
export enum StateNum {
  S_NULL,
  S_LIGHTDONE,
  // Fist
  S_PUNCH,
  S_PUNCHDOWN,
  S_PUNCHUP,
  S_PUNCH1,
  S_PUNCH2,
  S_PUNCH3,
  S_PUNCH4,
  S_PUNCH5,
  // Pistol
  S_PISTOL,
  S_PISTOLDOWN,
  S_PISTOLUP,
  S_PISTOL1,
  S_PISTOL2,
  S_PISTOL3,
  S_PISTOL4,
  S_PISTOLFLASH,
  // Shotgun
  S_SGUN,
  S_SGUNDOWN,
  S_SGUNUP,
  S_SGUN1,
  S_SGUN2,
  S_SGUN3,
  S_SGUN4,
  S_SGUN5,
  S_SGUN6,
  S_SGUN7,
  S_SGUN8,
  S_SGUN9,
  S_SGUNFLASH1,
  S_SGUNFLASH2,
  // Chaingun
  S_CHAIN,
  S_CHAINDOWN,
  S_CHAINUP,
  S_CHAIN1,
  S_CHAIN2,
  S_CHAIN3,
  S_CHAINFLASH1,
  S_CHAINFLASH2,
  // Missile
  S_MISSILE,
  S_MISSILEDOWN,
  S_MISSILEUP,
  S_MISSILE1,
  S_MISSILE2,
  S_MISSILE3,
  S_MISSILEFLASH1,
  S_MISSILEFLASH2,
  S_MISSILEFLASH3,
  S_MISSILEFLASH4,
  // Plasma
  S_PLASMA,
  S_PLASMADOWN,
  S_PLASMAUP,
  S_PLASMA1,
  S_PLASMA2,
  S_PLASMAFLASH1,
  S_PLASMAFLASH2,
  // BFG
  S_BFG,
  S_BFGDOWN,
  S_BFGUP,
  S_BFG1,
  S_BFG2,
  S_BFG3,
  S_BFG4,
  S_BFGFLASH1,
  S_BFGFLASH2,
  // Chainsaw
  S_SAW,
  S_SAWB,
  S_SAWDOWN,
  S_SAWUP,
  S_SAW1,
  S_SAW2,
  S_SAW3,
  // Super Shotgun (DOOM II)
  S_DSGUN,
  S_DSGUNDOWN,
  S_DSGUNUP,
  S_DSGUN1,
  S_DSGUN2,
  S_DSGUN3,
  S_DSGUN4,
  S_DSGUN5,
  S_DSGUN6,
  S_DSGUN7,
  S_DSGUN8,
  S_DSGUN9,
  S_DSGUN10,
  S_DSNR1,
  S_DSNR2,
  S_DSGUNFLASH1,
  S_DSGUNFLASH2,
}

// ---- Action function type ----
type ActionFn = ((wp: WeaponPlayer) => void) | null;

// ---- State definition ----
interface WeaponState {
  sprite: string;   // 4-char sprite name
  frame: number;    // frame number (bit 15 = fullbright)
  tics: number;     // -1 = infinite
  action: ActionFn;
  nextState: StateNum;
}

// ---- Player weapon interface ----
export interface PspDef {
  state: WeaponState | null;
  stateNum: StateNum;
  tics: number;
  sx: number;  // fixed_t — screen x offset
  sy: number;  // fixed_t — screen y offset
}

export interface WeaponPlayer {
  readyweapon: WeaponType;
  pendingweapon: WeaponType;
  ammo: number[];
  maxammo: number[];
  weaponowned: boolean[];
  psprites: PspDef[];
  attackdown: boolean;
  refire: number;
  // Player position/angle for combat & bobbing
  x: number;
  y: number;
  viewz: number;
  angle: number;
  momx: number;
  momy: number;
  // Power-ups (only berserk needed here)
  powers: number[];
  // Health (needed for death weapon handling)
  health: number;
  // View bob amplitude (computed by Player.calcHeight, used for weapon psprite bob)
  bob: number;
}

// ---- Weapon info table (from d_items.c) ----
interface WeaponInfo {
  ammo: AmmoType;
  upstate: StateNum;
  downstate: StateNum;
  readystate: StateNum;
  atkstate: StateNum;
  flashstate: StateNum;
}

const weaponinfo: WeaponInfo[] = [];
weaponinfo[WeaponType.fist] = {
  ammo: AmmoType.noammo,
  upstate: StateNum.S_PUNCHUP,
  downstate: StateNum.S_PUNCHDOWN,
  readystate: StateNum.S_PUNCH,
  atkstate: StateNum.S_PUNCH1,
  flashstate: StateNum.S_NULL,
};
weaponinfo[WeaponType.pistol] = {
  ammo: AmmoType.clip,
  upstate: StateNum.S_PISTOLUP,
  downstate: StateNum.S_PISTOLDOWN,
  readystate: StateNum.S_PISTOL,
  atkstate: StateNum.S_PISTOL1,
  flashstate: StateNum.S_PISTOLFLASH,
};
weaponinfo[WeaponType.shotgun] = {
  ammo: AmmoType.shell,
  upstate: StateNum.S_SGUNUP,
  downstate: StateNum.S_SGUNDOWN,
  readystate: StateNum.S_SGUN,
  atkstate: StateNum.S_SGUN1,
  flashstate: StateNum.S_SGUNFLASH1,
};
weaponinfo[WeaponType.chaingun] = {
  ammo: AmmoType.clip,
  upstate: StateNum.S_CHAINUP,
  downstate: StateNum.S_CHAINDOWN,
  readystate: StateNum.S_CHAIN,
  atkstate: StateNum.S_CHAIN1,
  flashstate: StateNum.S_CHAINFLASH1,
};
weaponinfo[WeaponType.missile] = {
  ammo: AmmoType.misl,
  upstate: StateNum.S_MISSILEUP,
  downstate: StateNum.S_MISSILEDOWN,
  readystate: StateNum.S_MISSILE,
  atkstate: StateNum.S_MISSILE1,
  flashstate: StateNum.S_MISSILEFLASH1,
};
weaponinfo[WeaponType.plasma] = {
  ammo: AmmoType.cell,
  upstate: StateNum.S_PLASMAUP,
  downstate: StateNum.S_PLASMADOWN,
  readystate: StateNum.S_PLASMA,
  atkstate: StateNum.S_PLASMA1,
  flashstate: StateNum.S_PLASMAFLASH1,
};
weaponinfo[WeaponType.bfg] = {
  ammo: AmmoType.cell,
  upstate: StateNum.S_BFGUP,
  downstate: StateNum.S_BFGDOWN,
  readystate: StateNum.S_BFG,
  atkstate: StateNum.S_BFG1,
  flashstate: StateNum.S_BFGFLASH1,
};
weaponinfo[WeaponType.chainsaw] = {
  ammo: AmmoType.noammo,
  upstate: StateNum.S_SAWUP,
  downstate: StateNum.S_SAWDOWN,
  readystate: StateNum.S_SAW,
  atkstate: StateNum.S_SAW1,
  flashstate: StateNum.S_NULL,
};
weaponinfo[WeaponType.supershotgun] = {
  ammo: AmmoType.shell,
  upstate: StateNum.S_DSGUNUP,
  downstate: StateNum.S_DSGUNDOWN,
  readystate: StateNum.S_DSGUN,
  atkstate: StateNum.S_DSGUN1,
  flashstate: StateNum.S_DSGUNFLASH1,
};

// ---- Forward declare action functions ----
function A_WeaponReady(wp: WeaponPlayer): void { weaponReady(wp); }
function A_Lower(wp: WeaponPlayer): void { weaponLower(wp); }
function A_Raise(wp: WeaponPlayer): void { weaponRaise(wp); }
function A_ReFire(wp: WeaponPlayer): void { weaponReFire(wp); }

function A_FirePistol(wp: WeaponPlayer): void {
  FX_Sound({ x: wp.x, y: wp.y }, Sfx.pistol);
  FX_Vibrate(0.2, 0.1, 80);
  fireHitscan(wp, 1, !wp.refire);
}

function A_FireShotgun(wp: WeaponPlayer): void {
  FX_Sound({ x: wp.x, y: wp.y }, Sfx.shotgn);
  FX_Vibrate(0.5, 0.4, 120);
  fireHitscan(wp, 7, false);
}

function A_FireCGun(wp: WeaponPlayer): void {
  FX_Sound({ x: wp.x, y: wp.y }, Sfx.pistol);
  FX_Vibrate(0.15, 0.1, 50);
  fireHitscan(wp, 1, !wp.refire);
}

function A_Punch(wp: WeaponPlayer): void {
  // Melee attack — port of A_Punch from p_pspr.c
  let damage = (P_Random() % 10 + 1) << 1; // 2*(rand%10+1)
  if (wp.powers && wp.powers[1]) { // pw_strength (berserk)
    damage *= 10;
  }

  const angle = wp.angle;
  P_AimLineAttack(wp.x, wp.y, wp.viewz, angle, MELEERANGE);
  P_LineAttack(wp.x, wp.y, wp.viewz, angle, MELEERANGE, getBulletSlope(), damage);

  // Sound: hit sound only if we hit something
  if (linetarget) {
    FX_Sound({ x: wp.x, y: wp.y }, Sfx.punch);
    FX_Vibrate(0.3, 0.5, 100);
  }
}

function A_Saw(wp: WeaponPlayer): void {
  // Chainsaw attack — port of A_Saw from p_pspr.c
  const damage = 2 * (P_Random() % 10 + 1);
  const angle = wp.angle;
  P_AimLineAttack(wp.x, wp.y, wp.viewz, angle, MELEERANGE + FRACUNIT);
  P_LineAttack(wp.x, wp.y, wp.viewz, angle, MELEERANGE + FRACUNIT, getBulletSlope(), damage);

  // Sound: hit or miss
  if (linetarget) {
    FX_Sound({ x: wp.x, y: wp.y }, Sfx.sawhit);
    FX_Vibrate(0.4, 0.3, 80);
  } else {
    FX_Sound({ x: wp.x, y: wp.y }, Sfx.sawful);
    FX_Vibrate(0.1, 0.05, 40);
  }
}

// ---- Super Shotgun action functions (DOOM II) ----

/** A_FireShotgun2 — fire 20 pellets, consume 2 shells */
function A_FireShotgun2(wp: WeaponPlayer): void {
  FX_Sound({ x: wp.x, y: wp.y }, Sfx.dshtgn);
  FX_Vibrate(0.8, 0.6, 180);
  wp.ammo[AmmoType.shell] -= 2;

  // Flash — sync position with weapon
  wp.psprites[PS_FLASH].sx = wp.psprites[PS_WEAPON].sx;
  wp.psprites[PS_FLASH].sy = wp.psprites[PS_WEAPON].sy;
  setPsprite(wp, PS_FLASH, weaponinfo[wp.readyweapon].flashstate);

  P_BulletSlope(wp.x, wp.y, wp.viewz, wp.angle);

  // Fire 20 pellets with extra spread (original DOOM: ss_angle ± ANG90/20)
  for (let i = 0; i < 20; i++) {
    P_GunShot(wp.x, wp.y, wp.viewz, wp.angle, false);
  }
}

/** A_CheckReload — check if enough ammo to keep firing SSG */
function A_CheckReload(wp: WeaponPlayer): void {
  if (!checkAmmo(wp)) {
    // Not enough ammo — transition to "no reload" state (lower + switch)
    setPsprite(wp, PS_WEAPON, StateNum.S_DSNR1);
  }
}

/** A_OpenShotgun2 — SSG open break sound */
function A_OpenShotgun2(_wp: WeaponPlayer): void {
  FX_Sound({ x: _wp.x, y: _wp.y }, Sfx.dbopn);
}

/** A_LoadShotgun2 — SSG shell load sound */
function A_LoadShotgun2(_wp: WeaponPlayer): void {
  FX_Sound({ x: _wp.x, y: _wp.y }, Sfx.dbload);
}

/** A_CloseShotgun2 — SSG close break sound + refire check */
function A_CloseShotgun2(wp: WeaponPlayer): void {
  FX_Sound({ x: wp.x, y: wp.y }, Sfx.dbcls);
  A_ReFire(wp);
}

function A_GunFlash(wp: WeaponPlayer): void {
  // Sync flash position with weapon so they always align
  wp.psprites[PS_FLASH].sx = wp.psprites[PS_WEAPON].sx;
  wp.psprites[PS_FLASH].sy = wp.psprites[PS_WEAPON].sy;
  setPsprite(wp, PS_FLASH, weaponinfo[wp.readyweapon].flashstate);
}
function A_FireMissile(wp: WeaponPlayer): void {
  wp.ammo[AmmoType.misl]--;
  FX_Sound({ x: wp.x, y: wp.y }, Sfx.rlaunc);
  FX_Vibrate(0.7, 0.8, 200);
  // Autoaim slope for vertical aiming
  P_BulletSlope(wp.x, wp.y, wp.viewz, wp.angle);
  spawnPlayerProjectile(wp.x, wp.y, wp.viewz, wp.angle, getBulletSlope(), ProjectileType.rocket);
}
function A_FirePlasma(wp: WeaponPlayer): void {
  wp.ammo[AmmoType.cell]--;
  FX_Sound({ x: wp.x, y: wp.y }, Sfx.plasma);
  FX_Vibrate(0.3, 0.2, 60);
  // Random flash state (original DOOM: P_Random()&1 picks flash1 or flash2)
  const flashOffset = P_Random() & 1;
  const flashBase = weaponinfo[wp.readyweapon].flashstate;
  wp.psprites[PS_FLASH].sx = wp.psprites[PS_WEAPON].sx;
  wp.psprites[PS_FLASH].sy = wp.psprites[PS_WEAPON].sy;
  setPsprite(wp, PS_FLASH, flashBase + flashOffset);
  // Autoaim slope
  P_BulletSlope(wp.x, wp.y, wp.viewz, wp.angle);
  spawnPlayerProjectile(wp.x, wp.y, wp.viewz, wp.angle, getBulletSlope(), ProjectileType.plasma);
}
function A_FireBFG(wp: WeaponPlayer): void {
  wp.ammo[AmmoType.cell] -= 40;
  FX_Sound({ x: wp.x, y: wp.y }, Sfx.bfg);
  FX_Vibrate(1.0, 1.0, 350);
  // Autoaim slope
  P_BulletSlope(wp.x, wp.y, wp.viewz, wp.angle);
  spawnPlayerProjectile(wp.x, wp.y, wp.viewz, wp.angle, getBulletSlope(), ProjectileType.bfg);
}
function A_Light0(_wp: WeaponPlayer): void { FX_SetExtraLight(0); }
function A_Light1(_wp: WeaponPlayer): void { FX_SetExtraLight(1); }
function A_Light2(_wp: WeaponPlayer): void { FX_SetExtraLight(2); }

// ---- State table (from info.c) ----
const states: Map<StateNum, WeaponState> = new Map();

function S(sprite: string, frame: number, tics: number, action: ActionFn, nextState: StateNum): WeaponState {
  return { sprite, frame, tics, action, nextState };
}

// S_NULL — empty state
states.set(StateNum.S_NULL, S('TNT1', 0, -1, null, StateNum.S_NULL));
states.set(StateNum.S_LIGHTDONE, S('SHTG', 4, 0, A_Light0, StateNum.S_NULL));

// Fist
states.set(StateNum.S_PUNCH, S('PUNG', 0, 1, A_WeaponReady, StateNum.S_PUNCH));
states.set(StateNum.S_PUNCHDOWN, S('PUNG', 0, 1, A_Lower, StateNum.S_PUNCHDOWN));
states.set(StateNum.S_PUNCHUP, S('PUNG', 0, 1, A_Raise, StateNum.S_PUNCHUP));
states.set(StateNum.S_PUNCH1, S('PUNG', 1, 4, null, StateNum.S_PUNCH2));
states.set(StateNum.S_PUNCH2, S('PUNG', 2, 4, A_Punch, StateNum.S_PUNCH3));
states.set(StateNum.S_PUNCH3, S('PUNG', 3, 5, null, StateNum.S_PUNCH4));
states.set(StateNum.S_PUNCH4, S('PUNG', 2, 4, null, StateNum.S_PUNCH5));
states.set(StateNum.S_PUNCH5, S('PUNG', 1, 5, A_ReFire, StateNum.S_PUNCH));

// Pistol
states.set(StateNum.S_PISTOL, S('PISG', 0, 1, A_WeaponReady, StateNum.S_PISTOL));
states.set(StateNum.S_PISTOLDOWN, S('PISG', 0, 1, A_Lower, StateNum.S_PISTOLDOWN));
states.set(StateNum.S_PISTOLUP, S('PISG', 0, 1, A_Raise, StateNum.S_PISTOLUP));
states.set(StateNum.S_PISTOL1, S('PISG', 0, 4, null, StateNum.S_PISTOL2));
states.set(StateNum.S_PISTOL2, S('PISG', 1, 6, A_FirePistol, StateNum.S_PISTOL3));
states.set(StateNum.S_PISTOL3, S('PISG', 2, 4, null, StateNum.S_PISTOL4));
states.set(StateNum.S_PISTOL4, S('PISG', 1, 5, A_ReFire, StateNum.S_PISTOL));
states.set(StateNum.S_PISTOLFLASH, S('PISF', 0 | 0x8000, 7, A_Light1, StateNum.S_LIGHTDONE));

// Shotgun
states.set(StateNum.S_SGUN, S('SHTG', 0, 1, A_WeaponReady, StateNum.S_SGUN));
states.set(StateNum.S_SGUNDOWN, S('SHTG', 0, 1, A_Lower, StateNum.S_SGUNDOWN));
states.set(StateNum.S_SGUNUP, S('SHTG', 0, 1, A_Raise, StateNum.S_SGUNUP));
states.set(StateNum.S_SGUN1, S('SHTG', 0, 3, null, StateNum.S_SGUN2));
states.set(StateNum.S_SGUN2, S('SHTG', 0, 7, A_FireShotgun, StateNum.S_SGUN3));
states.set(StateNum.S_SGUN3, S('SHTG', 1, 5, null, StateNum.S_SGUN4));
states.set(StateNum.S_SGUN4, S('SHTG', 2, 5, null, StateNum.S_SGUN5));
states.set(StateNum.S_SGUN5, S('SHTG', 3, 4, null, StateNum.S_SGUN6));
states.set(StateNum.S_SGUN6, S('SHTG', 2, 5, null, StateNum.S_SGUN7));
states.set(StateNum.S_SGUN7, S('SHTG', 1, 5, null, StateNum.S_SGUN8));
states.set(StateNum.S_SGUN8, S('SHTG', 0, 3, null, StateNum.S_SGUN9));
states.set(StateNum.S_SGUN9, S('SHTG', 0, 7, A_ReFire, StateNum.S_SGUN));
states.set(StateNum.S_SGUNFLASH1, S('SHTF', 0 | 0x8000, 4, A_Light1, StateNum.S_SGUNFLASH2));
states.set(StateNum.S_SGUNFLASH2, S('SHTF', 1 | 0x8000, 3, A_Light2, StateNum.S_LIGHTDONE));

// Chaingun
states.set(StateNum.S_CHAIN, S('CHGG', 0, 1, A_WeaponReady, StateNum.S_CHAIN));
states.set(StateNum.S_CHAINDOWN, S('CHGG', 0, 1, A_Lower, StateNum.S_CHAINDOWN));
states.set(StateNum.S_CHAINUP, S('CHGG', 0, 1, A_Raise, StateNum.S_CHAINUP));
states.set(StateNum.S_CHAIN1, S('CHGG', 0, 4, A_FireCGun, StateNum.S_CHAIN2));
states.set(StateNum.S_CHAIN2, S('CHGG', 1, 4, A_FireCGun, StateNum.S_CHAIN3));
states.set(StateNum.S_CHAIN3, S('CHGG', 1, 0, A_ReFire, StateNum.S_CHAIN));
states.set(StateNum.S_CHAINFLASH1, S('CHGF', 0 | 0x8000, 5, A_Light1, StateNum.S_LIGHTDONE));
states.set(StateNum.S_CHAINFLASH2, S('CHGF', 1 | 0x8000, 5, A_Light2, StateNum.S_LIGHTDONE));

// Missile launcher
states.set(StateNum.S_MISSILE, S('MISG', 0, 1, A_WeaponReady, StateNum.S_MISSILE));
states.set(StateNum.S_MISSILEDOWN, S('MISG', 0, 1, A_Lower, StateNum.S_MISSILEDOWN));
states.set(StateNum.S_MISSILEUP, S('MISG', 0, 1, A_Raise, StateNum.S_MISSILEUP));
states.set(StateNum.S_MISSILE1, S('MISG', 1, 8, A_GunFlash, StateNum.S_MISSILE2));
states.set(StateNum.S_MISSILE2, S('MISG', 1, 12, A_FireMissile, StateNum.S_MISSILE3));
states.set(StateNum.S_MISSILE3, S('MISG', 1, 0, A_ReFire, StateNum.S_MISSILE));
states.set(StateNum.S_MISSILEFLASH1, S('MISF', 0 | 0x8000, 3, A_Light1, StateNum.S_MISSILEFLASH2));
states.set(StateNum.S_MISSILEFLASH2, S('MISF', 1 | 0x8000, 4, null, StateNum.S_MISSILEFLASH3));
states.set(StateNum.S_MISSILEFLASH3, S('MISF', 2 | 0x8000, 4, A_Light2, StateNum.S_MISSILEFLASH4));
states.set(StateNum.S_MISSILEFLASH4, S('MISF', 3 | 0x8000, 4, A_Light2, StateNum.S_LIGHTDONE));

// Plasma rifle
states.set(StateNum.S_PLASMA, S('PLSG', 0, 1, A_WeaponReady, StateNum.S_PLASMA));
states.set(StateNum.S_PLASMADOWN, S('PLSG', 0, 1, A_Lower, StateNum.S_PLASMADOWN));
states.set(StateNum.S_PLASMAUP, S('PLSG', 0, 1, A_Raise, StateNum.S_PLASMAUP));
states.set(StateNum.S_PLASMA1, S('PLSG', 0, 3, A_FirePlasma, StateNum.S_PLASMA2));
states.set(StateNum.S_PLASMA2, S('PLSG', 1, 20, A_ReFire, StateNum.S_PLASMA));
states.set(StateNum.S_PLASMAFLASH1, S('PLSF', 0 | 0x8000, 4, A_Light1, StateNum.S_LIGHTDONE));
states.set(StateNum.S_PLASMAFLASH2, S('PLSF', 1 | 0x8000, 4, A_Light1, StateNum.S_LIGHTDONE));

// BFG
states.set(StateNum.S_BFG, S('BFGG', 0, 1, A_WeaponReady, StateNum.S_BFG));
states.set(StateNum.S_BFGDOWN, S('BFGG', 0, 1, A_Lower, StateNum.S_BFGDOWN));
states.set(StateNum.S_BFGUP, S('BFGG', 0, 1, A_Raise, StateNum.S_BFGUP));
states.set(StateNum.S_BFG1, S('BFGG', 0, 20, null, StateNum.S_BFG2));
states.set(StateNum.S_BFG2, S('BFGG', 1, 10, A_GunFlash, StateNum.S_BFG3));
states.set(StateNum.S_BFG3, S('BFGG', 1, 10, A_FireBFG, StateNum.S_BFG4));
states.set(StateNum.S_BFG4, S('BFGG', 1, 20, A_ReFire, StateNum.S_BFG));
states.set(StateNum.S_BFGFLASH1, S('BFGF', 0 | 0x8000, 11, A_Light1, StateNum.S_BFGFLASH2));
states.set(StateNum.S_BFGFLASH2, S('BFGF', 1 | 0x8000, 6, A_Light2, StateNum.S_LIGHTDONE));

// Chainsaw
states.set(StateNum.S_SAW, S('SAWG', 2, 4, A_WeaponReady, StateNum.S_SAWB));
states.set(StateNum.S_SAWB, S('SAWG', 3, 4, A_WeaponReady, StateNum.S_SAW));
states.set(StateNum.S_SAWDOWN, S('SAWG', 2, 1, A_Lower, StateNum.S_SAWDOWN));
states.set(StateNum.S_SAWUP, S('SAWG', 2, 1, A_Raise, StateNum.S_SAWUP));
states.set(StateNum.S_SAW1, S('SAWG', 0, 4, A_Saw, StateNum.S_SAW2));
states.set(StateNum.S_SAW2, S('SAWG', 1, 4, A_Saw, StateNum.S_SAW3));
states.set(StateNum.S_SAW3, S('SAWG', 1, 0, A_ReFire, StateNum.S_SAW));

// Super Shotgun (DOOM II) — sprite SHT2
states.set(StateNum.S_DSGUN, S('SHT2', 0, 1, A_WeaponReady, StateNum.S_DSGUN));
states.set(StateNum.S_DSGUNDOWN, S('SHT2', 0, 1, A_Lower, StateNum.S_DSGUNDOWN));
states.set(StateNum.S_DSGUNUP, S('SHT2', 0, 1, A_Raise, StateNum.S_DSGUNUP));
states.set(StateNum.S_DSGUN1, S('SHT2', 0, 3, null, StateNum.S_DSGUN2));
states.set(StateNum.S_DSGUN2, S('SHT2', 0, 7, A_FireShotgun2, StateNum.S_DSGUN3));
states.set(StateNum.S_DSGUN3, S('SHT2', 1, 7, null, StateNum.S_DSGUN4));
states.set(StateNum.S_DSGUN4, S('SHT2', 2, 7, A_CheckReload, StateNum.S_DSGUN5));
states.set(StateNum.S_DSGUN5, S('SHT2', 3, 7, A_OpenShotgun2, StateNum.S_DSGUN6));
states.set(StateNum.S_DSGUN6, S('SHT2', 4, 7, null, StateNum.S_DSGUN7));
states.set(StateNum.S_DSGUN7, S('SHT2', 5, 7, A_LoadShotgun2, StateNum.S_DSGUN8));
states.set(StateNum.S_DSGUN8, S('SHT2', 6, 6, null, StateNum.S_DSGUN9));
states.set(StateNum.S_DSGUN9, S('SHT2', 7, 6, A_CloseShotgun2, StateNum.S_DSGUN10));
states.set(StateNum.S_DSGUN10, S('SHT2', 0, 5, A_ReFire, StateNum.S_DSGUN));
// "No reload" path (out of ammo after firing)
states.set(StateNum.S_DSNR1, S('SHT2', 1, 7, null, StateNum.S_DSNR2));
states.set(StateNum.S_DSNR2, S('SHT2', 0, 3, null, StateNum.S_DSGUNDOWN));
// Flash states (fullbright)
states.set(StateNum.S_DSGUNFLASH1, S('SHT2', 8 | 0x8000, 5, A_Light1, StateNum.S_DSGUNFLASH2));
states.set(StateNum.S_DSGUNFLASH2, S('SHT2', 9 | 0x8000, 4, A_Light2, StateNum.S_LIGHTDONE));

// =============================================
// P_SetPsprite — set weapon to a given state
// =============================================
export function setPsprite(wp: WeaponPlayer, position: number, stnum: StateNum): void {
  const psp = wp.psprites[position];

  let currentNum = stnum;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (currentNum === StateNum.S_NULL) {
      psp.state = null;
      psp.stateNum = StateNum.S_NULL;
      break;
    }

    const state = states.get(currentNum);
    if (!state) {
      psp.state = null;
      psp.stateNum = StateNum.S_NULL;
      break;
    }

    psp.state = state;
    psp.stateNum = currentNum;
    psp.tics = state.tics;

    // Call action routine
    if (state.action) {
      state.action(wp);
      if (!psp.state) break; // action removed the state
    }

    // If tics is 0, immediately advance (avoids infinite loops via action check)
    if (psp.tics === 0) {
      currentNum = state.nextState;
    } else {
      break;
    }
  }
}

// =============================================
// Action function implementations
// =============================================

/** A_WeaponReady — player can fire or change weapon */
function weaponReady(wp: WeaponPlayer): void {
  const psp = wp.psprites[PS_WEAPON];

  // Check for weapon change
  if (wp.pendingweapon !== WeaponType.nochange) {
    const newstate = weaponinfo[wp.readyweapon].downstate;
    setPsprite(wp, PS_WEAPON, newstate);
    return;
  }

  // Check for fire (DOOM: player->cmd.buttons & BT_ATTACK)
  // Fire can only happen from the ready state — this prevents
  // mid-animation interruption during rapid clicking
  if (wp.attackdown) {
    fireWeapon(wp);
    return;
  }

  // Chainsaw idle sound
  if (wp.readyweapon === WeaponType.chainsaw) {
    FX_Sound({ x: wp.x, y: wp.y }, Sfx.sawidl);
  }

  // Weapon bobbing — use player.bob (computed in P_CalcHeight)
  // Original DOOM: A_WeaponReady uses player->bob/2 for psprite amplitude
  const bobAmplitude = (wp.bob ?? 0) >> 1;
  const angle = (128 * levelTime) & FINEMASK;
  psp.sx = FRACUNIT + fixedMul(bobAmplitude, finecosine(angle));
  const angle2 = angle & (FINEANGLES / 2 - 1);
  psp.sy = WEAPONTOP + fixedMul(bobAmplitude, finesine[angle2]);
}

/** A_Lower — lower the weapon off screen */
function weaponLower(wp: WeaponPlayer): void {
  const psp = wp.psprites[PS_WEAPON];
  psp.sy += LOWERSPEED;

  if (psp.sy < WEAPONBOTTOM) return;

  // Player is dead — keep weapon off screen permanently
  if (wp.health !== undefined && wp.health <= 0) {
    psp.sy = WEAPONBOTTOM;
    setPsprite(wp, PS_WEAPON, StateNum.S_NULL);
    return;
  }

  // Weapon is now off screen — switch to pending weapon
  wp.readyweapon = wp.pendingweapon !== WeaponType.nochange
    ? wp.pendingweapon
    : wp.readyweapon;
  bringUpWeapon(wp);
}

/** A_Raise — bring the weapon up on screen */
function weaponRaise(wp: WeaponPlayer): void {
  const psp = wp.psprites[PS_WEAPON];
  psp.sy -= RAISESPEED;

  if (psp.sy > WEAPONTOP) return;

  psp.sy = WEAPONTOP;
  const newstate = weaponinfo[wp.readyweapon].readystate;
  setPsprite(wp, PS_WEAPON, newstate);
}

/** A_ReFire — re-fire check during attack sequence */
function weaponReFire(wp: WeaponPlayer): void {
  if (wp.attackdown
    && wp.pendingweapon === WeaponType.nochange) {
    wp.refire++;
    fireWeapon(wp);
  } else {
    wp.refire = 0;
    checkAmmo(wp);
  }
}

/** Hitscan fire — consumes ammo, traces bullets, applies damage */
function fireHitscan(wp: WeaponPlayer, pellets: number, accurate: boolean): void {
  const ammoType = weaponinfo[wp.readyweapon].ammo;
  if (ammoType !== AmmoType.noammo) {
    wp.ammo[ammoType]--;
  }

  // Flash — sync position with weapon so they align during bobbing
  if (weaponinfo[wp.readyweapon].flashstate !== StateNum.S_NULL) {
    wp.psprites[PS_FLASH].sx = wp.psprites[PS_WEAPON].sx;
    wp.psprites[PS_FLASH].sy = wp.psprites[PS_WEAPON].sy;
    setPsprite(wp, PS_FLASH, weaponinfo[wp.readyweapon].flashstate);
  }

  // Hitscan: autoaim + fire bullets
  P_BulletSlope(wp.x, wp.y, wp.viewz, wp.angle);
  for (let i = 0; i < pellets; i++) {
    P_GunShot(wp.x, wp.y, wp.viewz, wp.angle, accurate && i === 0);
  }
}

// =============================================
// P_BringUpWeapon — start raising the weapon
// =============================================
export function bringUpWeapon(wp: WeaponPlayer): void {
  if (wp.pendingweapon === WeaponType.nochange) {
    wp.pendingweapon = wp.readyweapon;
  }

  const newstate = weaponinfo[wp.pendingweapon].upstate;
  wp.readyweapon = wp.pendingweapon;
  wp.pendingweapon = WeaponType.nochange;
  wp.psprites[PS_WEAPON].sy = WEAPONBOTTOM;
  setPsprite(wp, PS_WEAPON, newstate);
}

// =============================================
// P_CheckAmmo — check if there's enough ammo
// =============================================
export function checkAmmo(wp: WeaponPlayer): boolean {
  const ammo = weaponinfo[wp.readyweapon].ammo;
  if (ammo === AmmoType.noammo) return true;

  // Per-shot ammo cost (SSG=2, BFG=40, everything else=1)
  let count = 1;
  if (wp.readyweapon === WeaponType.supershotgun) count = 2;
  else if (wp.readyweapon === WeaponType.bfg) count = 40;

  if (wp.ammo[ammo] >= count) {
    return true;
  }

  // Out of ammo — find a weapon to switch to
  if (wp.weaponowned[WeaponType.supershotgun] && wp.ammo[AmmoType.shell] >= 2) {
    wp.pendingweapon = WeaponType.supershotgun;
  } else if (wp.weaponowned[WeaponType.shotgun] && wp.ammo[AmmoType.shell]) {
    wp.pendingweapon = WeaponType.shotgun;
  } else if (wp.weaponowned[WeaponType.chaingun] && wp.ammo[AmmoType.clip]) {
    wp.pendingweapon = WeaponType.chaingun;
  } else if (wp.ammo[AmmoType.clip]) {
    wp.pendingweapon = WeaponType.pistol;
  } else {
    wp.pendingweapon = WeaponType.fist;
  }

  setPsprite(wp, PS_WEAPON, weaponinfo[wp.readyweapon].downstate);
  return false;
}

// =============================================
// P_FireWeapon — initiate attack
// =============================================
export function fireWeapon(wp: WeaponPlayer): void {
  if (!checkAmmo(wp)) return;
  const newstate = weaponinfo[wp.readyweapon].atkstate;
  setPsprite(wp, PS_WEAPON, newstate);

  // Alert nearby monsters — sound propagates through connected sectors
  const map = getWorld().map;
  if (map) {
    const playerMobj = createPlayerMobjFromWP(wp, map);
    P_NoiseAlert(playerMobj, playerMobj, map);
  }
}

// =============================================
// P_MovePsprites — tick all psprite slots
// =============================================
export function movePsprites(wp: WeaponPlayer): void {
  for (let i = 0; i < wp.psprites.length; i++) {
    const psp = wp.psprites[i];
    if (!psp.state) continue;

    // A tic count of -1 means never change
    if (psp.tics !== -1) {
      psp.tics--;
      if (psp.tics <= 0) {
        setPsprite(wp, i, psp.state.nextState);
      }
    }
  }
}


// =============================================
// Create default weapon state for a new player
// =============================================
export function initPlayerWeapons(wp: WeaponPlayer): void {
  wp.readyweapon = WeaponType.pistol;
  wp.pendingweapon = WeaponType.nochange;
  wp.attackdown = false;
  wp.refire = 0;

  wp.ammo = new Array(AmmoType.NUMAMMO).fill(0);
  wp.ammo[AmmoType.clip] = 50; // start with 50 bullets
  wp.maxammo = [
    MAX_AMMO[AmmoType.clip],
    MAX_AMMO[AmmoType.shell],
    MAX_AMMO[AmmoType.cell],
    MAX_AMMO[AmmoType.misl],
  ];

  wp.weaponowned = new Array(WeaponType.NUMWEAPONS).fill(false);
  wp.weaponowned[WeaponType.fist] = true;
  wp.weaponowned[WeaponType.pistol] = true;

  wp.psprites = [
    { state: null, stateNum: StateNum.S_NULL, tics: 0, sx: FRACUNIT, sy: WEAPONTOP },
    { state: null, stateNum: StateNum.S_NULL, tics: 0, sx: FRACUNIT, sy: WEAPONTOP },
  ];

  bringUpWeapon(wp);
}

// =============================================
// Get current psprite info for rendering
// =============================================
export function getPspriteInfo(wp: WeaponPlayer, slot: number): {
  sprite: string; frame: number; sx: number; sy: number;
} | null {
  const psp = wp.psprites[slot];
  if (!psp || !psp.state) return null;
  return {
    sprite: psp.state.sprite,
    frame: psp.state.frame & 0x7FFF, // strip fullbright flag
    sx: psp.sx,
    sy: psp.sy,
  };
}

/** Resolve a StateNum to its WeaponState object (for save/load) */
export function getWeaponState(stnum: StateNum): WeaponState | null {
  return states.get(stnum) ?? null;
}

export { weaponinfo, PS_WEAPON, PS_FLASH, WEAPONTOP, WEAPONBOTTOM };

/**
 * P_DropWeapon — lower the current weapon when the player dies.
 * Initiates the weapon lowering animation.
 */
export function dropWeapon(wp: WeaponPlayer): void {
  setPsprite(wp, PS_WEAPON, weaponinfo[wp.readyweapon].downstate);
}

/** Build a lightweight MapObjState from WeaponPlayer position for P_NoiseAlert */
function createPlayerMobjFromWP(wp: WeaponPlayer, map: import('../src/map').GameMap): MapObjState {
  const ss = map.pointInSubsector(wp.x, wp.y);
  return {
    thingIndex: -1,
    x: wp.x,
    y: wp.y,
    z: wp.viewz,
    health: wp.health,
    spawnHealth: 100,
    radius: 16 * FRACUNIT,
    height: 56 * FRACUNIT,
    flags: MF_SHOOTABLE,
    mass: 100,
    type: -1,
    removed: false,
    deathHandled: false,
    mobjType: 0,
    angle: wp.angle,
    movedir: DI_NODIR,
    movecount: 0,
    target: null,
    threshold: 0,
    reactiontime: 0,
    lastlook: 0,
    momx: wp.momx,
    momy: wp.momy,
    momz: 0,
    floorz: ss.sector ? ss.sector.floorHeight : 0,
    ceilingz: ss.sector ? ss.sector.ceilingHeight : 0,
    info: null,
    tracer: null,
    spawnX: wp.x,
    spawnY: wp.y,
    spawnAngle: wp.angle,
    respawnTimer: 0,
  };
}
