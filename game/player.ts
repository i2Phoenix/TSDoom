// ============================================================
// Player Controller
// Reference: p_user.c, p_mobj.c — movement, collision
// ============================================================

import { ML_BLOCKING, ML_TWOSIDED, type GameMap, type LineDef } from './map-types';
import { FRACBITS, FRACUNIT, ANG90, ANG180, ANG270, ANGLETOFINESHIFT, FINEANGLES, FINEMASK, finesine, finecosine, fixedMul, fixedDiv } from './math';
import { getInput, resetInputAccumulated } from './input-system';
import { useSpecialLine, crossSpecialLine } from './specials';
import { checkPickups } from './pickups';
import { CF_GODMODE, CF_NOCLIP } from './cheats';
import { getDamageMultiplier } from './skill';
import { getMapObjects } from './mobj';
import { MF_SOLID } from './mobjinfo';
import {
  WeaponType, AmmoType, WeaponPlayer, StateNum, type PspDef,
  initPlayerWeapons, movePsprites, fireWeapon, getPspriteInfo,
  weaponinfo, dropWeapon, bringUpWeapon, createPspDef,
} from './weapons';
import { getLevelTime } from './thinkers';
import { FX_Sound } from './effects';
import { Sfx } from './sounds';
import { GameInstance } from './game-instance';

const USERANGE = 64 << FRACBITS; // 64 map units — how far the player can reach

import { PLAYERHEIGHT } from './constants';
const VIEWHEIGHT = 41 << FRACBITS;
const MAXBOB = 0x100000;               // 16 fixed-point units — max bob amplitude
const FORWARDMOVE = 0x19; // 25 — same as original DOOM
const SIDEMOVE = 0x18;    // 24
const ANGLETURN = 640;     // per-tic turning speed
let MOUSE_SENSITIVITY = 8;

/** Set mouse sensitivity (0-9 maps to 2-20 internal) */
export function setMouseSensitivity(level: number): void {
  MOUSE_SENSITIVITY = 2 + Math.round(level * 2);
}

/** Get mouse sensitivity level (0-9) */
export function getMouseSensitivity(): number {
  return Math.round((MOUSE_SENSITIVITY - 2) / 2);
}
const FRICTION = 0xE800;   // Original DOOM friction factor
const MAXSTEPHEIGHT = 24 << FRACBITS; // max step-up height
const PLAYERRADIUS = 16 << FRACBITS;  // player bounding radius

// Player states (from d_player.h)
export enum PlayerState {
  LIVE = 0,
  DEAD = 1,
  REBORN = 2,
}

// Powerup types (from doomdef.h)
export enum PowerType {
  invulnerability = 0,
  strength = 1,       // berserk
  invisibility = 2,
  ironfeet = 3,       // radiation suit
  allmap = 4,
  infrared = 5,       // light amp visor
  NUMPOWERS = 6,
}

// Powerup durations in tics (TICRATE = 35)
const TICRATE = 35;
export const INVULNTICS = 30 * TICRATE;  // 1050
export const INVISTICS = 60 * TICRATE;  // 2100
export const IRONTICS = 60 * TICRATE;  // 2100
export const INFRATICS = 120 * TICRATE; // 4200

export class Player {
  x: number = 0;           // fixed_t
  y: number = 0;
  z: number = 0;           // floor height
  angle: number = 0;       // BAM angle
  viewz: number = 0;       // eye height
  momx: number = 0;        // momentum
  momy: number = 0;
  momz: number = 0;        // vertical momentum (gravity)
  health: number = 100;
  armor: number = 0;
  armortype: number = 0;  // 0=none, 1=green(1/3 absorb), 2=blue(1/2 absorb)
  keys: boolean[] = new Array(6).fill(false); // blue/yellow/red card, blue/yellow/red skull
  damagecount: number = 0;   // damage flash counter (decrements per tick)
  bonuscount: number = 0;    // bonus pickup flash counter
  powers: number[] = new Array(PowerType.NUMPOWERS).fill(0); // powerup timers
  playerstate: PlayerState = PlayerState.LIVE;
  message: string | null = null; // HUD message (set by pickups, cleared by HU_Ticker)
  cheats: number = 0;            // cheat flags bitfield (CF_GODMODE, CF_NOCLIP)

  // View height (P_CalcHeight from p_user.c)
  viewheight: number = VIEWHEIGHT;        // current eye height (ramps up on spawn)
  deltaviewheight: number = 0;            // speed of viewheight change
  bob: number = 0;                        // bounded/scaled total momentum

  // Weapon system (implements WeaponPlayer)
  readyweapon: WeaponType = WeaponType.pistol;
  pendingweapon: WeaponType = WeaponType.nochange;
  ammo: number[] = [];
  maxammo: number[] = [];
  weaponowned: boolean[] = [];
  psprites: PspDef[] = [];
  attackdown: boolean = false;
  refire: number = 0;

  gi: GameInstance;
  private map: GameMap;
  private usePressed: boolean = false;  // debounce for Use action
  private prevx: number = 0;           // previous position for line crossing
  private prevy: number = 0;
  private stuckTicks: number = 0;      // consecutive ticks of failed movement

  constructor(map: GameMap, gi: GameInstance) {
    this.map = map;
    this.gi = gi;
  }

  /** Update the map reference (on level change without recreating Player) */
  setMap(map: GameMap): void {
    this.map = map;
  }

  /** Spawn the player at the first player 1 start thing */
  spawn(): void {
    const p1Start = this.map.things.find(t => t.type === 1);
    if (p1Start) {
      this.x = p1Start.x << FRACBITS;
      this.y = p1Start.y << FRACBITS;
      this.angle = ((p1Start.angle * 0x100000000 / 360) >>> 0);
    } else {
      // Default position
      this.x = 0;
      this.y = 0;
      this.angle = 0;
    }

    // Find floor height at spawn position
    const ss = this.map.pointInSubsector(this.x, this.y);
    this.z = ss.sector ? ss.sector.floorHeight : 0;
    this.viewheight = VIEWHEIGHT;       // instant full height (no ramp)
    this.deltaviewheight = 0;
    this.viewz = this.z + VIEWHEIGHT;
    this.momx = 0;
    this.momy = 0;
    this.momz = 0;
    this.stuckTicks = 0;

    // Initialize weapons
    initPlayerWeapons(this);

    // Reset powerup timers
    this.powers.fill(0);

    // Reset armor
    this.armortype = 0;

    // Reset state
    this.playerstate = PlayerState.LIVE;
    this.health = 100;
    this.armor = 0;
    this.damagecount = 0;
    this.bonuscount = 0;
    this.cheats = 0;
    this.bob = 0;
    this.refire = 0;
    this.attackdown = false;
    this.message = null;
    this.keys.fill(false);

    // Clear accumulated mouse input so stale movement from
    // death / wipe doesn't override the spawn angle on first tick
    resetInputAccumulated();
  }

  /**
   * G_PlayerFinishLevel — called when completing a level.
   * Clears powerups, keys, damage/bonus flash.
   * Player KEEPS weapons, ammo, health, and armor.
   * Reference: g_game.c G_PlayerFinishLevel
   */
  finishLevel(): void {
    this.powers.fill(0);
    this.keys.fill(false);
    this.damagecount = 0;
    this.bonuscount = 0;
    this.cheats = 0;      // cancel god mode etc.
    this.message = null;
  }

  /**
   * Respawn the player at the new map's start position.
   * KEEPS weapons, ammo, health, and armor (level transition).
   * Only resets position, momentum, viewheight, and weapon state machine.
   * Reference: g_game.c — G_DoCompleted does NOT call G_PlayerReborn.
   */
  respawnAtStart(): void {
    const p1Start = this.map.things.find(t => t.type === 1);
    if (p1Start) {
      this.x = p1Start.x << FRACBITS;
      this.y = p1Start.y << FRACBITS;
      this.angle = ((p1Start.angle * 0x100000000 / 360) >>> 0);
    } else {
      this.x = 0;
      this.y = 0;
      this.angle = 0;
    }

    // Find floor height at spawn position
    const ss = this.map.pointInSubsector(this.x, this.y);
    this.z = ss.sector ? ss.sector.floorHeight : 0;
    this.viewheight = VIEWHEIGHT;
    this.deltaviewheight = 0;
    this.viewz = this.z + VIEWHEIGHT;
    this.momx = 0;
    this.momy = 0;
    this.momz = 0;
    this.stuckTicks = 0;

    // Reset weapon state machine (psprites) but keep owned weapons & ammo
    this.pendingweapon = WeaponType.nochange;
    this.attackdown = false;
    this.refire = 0;
    this.psprites = [createPspDef(), createPspDef()];
    // Bring up current weapon
    bringUpWeapon(this);

    // Reset player state
    this.playerstate = PlayerState.LIVE;
    this.bob = 0;

    // Clear accumulated mouse input
    resetInputAccumulated();
  }

  /** Process input and update player state */
  tick(): void {
    // Dead player — route to deathThink (DOOM: P_PlayerThink)
    if (this.playerstate === PlayerState.DEAD) {
      this.deathThink();
      return;
    }

    const input = getInput();

    // Turning
    let turnSpeed = ANGLETURN;
    let moveSpeed = FORWARDMOVE;
    if (input.run) {
      turnSpeed *= 2;
      moveSpeed *= 2;
    }

    if (input.turnLeft) {
      this.angle = (this.angle + (turnSpeed << 16)) >>> 0;
    }
    if (input.turnRight) {
      this.angle = (this.angle - (turnSpeed << 16)) >>> 0;
    }

    // Mouse turning
    if (input.lookX !== 0) {
      this.angle = (this.angle - (input.lookX * MOUSE_SENSITIVITY << 16)) >>> 0;
    }
    // Note: resetInputAccumulated() is called after weapon selection below
    // so weaponSelect survives until it's processed

    // Thrust (momentum-based, like original DOOM P_Thrust)
    // Original: P_Thrust(mo, mo->angle, cmd->forwardmove * 2048);
    const fineAngle = (this.angle >>> ANGLETOFINESHIFT) & FINEMASK;
    const forwardx = finecosine(fineAngle);
    const forwardy = finesine[fineAngle];

    if (input.forward) {
      const thrust = moveSpeed * 2048;
      this.momx += fixedMul(thrust, forwardx);
      this.momy += fixedMul(thrust, forwardy);
    }
    if (input.backward) {
      const thrust = moveSpeed * 2048;
      this.momx -= fixedMul(thrust, forwardx);
      this.momy -= fixedMul(thrust, forwardy);
    }

    // Strafe thrust
    if (input.strafeLeft) {
      const strafeAngle = ((this.angle + ANG90) >>> ANGLETOFINESHIFT) & FINEMASK;
      const thrust = SIDEMOVE * 2048;
      this.momx += fixedMul(thrust, finecosine(strafeAngle));
      this.momy += fixedMul(thrust, finesine[strafeAngle]);
    }
    if (input.strafeRight) {
      const strafeAngle = ((this.angle - ANG90) >>> ANGLETOFINESHIFT) & FINEMASK;
      const thrust = SIDEMOVE * 2048;
      this.momx += fixedMul(thrust, finecosine(strafeAngle));
      this.momy += fixedMul(thrust, finesine[strafeAngle]);
    }

    // Use action (debounced — only fires on press, not hold)
    if (input.use && !this.usePressed) {
      this.usePressed = true;
      this.useLines();
    }
    if (!input.use) {
      this.usePressed = false;
    }

    // Fire weapon — just set flag; actual firing happens via A_WeaponReady
    // (DOOM: P_PlayerThink only sets attackdown, never calls P_FireWeapon directly)
    if (input.fire) {
      this.attackdown = true;
    } else {
      this.attackdown = false;
    }

    // Weapon switching via number keys or gamepad D-pad
    // weaponSelect: 0-6 = direct slot, -2 = next, -3 = prev, -1 = none
    // Mapping: 0=fist/chainsaw, 1=pistol, 2=shotgun, 3=chaingun, 4=missile, 5=plasma, 6=bfg
    if (input.weaponSelect >= 0) {
      // Direct weapon slot selection (keyboard 1-7)
      const weaponMap: WeaponType[] = [
        WeaponType.fist,      // 1
        WeaponType.pistol,    // 2
        WeaponType.shotgun,   // 3
        WeaponType.chaingun,  // 4
        WeaponType.missile,   // 5
        WeaponType.plasma,    // 6
        WeaponType.bfg,       // 7
      ];
      const desired = weaponMap[input.weaponSelect];
      if (desired !== undefined && desired !== this.readyweapon) {
        if (this.weaponowned[desired]) {
          const ammoType = weaponinfo[desired]?.ammo;
          if (ammoType === AmmoType.noammo || ammoType === undefined ||
            (ammoType >= 0 && this.ammo[ammoType] > 0)) {
            this.pendingweapon = desired;
          }
        }
      }
      // Special: key 1 toggles fist ↔ chainsaw
      if (input.weaponSelect === 0 && this.readyweapon === WeaponType.fist &&
        this.weaponowned[WeaponType.chainsaw]) {
        this.pendingweapon = WeaponType.chainsaw;
      } else if (input.weaponSelect === 0 && this.readyweapon === WeaponType.chainsaw) {
        this.pendingweapon = WeaponType.fist;
      }
      // Special: key 3 toggles shotgun ↔ super shotgun
      if (input.weaponSelect === 2 && this.readyweapon === WeaponType.shotgun &&
        this.weaponowned[WeaponType.supershotgun] && this.ammo[AmmoType.shell] >= 2) {
        this.pendingweapon = WeaponType.supershotgun;
      } else if (input.weaponSelect === 2 && this.readyweapon === WeaponType.supershotgun &&
        this.weaponowned[WeaponType.shotgun] && this.ammo[AmmoType.shell] > 0) {
        this.pendingweapon = WeaponType.shotgun;
      }
      input.weaponSelect = -1; // consume
    } else if (input.weaponSelect === -2 || input.weaponSelect === -3) {
      // Next/prev weapon cycling (gamepad D-pad)
      // Order: fist, chainsaw, pistol, shotgun, chaingun, missile, plasma, bfg
      const cycleOrder: WeaponType[] = [
        WeaponType.fist, WeaponType.chainsaw, WeaponType.pistol,
        WeaponType.shotgun, WeaponType.supershotgun, WeaponType.chaingun,
        WeaponType.missile, WeaponType.plasma, WeaponType.bfg,
      ];
      const current = this.pendingweapon !== WeaponType.nochange
        ? this.pendingweapon : this.readyweapon;
      const curIdx = cycleOrder.indexOf(current);
      const dir = input.weaponSelect === -2 ? 1 : -1;
      // Scan for the next owned weapon with ammo
      for (let i = 1; i < cycleOrder.length; i++) {
        const idx = ((curIdx + dir * i) % cycleOrder.length + cycleOrder.length) % cycleOrder.length;
        const wp = cycleOrder[idx];
        if (!this.weaponowned[wp]) continue;
        const ammoType = weaponinfo[wp]?.ammo;
        if (ammoType !== AmmoType.noammo && ammoType !== undefined &&
          ammoType >= 0 && this.ammo[ammoType] <= 0) continue;
        this.pendingweapon = wp;
        break;
      }
      input.weaponSelect = -1; // consume
    }

    // Reset accumulated input (mouse delta + weapon select) AFTER weapon processing
    resetInputAccumulated();

    // Save previous position for walk-trigger detection
    this.prevx = this.x;
    this.prevy = this.y;

    // Apply momentum with collision
    if (this.momx !== 0 || this.momy !== 0) {
      this.tryMove(this.momx, this.momy);

      // Apply friction (original DOOM: P_XYMovement)
      this.momx = fixedMul(this.momx, FRICTION);
      this.momy = fixedMul(this.momy, FRICTION);

      // Stop if very slow
      if (Math.abs(this.momx) < 0x1000) this.momx = 0;
      if (Math.abs(this.momy) < 0x1000) this.momy = 0;
    }

    // Check if player crossed any special lines (walk triggers)
    if (this.x !== this.prevx || this.y !== this.prevy) {
      this.checkLineCrossings();
    }

    // Update floor height (P_ZMovement from p_mobj.c)
    const ss = this.map.pointInSubsector(this.x, this.y);
    if (ss.sector) {
      const floorH = ss.sector.floorHeight;
      const ceilH = ss.sector.ceilingHeight;

      if (this.z > floorH) {
        if (this.momz === 0 && (this.z - floorH) <= MAXSTEPHEIGHT) {
          // Small step down — snap to floor (like DOOM stair stepping)
          this.z = floorH;
        } else {
          // Genuine fall — accelerating gravity
          this.momz -= FRACUNIT; // GRAVITY = FRACUNIT per tick
          // Cap fall speed to prevent overshooting
          if (this.momz < -16 * FRACUNIT) this.momz = -16 * FRACUNIT;
          this.z += this.momz;
          if (this.z <= floorH) {
            this.z = floorH;
            this.momz = 0; // landed
          }
        }
      } else {
        // On or below floor — step up smoothing
        // When stepping up, reduce viewheight by the step amount
        // so the camera smoothly rises instead of jumping
        const stepDelta = floorH - this.z;
        if (stepDelta > 0 && stepDelta <= MAXSTEPHEIGHT) {
          // Smooth stair stepping: crunch viewheight down by step amount,
          // deltaviewheight will ramp it back in P_CalcHeight
          this.viewheight -= stepDelta;
          this.deltaviewheight = ((VIEWHEIGHT - this.viewheight) >> 3);
          if (this.deltaviewheight === 0) this.deltaviewheight = 1;
        }
        this.z = floorH;
        if (this.momz < 0) this.momz = 0;
      }

      // Clamp to ceiling — don't let player's head go above ceiling
      // This prevents falling through geometry when a door closes on you
      if (this.z + PLAYERHEIGHT > ceilH) {
        this.z = ceilH - PLAYERHEIGHT;
        if (this.z < floorH) {
          this.z = floorH; // crushed — stay on floor
        }
      }
    }

    // P_CalcHeight — calculate walking/running height adjustment
    // Direct port from DOOM's p_user.c
    this.calcHeight();

    // Check for item pickups (P_TouchSpecialThing)
    checkPickups(this, this.map.things, this.gi);

    // Tick weapon state machine
    movePsprites(this);

    // Counters, time dependant power ups (P_PlayerThink)
    // Strength counts UP to diminish berserk red fade
    if (this.powers[PowerType.strength]) {
      this.powers[PowerType.strength]++;
    }

    if (this.powers[PowerType.invulnerability]) {
      this.powers[PowerType.invulnerability]--;
    }

    if (this.powers[PowerType.invisibility]) {
      this.powers[PowerType.invisibility]--;
    }

    if (this.powers[PowerType.infrared]) {
      this.powers[PowerType.infrared]--;
    }

    if (this.powers[PowerType.ironfeet]) {
      this.powers[PowerType.ironfeet]--;
    }

    // Decrement flash counters
    if (this.damagecount) {
      this.damagecount--;
    }

    if (this.bonuscount) {
      this.bonuscount--;
    }

    // Check special sector damage (nukage, hellslime, etc.)
    this.playerInSpecialSector();
  }

  /**
   * P_PlayerInSpecialSector — check if the player is standing in a
   * damaging sector (nukage, hellslime, etc.) and apply damage.
   * Called every tick from P_PlayerThink.
   */
  private playerInSpecialSector(): void {
    const ss = this.map.pointInSubsector(this.x, this.y);
    if (!ss.sector) return;

    const sector = ss.sector;
    if (!sector.special) return;

    // Only take damage if player is on the floor
    if (this.z !== sector.floorHeight) return;

    switch (sector.special) {
      case 5:
        // HELLSLIME DAMAGE — 10 every 32 ticks
        if (!this.powers[PowerType.ironfeet]) {
          if (!(getLevelTime(this.gi) & 0x1f)) {
            this.takeDamage(10);
          }
        }
        break;

      case 7:
        // NUKAGE DAMAGE — 5 every 32 ticks
        if (!this.powers[PowerType.ironfeet]) {
          if (!(getLevelTime(this.gi) & 0x1f)) {
            this.takeDamage(5);
          }
        }
        break;

      case 16:
      case 4:
        // SUPER HELLSLIME / STROBE HURT — 20 every 32 ticks
        // Radiation suit has small chance of failing (P_Random() < 5)
        if (!this.powers[PowerType.ironfeet] || Math.random() < 5 / 256) {
          if (!(getLevelTime(this.gi) & 0x1f)) {
            this.takeDamage(20);
          }
        }
        break;

      case 9:
        // SECRET SECTOR
        sector.special = 0;
        break;

      case 11:
        // EXIT SUPER DAMAGE (E1M8 finale) — 20 every 32 ticks, ignores cheats
        if (!(getLevelTime(this.gi) & 0x1f)) {
          this.takeDamage(20);
        }
        break;
    }
  }

  /**
   * P_CalcHeight — direct port from DOOM's p_user.c
   * Calculates view bobbing from momentum and updates viewz.
   */
  private calcHeight(): void {
    // Regular movement bobbing
    // (needs to be calculated for gun swing even if not on ground)
    this.bob = fixedMul(this.momx, this.momx) + fixedMul(this.momy, this.momy);
    this.bob >>= 2;
    if (this.bob > MAXBOB) this.bob = MAXBOB;

    // Check if on ground
    const ss = this.map.pointInSubsector(this.x, this.y);
    const onground = ss.sector ? this.z <= ss.sector.floorHeight : true;

    if (!onground) {
      // Not on ground — no bob, just use viewheight
      this.viewz = this.z + this.viewheight;
      return;
    }

    // Bob oscillation using finesine (DOOM: FINEANGLES/20 * leveltime)
    const angle = (((FINEANGLES / 20) * getLevelTime(this.gi)) | 0) & FINEMASK;
    const bobOffset = fixedMul(this.bob >> 1, finesine[angle]);

    // Move viewheight toward VIEWHEIGHT (smooth transition on spawn)
    this.viewheight += this.deltaviewheight;

    if (this.viewheight > VIEWHEIGHT) {
      this.viewheight = VIEWHEIGHT;
      this.deltaviewheight = 0;
    }

    if (this.viewheight < (VIEWHEIGHT >> 1)) {
      this.viewheight = VIEWHEIGHT >> 1;
      if (this.deltaviewheight <= 0) {
        this.deltaviewheight = 1;
      }
    }

    if (this.deltaviewheight !== 0) {
      this.deltaviewheight += (FRACUNIT >> 2);
      if (this.deltaviewheight === 0) {
        this.deltaviewheight = 1;
      }
    }

    this.viewz = this.z + this.viewheight + bobOffset;

    // Clamp to ceiling
    if (ss.sector) {
      const ceilz = ss.sector.ceilingHeight;
      if (this.viewz > ceilz - 4 * FRACUNIT) {
        this.viewz = ceilz - 4 * FRACUNIT;
      }
    }
  }

  /**
   * Apply damage to the player (from P_DamageMobj in p_inter.c).
   * Handles armor absorption, health reduction, damage flash (damagecount),
   * and knockback thrust from an explosion/damage source.
   *
   * @param damage Raw damage amount
   * @param sourceX Source X position (for knockback direction), or undefined for no thrust
   * @param sourceY Source Y position (for knockback direction), or undefined for no thrust
   * @returns true if player died
   */
  takeDamage(damage: number, sourceX?: number, sourceY?: number): boolean {
    if (this.health <= 0) return false;

    // God mode check (IDDQD cheat)
    if (this.cheats & CF_GODMODE) {
      return false;
    }

    // Invulnerability check
    if (damage < 1000 && this.powers[PowerType.invulnerability]) {
      return false;
    }

    // Skill damage multiplier (Baby = 50%)
    damage = Math.round(damage * getDamageMultiplier(this.gi));

    // Armor absorption (matches DOOM: type 1 = 1/3, type 2 = 1/2)
    if (this.armortype > 0) {
      let saved: number;
      if (this.armortype === 1) {
        saved = Math.floor(damage / 3);
      } else {
        saved = Math.floor(damage / 2);
      }

      if (this.armor <= saved) {
        // Armor is used up
        saved = this.armor;
        this.armortype = 0;
      }
      this.armor -= saved;
      damage -= saved;
    }

    // Apply damage to health
    this.health -= damage;
    if (this.health < 0) this.health = 0;

    // Damage flash counter (capped at 100, like DOOM)
    this.damagecount += damage;
    if (this.damagecount > 100) this.damagecount = 100;

    // Knockback thrust from source position
    if (sourceX !== undefined && sourceY !== undefined) {
      const dx = this.x - sourceX;
      const dy = this.y - sourceY;
      const ang = Math.atan2(dy / FRACUNIT, dx / FRACUNIT);
      // thrust = damage * (FRACUNIT >> 3) * 100 / mass
      // Player mass = 100 in DOOM, so thrust = damage * (FRACUNIT >> 3)
      const thrust = damage * (FRACUNIT >> 3);
      this.momx += Math.round(thrust * Math.cos(ang));
      this.momy += Math.round(thrust * Math.sin(ang));
    }

    // Check for death
    if (this.health <= 0) {
      this.health = 0;
      this.playerstate = PlayerState.DEAD;
      FX_Sound(null, Sfx.pldeth);
      dropWeapon(this);
      console.log('[player] DEAD — health reached 0');
      return true;
    }

    // Pain sound (only if still alive)
    FX_Sound(null, Sfx.plpain);
    return false;
  }

  /**
   * P_DeathThink — "Fall on your face when dying."
   * Decrease POV height to floor height.
   * Fade damage flash. Press Use to restart.
   */
  private deathThink(): void {
    const DEATH_VIEWHEIGHT = 6 << FRACBITS; // Camera drops almost to the floor

    // Continue ticking weapon sprites (so weapon lowers off screen)
    movePsprites(this);

    // Fall to the ground — lower viewheight toward floor
    if (this.viewheight > DEATH_VIEWHEIGHT) {
      this.viewheight -= FRACUNIT;
    }
    if (this.viewheight < DEATH_VIEWHEIGHT) {
      this.viewheight = DEATH_VIEWHEIGHT;
    }
    this.deltaviewheight = 0;

    // Recalculate viewz (no bobbing when dead)
    this.viewz = this.z + this.viewheight;

    // Clamp viewz to ceiling
    const ss = this.map.pointInSubsector(this.x, this.y);
    if (ss.sector) {
      const ceilz = ss.sector.ceilingHeight;
      if (this.viewz > ceilz - 4 * FRACUNIT) {
        this.viewz = ceilz - 4 * FRACUNIT;
      }
    }

    // Fade damage flash
    if (this.damagecount) {
      this.damagecount--;
    }

    // Apply friction to slow down any remaining momentum from knockback
    if (this.momx !== 0 || this.momy !== 0) {
      this.tryMove(this.momx, this.momy);
      this.momx = fixedMul(this.momx, 0xE800); // FRICTION
      this.momy = fixedMul(this.momy, 0xE800);
      if (Math.abs(this.momx) < 0x1000) this.momx = 0;
      if (Math.abs(this.momy) < 0x1000) this.momy = 0;
    }

    // Update Z position after knockback movement — keep player on floor
    // (normal tick() does this but deathThink() returns early, skipping it)
    const ssZ = this.map.pointInSubsector(this.x, this.y);
    if (ssZ.sector) {
      const floorH = ssZ.sector.floorHeight;
      const ceilH = ssZ.sector.ceilingHeight;
      // Snap to floor (dead players don't jump/fall)
      this.z = floorH;
      this.momz = 0;
      // Clamp to ceiling
      if (this.z + PLAYERHEIGHT > ceilH) {
        this.z = ceilH - PLAYERHEIGHT;
        if (this.z < floorH) this.z = floorH;
      }
      // Recalculate viewz with corrected z
      this.viewz = this.z + this.viewheight;
      if (this.viewz > ceilH - 4 * FRACUNIT) {
        this.viewz = ceilH - 4 * FRACUNIT;
      }
    }

    // Press Use to respawn (DOOM: BT_USE)
    const input = getInput();
    if (input.use) {
      this.playerstate = PlayerState.REBORN;
      console.log('[player] REBORN triggered — Use pressed');
    }
  }

  // ===========================================================
  // Collision Detection (P_CheckPosition / P_BoxOnLineSide port)
  // ===========================================================

  /**
   * P_PointOnLineSide — determines which side of a line a point is on.
   * Returns 0 (front) or 1 (back).
   * Direct port from DOOM's p_maputl.c.
   */
  private ptOnLineSide(
    x: number, y: number,
    lx: number, ly: number, ldx: number, ldy: number
  ): number {
    // Cross product using doubles to avoid 32-bit overflow
    const left = (ldy / FRACUNIT) * ((x - lx) / FRACUNIT);
    const right = ((y - ly) / FRACUNIT) * (ldx / FRACUNIT);
    return right < left ? 0 : 1;
  }

  /**
   * P_BoxOnLineSide — determines which side of a linedef a bounding box is on.
   * Returns 0 (front), 1 (back), or -1 (bbox straddles the line).
   * Direct port from DOOM's p_maputl.c.
   *
   * Key difference from the old distance-based check: this correctly identifies
   * that a bbox entirely on one side of a line does NOT cross it, even if the
   * center is within PLAYERRADIUS. This prevents false-positive blocking when
   * the player stands near (but on one side of) stair step linedefs.
   */
  private boxOnLineSide(
    bboxTop: number, bboxBottom: number, bboxLeft: number, bboxRight: number,
    lx: number, ly: number, ldx: number, ldy: number
  ): number {
    let p1: number, p2: number;

    if (ldx === 0) {
      // Vertical line (ST_VERTICAL)
      p1 = bboxRight < lx ? 1 : 0;
      p2 = bboxLeft < lx ? 1 : 0;
      if (ldy < 0) { p1 ^= 1; p2 ^= 1; }
    } else if (ldy === 0) {
      // Horizontal line (ST_HORIZONTAL)
      p1 = bboxTop > ly ? 1 : 0;
      p2 = bboxBottom > ly ? 1 : 0;
      if (ldx < 0) { p1 ^= 1; p2 ^= 1; }
    } else {
      // Diagonal — check two diagonally opposite corners
      // that are most likely to be on different sides of the line
      const posSlope = (ldx > 0) === (ldy > 0);
      if (posSlope) {
        // ST_POSITIVE: left-top vs right-bottom
        p1 = this.ptOnLineSide(bboxLeft, bboxTop, lx, ly, ldx, ldy);
        p2 = this.ptOnLineSide(bboxRight, bboxBottom, lx, ly, ldx, ldy);
      } else {
        // ST_NEGATIVE: right-top vs left-bottom
        p1 = this.ptOnLineSide(bboxRight, bboxTop, lx, ly, ldx, ldy);
        p2 = this.ptOnLineSide(bboxLeft, bboxBottom, lx, ly, ldx, ldy);
      }
    }

    return p1 === p2 ? p1 : -1;
  }

  /**
   * Check if moving to (newx, newy) would cross any blocking linedefs.
   * Returns collision info including the blocking linedef direction for wall sliding.
   *
   * Uses P_BoxOnLineSide to properly determine bbox-line intersection,
   * matching original DOOM's P_CheckPosition behavior.
   *
   * Key improvement: if the player's bbox already straddles a linedef at
   * their CURRENT position and the player's center doesn't cross to the
   * other side, the line is not considered blocking. This allows smooth
   * sliding along diagonal walls (where the bbox naturally straddles the
   * extended line even when the player is just walking near the wall).
   */
  private checkPosition(newx: number, newy: number): { blocked: boolean; blockDx: number; blockDy: number } {
    // Noclip cheat — skip all collision
    if (this.cheats & CF_NOCLIP) {
      return { blocked: false, blockDx: 0, blockDy: 0 };
    }

    const ss = this.map.pointInSubsector(newx, newy);
    if (!ss.sector) return { blocked: true, blockDx: 0, blockDy: 0 };

    const bboxTop = newy + PLAYERRADIUS;
    const bboxBottom = newy - PLAYERRADIUS;
    const bboxLeft = newx - PLAYERRADIUS;
    const bboxRight = newx + PLAYERRADIUS;

    // Current position bbox for straddling comparison
    const curTop = this.y + PLAYERRADIUS;
    const curBottom = this.y - PLAYERRADIUS;
    const curLeft = this.x - PLAYERRADIUS;
    const curRight = this.x + PLAYERRADIUS;

    let isBlocked = false;
    let bestBlockDx = 0;
    let bestBlockDy = 0;
    let bestDist = Infinity;

    for (const ld of this.map.linedefs) {
      const v1 = this.map.vertices[ld.v1];
      const v2 = this.map.vertices[ld.v2];

      // Quick bounding box rejection
      const ldLeft = Math.min(v1.x, v2.x);
      const ldRight = Math.max(v1.x, v2.x);
      const ldBottom = Math.min(v1.y, v2.y);
      const ldTop = Math.max(v1.y, v2.y);

      if (ldRight < bboxLeft || ldLeft > bboxRight ||
        ldTop < bboxBottom || ldBottom > bboxTop) {
        continue;
      }

      // P_BoxOnLineSide — does the player bbox actually straddle this line?
      // If the bbox is entirely on one side, the line does not block.
      const side = this.boxOnLineSide(
        bboxTop, bboxBottom, bboxLeft, bboxRight,
        v1.x, v1.y, ld.dx, ld.dy
      );
      if (side !== -1) continue; // bbox entirely on one side — not crossing

      // If the current bbox also straddles this line, only block when the
      // player's center actually crosses to the other side of the line.
      // This allows sliding along diagonal walls: the bbox naturally extends
      // across the line's extension, but the player isn't really crossing it.
      const curSide = this.boxOnLineSide(
        curTop, curBottom, curLeft, curRight,
        v1.x, v1.y, ld.dx, ld.dy
      );
      if (curSide === -1) {
        const curCenter = this.ptOnLineSide(this.x, this.y, v1.x, v1.y, ld.dx, ld.dy);
        const newCenter = this.ptOnLineSide(newx, newy, v1.x, v1.y, ld.dx, ld.dy);
        if (curCenter === newCenter) {
          continue; // movement parallel to wall — center stays on same side
        }
      }

      // Determine if this linedef actually blocks movement
      let blocking = false;

      // One-sided line — always blocks
      if (!(ld.flags & ML_TWOSIDED)) {
        blocking = true;
      }
      // ML_BLOCKING flag — blocks players
      else if (ld.flags & ML_BLOCKING) {
        blocking = true;
      } else {
        // Two-sided: check height gaps
        const front = ld.frontsector;
        const back = ld.backsector;
        if (!front || !back) {
          blocking = true;
        } else {
          const openTop = Math.min(front.ceilingHeight, back.ceilingHeight);
          const openBottom = Math.max(front.floorHeight, back.floorHeight);
          const openRange = openTop - openBottom;

          if (openRange < PLAYERHEIGHT) {
            blocking = true;
          } else if (openBottom - this.z > MAXSTEPHEIGHT) {
            blocking = true;
          } else if (openTop - this.z < PLAYERHEIGHT) {
            blocking = true;
          }
        }
      }

      if (blocking) {
        isBlocked = true;

        // Track the closest blocking linedef (by perpendicular distance)
        // so wall sliding uses the most relevant wall, not just the first
        // one in the array.
        const lenSq = (ld.dx / FRACUNIT) * (ld.dx / FRACUNIT) + (ld.dy / FRACUNIT) * (ld.dy / FRACUNIT);
        if (lenSq > 0) {
          const cross = Math.abs(
            ((newx - v1.x) / FRACUNIT) * (ld.dy / FRACUNIT) -
            ((newy - v1.y) / FRACUNIT) * (ld.dx / FRACUNIT)
          );
          const dist = cross / Math.sqrt(lenSq);
          if (dist < bestDist) {
            bestDist = dist;
            bestBlockDx = ld.dx;
            bestBlockDy = ld.dy;
          }
        }
      }
    }

    // ---- Thing-thing collision (PIT_CheckThing) ----
    // Block movement if the player's bounding box overlaps any MF_SOLID thing
    if (!isBlocked) {
      for (const obj of getMapObjects(this.gi)) {
        if (obj.removed) continue;
        if (!(obj.flags & MF_SOLID)) continue;

        // Standard DOOM bounding box overlap: |dx| < r1+r2 && |dy| < r1+r2
        const blockDist = PLAYERRADIUS + obj.radius;
        const adx = Math.abs(newx - obj.x);
        const ady = Math.abs(newy - obj.y);

        if (adx < blockDist && ady < blockDist) {
          // Don't block if we're already overlapping this thing at our current position
          // (prevents getting permanently stuck inside things)
          const curAdx = Math.abs(this.x - obj.x);
          const curAdy = Math.abs(this.y - obj.y);
          if (curAdx < blockDist && curAdy < blockDist) {
            continue; // already overlapping — let player move out
          }
          isBlocked = true;
          break;
        }
      }
    }

    return { blocked: isBlocked, blockDx: bestBlockDx, blockDy: bestBlockDy };
  }

  // ===========================================================
  // Movement with Wall Sliding (P_TryMove / P_SlideMove port)
  // ===========================================================

  /**
   * P_TryMove / P_SlideMove — move with collision and wall sliding.
   *
   * Strategy (matches original DOOM flow):
   * 1. Try full move
   * 2. Wall slide: project movement along the blocking wall, retry up to 3 times
   *    (handles corners where two walls meet — each retry projects onto the next wall)
   * 3. Stairstep fallback: try Y-only, then X-only (DOOM's P_SlideMove stairstep)
   * 4. If fully blocked, zero momentum and run stuck recovery after several ticks
   */
  private tryMove(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;

    // 1. Try full move
    let res = this.checkPosition(this.x + dx, this.y + dy);
    if (!res.blocked) {
      this.x += dx;
      this.y += dy;
      this.stuckTicks = 0;
      return;
    }

    // 2. Wall sliding with retry (P_SlideMove approach)
    //    Each iteration projects movement onto the blocking wall, then
    //    tries again. If a different wall blocks, the next iteration
    //    projects onto that wall. Up to 3 attempts before stairstep.
    let slideDx = dx;
    let slideDy = dy;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (res.blockDx === 0 && res.blockDy === 0) break;

      // Project movement along the blocking wall (P_HitSlideLine)
      const bldx = res.blockDx / FRACUNIT;
      const bldy = res.blockDy / FRACUNIT;
      const blen2 = bldx * bldx + bldy * bldy;
      if (blen2 <= 0) break;

      const dot = ((slideDx / FRACUNIT) * bldx + (slideDy / FRACUNIT) * bldy) / blen2;
      slideDx = Math.round(dot * bldx * FRACUNIT);
      slideDy = Math.round(dot * bldy * FRACUNIT);

      // Stop if slide vector is too small to be meaningful
      if (Math.abs(slideDx) < 0x1000 && Math.abs(slideDy) < 0x1000) break;

      // Try the projected movement
      res = this.checkPosition(this.x + slideDx, this.y + slideDy);
      if (!res.blocked) {
        this.x += slideDx;
        this.y += slideDy;
        this.stuckTicks = 0;
        return;
      }
    }

    // 3. Stairstep fallback: try each axis independently (DOOM: P_SlideMove stairstep)
    if (dy !== 0) {
      const yResult = this.checkPosition(this.x, this.y + dy);
      if (!yResult.blocked) {
        this.y += dy;
        this.momx = 0;
        this.stuckTicks = 0;
        return;
      }
    }

    if (dx !== 0) {
      const xResult = this.checkPosition(this.x + dx, this.y);
      if (!xResult.blocked) {
        this.x += dx;
        this.momy = 0;
        this.stuckTicks = 0;
        return;
      }
    }

    // 4. Fully blocked — increment stuck counter
    this.momx = 0;
    this.momy = 0;
    this.stuckTicks++;

    // 5. Stuck recovery: nudge player out of geometry after several failed ticks
    if (this.stuckTicks > 5) {
      this.tryUnstuck();
    }
  }

  /**
   * Attempt to escape from stuck position by nudging in various directions.
   * Tries small movements in 8 compass directions at increasing distances.
   * This handles cases where the player landed inside geometry from a fall,
   * or was pushed into a wall by a moving sector (door/lift).
   */
  private tryUnstuck(): void {
    const NUDGE = FRACUNIT; // 1 map unit per step
    const directions = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];

    for (let dist = 1; dist <= 32; dist++) {
      for (const [nx, ny] of directions) {
        const testX = this.x + nx * dist * NUDGE;
        const testY = this.y + ny * dist * NUDGE;
        const result = this.checkPosition(testX, testY);
        if (!result.blocked) {
          this.x = testX;
          this.y = testY;
          this.stuckTicks = 0;
          // Snap to floor at new position
          const ss = this.map.pointInSubsector(this.x, this.y);
          if (ss.sector) {
            this.z = ss.sector.floorHeight;
            this.momz = 0;
          }
          return;
        }
      }
    }
  }

  /**
   * P_UseLines — trace forward from the player to find special lines.
   * Simplified version: instead of P_PathTraverse, we iterate linedefs
   * within USERANGE and find the closest one the player is facing.
   */
  private useLines(): void {
    const fineAngle = (this.angle >>> ANGLETOFINESHIFT) & FINEMASK;
    const useDx = fixedMul(USERANGE, finecosine(fineAngle));
    const useDy = fixedMul(USERANGE, finesine[fineAngle]);
    const x2 = this.x + useDx;
    const y2 = this.y + useDy;

    let bestFrac = 2.0; // > 1.0 means nothing found yet
    let bestLine: LineDef | null = null;

    for (const ld of this.map.linedefs) {
      if (ld.special === 0) continue;

      const v1 = this.map.vertices[ld.v1];
      const v2 = this.map.vertices[ld.v2];

      // Quick distance check
      const midx = (v1.x + v2.x) >> 1;
      const midy = (v1.y + v2.y) >> 1;
      const dx = Math.abs(midx - this.x);
      const dy = Math.abs(midy - this.y);
      if (dx > USERANGE * 2 || dy > USERANGE * 2) continue;

      // DOOM-style intersection: check if linedef endpoints are on
      // opposite sides of the trace (PIT_AddLineIntercepts)
      const s1 = this.pointOnTraceSide(v1.x, v1.y, this.x, this.y, useDx, useDy);
      const s2 = this.pointOnTraceSide(v2.x, v2.y, this.x, this.y, useDx, useDy);
      if (s1 === s2) continue; // linedef doesn't cross trace

      // Compute intersection fraction along the trace (P_InterceptVector)
      const ldx = v2.x - v1.x;
      const ldy = v2.y - v1.y;
      const den = (useDx / FRACUNIT) * (ldy / FRACUNIT) -
                  (useDy / FRACUNIT) * (ldx / FRACUNIT);
      if (Math.abs(den) < 0.001) continue; // parallel

      const num = ((v1.x - this.x) / FRACUNIT) * (ldy / FRACUNIT) -
                  ((v1.y - this.y) / FRACUNIT) * (ldx / FRACUNIT);
      const frac = num / den;
      if (frac < 0 || frac > 1) continue; // behind player or beyond range

      if (frac < bestFrac) {
        bestFrac = frac;
        bestLine = ld;
      }
    }

    if (bestLine) {
      useSpecialLine(bestLine, this, this.gi);
    }
  }

  /** Which side of a trace ray (ox,oy)+(dx,dy) is point (px,py) on? */
  private pointOnTraceSide(
    px: number, py: number,
    ox: number, oy: number,
    tdx: number, tdy: number,
  ): number {
    const dx = (px - ox) / FRACUNIT;
    const dy = (py - oy) / FRACUNIT;
    const left = (tdy / FRACUNIT) * dx;
    const right = dy * (tdx / FRACUNIT);
    return right < left ? 0 : 1;
  }

  /**
   * Check if the player crossed any linedefs with walk-trigger specials.
   */
  private checkLineCrossings(): void {
    for (const ld of this.map.linedefs) {
      if (ld.special === 0) continue;

      const v1 = this.map.vertices[ld.v1];
      const v2 = this.map.vertices[ld.v2];

      // Quick distance rejection
      const midx = (v1.x + v2.x) >> 1;
      const midy = (v1.y + v2.y) >> 1;
      const dx = Math.abs(midx - this.x);
      const dy = Math.abs(midy - this.y);
      if (dx > PLAYERRADIUS * 4 || dy > PLAYERRADIUS * 4) continue;

      // Was the player on one side before and the other side now?
      const oldSide = this.lineSide(this.prevx, this.prevy, v1, v2);
      const newSide = this.lineSide(this.x, this.y, v1, v2);

      if (oldSide !== newSide) {
        // Pass oldSide — the side the player crossed FROM
        // (matches DOOM's P_CrossSpecialLine convention)
        crossSpecialLine(ld, oldSide, this, this.gi);
      }
    }
  }

  /** Returns which side of a line a point is on (0=front, 1=back) */
  private lineSide(px: number, py: number, v1: { x: number, y: number }, v2: { x: number, y: number }): number {
    const ldx = v2.x - v1.x;
    const ldy = v2.y - v1.y;
    const cross = ((px - v1.x) / FRACUNIT) * (ldy / FRACUNIT) -
      ((py - v1.y) / FRACUNIT) * (ldx / FRACUNIT);
    return cross <= 0 ? 1 : 0;
  }
}
