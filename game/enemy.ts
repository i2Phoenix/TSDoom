// ============================================================
// Enemy AI — Monster behavior system
// Port of p_enemy.c — A_Look, P_NoiseAlert, P_LookForPlayers
// ============================================================

import { FRACBITS, FRACUNIT, ANG90, ANG180, ANG270, ANGLETOFINESHIFT, FINEMASK, finesine, finecosine, fixedMul, fixedDiv } from './math';

// ANG90/2 for gradual turning in A_Chase (original DOOM uses ANG90/2 = 0x20000000)
const ANG90_HALF = (ANG90 >>> 1) >>> 0;
import { GameMap, Sector, LineDef, ML_TWOSIDED, ML_SOUNDBLOCK } from '../src/map';
import { MapObjState, getMapObjects, getMapObjectByThingIndex, DI_NODIR, damageMobj } from './mobj';
import { MF_SHOOTABLE, MF_AMBUSH, MF_COUNTKILL, MF_JUSTHIT, MF_JUSTATTACKED, MF_FLOAT, MF_NOGRAVITY, MF_SHADOW, MF_CORPSE } from './mobjinfo';
import { P_CheckSight } from './sight';
import { P_Random } from './random';
import { Player } from './player';
import { registerActionCallback, setMonsterState, getThingAnimDef } from './animations';
import { P_Move, P_NewChaseDir, P_CheckMeleeRange, P_CheckMissileRange } from './p_move';
import { FX_Sound } from './effects';
import { Sfx } from './sounds';
import { spawnMonsterProjectile, ProjectileType } from './projectiles';
import { traceWalls } from './combat';
import { P_AimLineAttack, P_LineAttack } from './combat';
import { getWorld } from './world';

// ---- Constants ----
const MELEERANGE = 64 * FRACUNIT;
const MISSILERANGE = 32 * 64 * FRACUNIT;  // 2048 map units

// ---- Sound propagation (P_RecursiveSound / P_NoiseAlert) ----
let soundValidcount = 0;

/**
 * P_RecursiveSound — flood-fill sound through sectors.
 * Sectors connected by two-sided lines propagate sound.
 * ML_SOUNDBLOCK lines allow sound to pass through only once.
 */
function P_RecursiveSound(
  map: GameMap,
  sec: Sector,
  soundblocks: number,
  soundtarget: MapObjState,
): void {
  // Already flooded
  if (sec.validcount === soundValidcount && sec.soundtraversed <= soundblocks + 1) {
    return;
  }

  sec.validcount = soundValidcount;
  sec.soundtraversed = soundblocks + 1;
  sec.soundtarget = soundtarget;

  // Find all linedefs bordering this sector and propagate through two-sided ones
  for (const line of map.linedefs) {
    if (!(line.flags & ML_TWOSIDED)) continue;

    const front = line.frontsector;
    const back = line.backsector;
    if (!front || !back) continue;

    // Determine the "other" sector
    let other: Sector | null = null;
    if (front === sec) other = back;
    else if (back === sec) other = front;
    else continue;

    // Check if the opening is large enough for sound
    const opentop = Math.min(front.ceilingHeight, back.ceilingHeight);
    const openbottom = Math.max(front.floorHeight, back.floorHeight);

    // Totally closed — no sound propagation
    if (openbottom >= opentop) continue;

    // ML_SOUNDBLOCK: sound can pass through one sound block line
    if (line.flags & ML_SOUNDBLOCK) {
      if (soundblocks === 0) {
        // First soundblock — pass through but mark as blocked
        P_RecursiveSound(map, other, 1, soundtarget);
      }
      // soundblocks > 0: already passed one block, stop here
    } else {
      P_RecursiveSound(map, other, soundblocks, soundtarget);
    }
  }
}

/**
 * P_NoiseAlert — alert monsters in connected sectors to a sound source.
 * Called when the player fires a weapon.
 *
 * @param target The target MapObjState that made noise (usually a player-shim)
 * @param emitter The MapObjState that emitted the sound
 * @param map The current game map
 */
export function P_NoiseAlert(
  target: MapObjState,
  emitter: MapObjState,
  map: GameMap,
): void {
  soundValidcount++;
  // Find the sector of the emitter
  const ss = map.pointInSubsector(emitter.x, emitter.y);
  if (ss.sector) {
    P_RecursiveSound(map, ss.sector, 0, target);
  }
}

// ---- Player as target ----

/**
 * Create a lightweight MapObjState representing the player for monster targeting.
 * This avoids monsters needing a reference to the Player class directly.
 */
export function createPlayerMobj(player: Player, map: GameMap): MapObjState {
  const ss = map.pointInSubsector(player.x, player.y);
  const floorZ = ss.sector ? ss.sector.floorHeight : 0;
  const ceilZ = ss.sector ? ss.sector.ceilingHeight : 0;
  return {
    thingIndex: -1,  // not a map thing
    x: player.x,
    y: player.y,
    z: player.z,
    health: player.health,
    spawnHealth: 100,
    radius: 16 * FRACUNIT,
    height: 56 * FRACUNIT,
    flags: MF_SHOOTABLE,
    mass: 100,
    type: -1,
    removed: false,
    deathHandled: false,
    mobjType: 0,  // MT_PLAYER
    angle: player.angle,
    movedir: DI_NODIR,
    movecount: 0,
    target: null,
    threshold: 0,
    reactiontime: 0,
    lastlook: 0,
    momx: player.momx,
    momy: player.momy,
    momz: 0,
    floorz: floorZ,
    ceilingz: ceilZ,
    tracer: null,
    info: null,
    spawnX: player.x,
    spawnY: player.y,
    spawnAngle: player.angle,
    respawnTimer: 0,
  };
}

// Module-level player mobj reference (updated each tick)
let playerMobj: MapObjState | null = null;

/** Update the player shim mobj each tick (call from game loop) */
export function updatePlayerMobj(map: GameMap): void {
  const player = getWorld().player;
  if (!playerMobj) {
    playerMobj = createPlayerMobj(player, map);
  } else {
    playerMobj.x = player.x;
    playerMobj.y = player.y;
    playerMobj.z = player.z;
    playerMobj.health = player.health;
    playerMobj.angle = player.angle;
    playerMobj.momx = player.momx;
    playerMobj.momy = player.momy;
    // Clear shootable flag when player is dead so monsters stop targeting
    if (player.health <= 0) {
      playerMobj.flags &= ~MF_SHOOTABLE;
    } else {
      playerMobj.flags |= MF_SHOOTABLE;
    }
  }
}

/** Get the current player mobj */
export function getPlayerMobj(): MapObjState | null {
  return playerMobj;
}

// ---- P_LookForPlayers ----

/**
 * P_LookForPlayers — search for a visible player to target.
 * In single-player DOOM, this looks for player 0.
 *
 * @param actor The monster looking
 * @param allAround If true, skip the 180° field of view check
 * @param map The current game map
 * @returns true if a player was found and set as target
 */
function P_LookForPlayers(
  actor: MapObjState,
  allAround: boolean,
  map: GameMap,
): boolean {
  if (!playerMobj) return false;

  // Player must be alive and shootable
  if (playerMobj.health <= 0) return false;
  if (!(playerMobj.flags & MF_SHOOTABLE)) return false;

  // Check line of sight
  if (!P_CheckSight(actor, playerMobj, map)) return false;

  // Field of view check (180° cone, front only)
  if (!allAround) {
    // Calculate angle from actor to player
    const dx = playerMobj.x - actor.x;
    const dy = playerMobj.y - actor.y;
    const an = ((Math.atan2(dy / FRACUNIT, dx / FRACUNIT) * 0x80000000 / Math.PI) >>> 0);
    const diff = (an - actor.angle) >>> 0;

    // Outside 180° front cone (ANG90 to ANG270 is the back)
    if (diff > ANG90 && diff < ANG270) {
      // Still detect if very close (< MELEERANGE)
      const dist = Math.abs(dx) + Math.abs(dy);
      if (dist > MELEERANGE) {
        return false; // Can't see player (behind)
      }
    }
  }

  // Found the player!
  actor.target = playerMobj;
  return true;
}

// ---- A_Look (called by animation system via registered callback) ----

/**
 * A_Look — monster idle behavior (called by animation system per-tick).
 * Receives thingIndex, looks up the MapObjState, checks for sound targets
 * and visible players. If a target is found, transitions to see/chase state.
 */
function A_Look_impl(thingIndex: number): void {
  const map = getWorld().map;
  if (!map) return;

  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || actor.removed || actor.health <= 0) return;

  // Reset pursuit threshold
  actor.threshold = 0;

  // Check for sound target in our sector
  const ss = map.pointInSubsector(actor.x, actor.y);
  const sector = ss.sector;
  const soundtarget = sector?.soundtarget as MapObjState | null;

  if (soundtarget && (soundtarget.flags & MF_SHOOTABLE)) {
    actor.target = soundtarget;

    // If MF_AMBUSH, still need line of sight to actually wake up
    if (actor.flags & MF_AMBUSH) {
      if (!P_CheckSight(actor, actor.target, map)) {
        // Try looking for players visually instead
        if (!P_LookForPlayers(actor, false, map)) {
          return; // Stay idle
        }
      }
    }
    // Sound target is valid — wake up!
  } else {
    // No sound target — look for players visually
    if (!P_LookForPlayers(actor, false, map)) {
      return; // Stay idle
    }
  }

  // Found a target — transition to see/chase state!
  const animDef = getThingAnimDef(actor.type);
  if (animDef && animDef.seeState !== undefined) {
    setMonsterState(thingIndex, actor.type, animDef.seeState, 'chasing');
    // Play see sound (randomized from array)
    if (animDef.seeSound && animDef.seeSound.length > 0) {
      const sfx = animDef.seeSound[P_Random() % animDef.seeSound.length];
      FX_Sound({ x: actor.x, y: actor.y }, sfx);
    }
  }
}

// ---- A_Chase (full implementation — Phase 4) ----

function A_Chase_impl(thingIndex: number): void {
  const map = getWorld().map;
  if (!map) return;

  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || actor.removed || actor.health <= 0) return;

  // Decrement reactiontime (delay before first attack)
  if (actor.reactiontime > 0) {
    actor.reactiontime--;
  }

  // Decrement threshold (target loyalty for infighting)
  if (actor.threshold > 0) {
    if (!actor.target || actor.target.health <= 0) {
      actor.threshold = 0;
    } else {
      actor.threshold--;
    }
  }

  // Turn towards movement direction (gradual — ANG90/2 per tick, matching original DOOM)
  if (actor.movedir < 8) {
    const exact = (actor.movedir << 29) >>> 0;
    actor.angle = (actor.angle & (7 << 29)) >>> 0;
    const delta = ((actor.angle - exact) | 0);
    if (delta > 0) {
      actor.angle = (actor.angle - ANG90_HALF) >>> 0;
    } else if (delta < 0) {
      actor.angle = (actor.angle + ANG90_HALF) >>> 0;
    }
  }

  // If no target or target is dead → look for players, return to idle
  if (!actor.target || !(actor.target.flags & MF_SHOOTABLE)) {
    if (P_LookForPlayers(actor, true, map)) {
      return; // found new target, stay in chase
    }

    // No target found — return to idle state
    const animDef = getThingAnimDef(actor.type);
    if (animDef) {
      setMonsterState(thingIndex, actor.type, animDef.spawnState, 'alive');
    }
    return;
  }

  // Don't attack twice in a row (MF_JUSTATTACKED)
  // Original DOOM: clear flag, call P_NewChaseDir, then return (skip attack + force movement)
  if (actor.flags & MF_JUSTATTACKED) {
    actor.flags &= ~MF_JUSTATTACKED;
    P_NewChaseDir(actor);
    return;
  }

  // Check melee attack
  const animDef = getThingAnimDef(actor.type);
  if (animDef && animDef.meleeState !== undefined) {
    if (P_CheckMeleeRange(actor)) {
      // TODO: Play attack sound
      setMonsterState(thingIndex, actor.type, animDef.meleeState, 'attacking');
      return;
    }
  }

  // Check ranged attack — gated by movecount (original DOOM: skip if movecount > 0)
  // This ensures monsters walk several steps between ranged attacks
  if (animDef && animDef.missileState !== undefined) {
    if (actor.movecount <= 0) {
      if (P_CheckMissileRange(actor)) {
        setMonsterState(thingIndex, actor.type, animDef.missileState, 'attacking');
        actor.flags |= MF_JUSTATTACKED;
        return;
      }
    }
  }

  // Chase towards target
  if (actor.movecount <= 0 || !P_Move(actor)) {
    P_NewChaseDir(actor);
  }
  actor.movecount--;

  // Active sound (random chance, 3/256)
  if (P_Random() < 3) {
    const animDef2 = getThingAnimDef(actor.type);
    if (animDef2?.activeSound !== undefined) {
      FX_Sound({ x: actor.x, y: actor.y }, animDef2.activeSound);
    }
  }
}

// ---- A_FaceTarget ----

function A_FaceTarget_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;

  // Turn to face target
  const dx = actor.target.x - actor.x;
  const dy = actor.target.y - actor.y;
  actor.angle = ((Math.atan2(dy / FRACUNIT, dx / FRACUNIT) * 0x80000000 / Math.PI) >>> 0);

  // Add some randomness if target has MF_SHADOW (partial invisibility)
  if (actor.target.flags & MF_SHADOW) {
    actor.angle = (actor.angle + ((P_Random() - P_Random()) << 21)) >>> 0;
  }
}

// ---- Registration ----

/**
 * Register AI action callbacks with the animation system.
 * Call once at game start (before any ticks run).
 */
export function initAICallbacks(): void {
  registerActionCallback('A_Look', A_Look_impl);
  registerActionCallback('A_Chase', A_Chase_impl);
  registerActionCallback('A_FaceTarget', A_FaceTarget_impl);

  // Attack callbacks — full implementations (Phase 5)
  registerActionCallback('A_PosAttack', A_PosAttack_impl);
  registerActionCallback('A_SPosAttack', A_SPosAttack_impl);
  registerActionCallback('A_TroopAttack', A_TroopAttack_impl);
  registerActionCallback('A_SargAttack', A_SargAttack_impl);
  registerActionCallback('A_HeadAttack', A_HeadAttack_impl);
  registerActionCallback('A_BruisAttack', A_BruisAttack_impl);
  registerActionCallback('A_CyberAttack', A_CyberAttack_impl);
  registerActionCallback('A_SkullAttack', A_SkullAttack_impl);
  registerActionCallback('A_SpidRefire', A_SpidRefire_impl);
  registerActionCallback('A_Metal', () => {});       // metal footstep sound (cosmetic)
  registerActionCallback('A_CPosAttack', A_CPosAttack_impl);
  registerActionCallback('A_CPosRefire', A_CPosRefire_impl);

  // Arch-vile
  registerActionCallback('A_VileChase', A_VileChase_impl);
  registerActionCallback('A_VileStart', A_VileStart_impl);
  registerActionCallback('A_VileTarget', A_VileTarget_impl);
  registerActionCallback('A_VileAttack', A_VileAttack_impl);
}

// ---- Attack helper: hitscan toward target ----
// Port of original DOOM monster hitscan: A_FaceTarget + ray trace.
// Traces the bullet along the actual spread angle, checks walls via traceWalls,
// and only damages the player if the bullet reaches them without hitting a wall.

function monsterHitscan(actor: MapObjState, damage: number): void {
  if (!actor.target || !getWorld().player) return;
  const playerRef = getWorld().player;
  // Check both playerRef (live data) and target for being dead
  if (playerRef.health <= 0) return;
  if (actor.target.health <= 0) return;

  A_FaceTarget_impl(actor.thingIndex);

  // Add random spread: (P_Random()-P_Random()) << 20 in BAM
  const angle = (actor.angle + ((P_Random() - P_Random()) << 20)) >>> 0;

  // Shoot height: actor z + half height + 8 (same as original DOOM shootz)
  const shootz = actor.z + (actor.height >> 1) + 8 * FRACUNIT;

  // Compute slope toward the target (vertical aiming)
  const tdx = actor.target.x - actor.x;
  const tdy = actor.target.y - actor.y;
  const tDist = Math.max(1, Math.abs(tdx >> FRACBITS) + Math.abs(tdy >> FRACBITS));
  const targetMidZ = actor.target.z + (actor.target.height >> 1);
  const slope = ((targetMidZ - shootz) / tDist) | 0;

  // Ray direction from the spread angle
  const an = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
  const dx = fixedMul(MISSILERANGE, finecosine(an));
  const dy = fixedMul(MISSILERANGE, finesine[an]);

  // Trace walls along the ACTUAL bullet ray to find the nearest wall hit
  const { frac: wallFrac } = traceWalls(actor.x, actor.y, dx, dy, slope, shootz);

  // Now check if the player is hit by this ray BEFORE the wall
  const pdx = playerRef.x - actor.x;
  const pdy = playerRef.y - actor.y;

  // Project player position onto ray direction (distance along ray)
  const dot = fixedMul(pdx, finecosine(an)) + fixedMul(pdy, finesine[an]);
  if (dot <= 0 || dot > MISSILERANGE) return; // player behind or out of range

  // Perpendicular distance from ray to player center
  const perp = Math.abs(fixedMul(pdx, finesine[an]) - fixedMul(pdy, finecosine(an)));
  const playerRadius = 16 * FRACUNIT;
  if (perp > playerRadius) return; // bullet misses player cylinder

  // Fraction along the ray where the player is
  const playerFrac = fixedDiv(dot, MISSILERANGE);

  // Wall is closer than the player — bullet blocked!
  if (playerFrac >= wallFrac) return;

  // Vertical check: does the bullet z at player distance match?
  const hitZ = shootz + fixedMul(slope, dot);
  const pz = playerRef.z;
  const pH = 56 * FRACUNIT; // player height
  if (hitZ < pz || hitZ > pz + pH) return;

  // Also fire P_LineAttack to hit map objects (monsters, barrels) along the way
  // and spawn puffs/blood. This won't damage the player (not in mapObjects).
  P_LineAttack(actor.x, actor.y, shootz, angle, MISSILERANGE, slope, damage);

  // Apply damage to player — bullet passed all checks
  playerRef.takeDamage(damage, actor.x, actor.y);
}

// ---- A_PosAttack — Zombieman: single bullet ----
function A_PosAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  const playerRef = getWorld().player;
  if (playerRef && playerRef.health <= 0) return;

  FX_Sound({ x: actor.x, y: actor.y }, Sfx.pistol);
  const damage = ((P_Random() % 5) + 1) * 3;  // 3-15 damage
  monsterHitscan(actor, damage);
}

// ---- A_SPosAttack — Shotgun Guy: 3 bullets ----
// Original DOOM: 3 separate P_LineAttack calls, each with spread
function A_SPosAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  const playerRef = getWorld().player;
  if (playerRef && playerRef.health <= 0) return;

  FX_Sound({ x: actor.x, y: actor.y }, Sfx.shotgn);

  // 3 bullets, each individually traced (can be blocked by walls separately)
  for (let i = 0; i < 3; i++) {
    const damage = ((P_Random() % 5) + 1) * 3;
    monsterHitscan(actor, damage);
  }
}

// ---- A_CPosAttack — Chaingunner: 1 bullet per frame ----
function A_CPosAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  const playerRef = getWorld().player;
  if (playerRef && playerRef.health <= 0) return;

  FX_Sound({ x: actor.x, y: actor.y }, Sfx.shotgn);
  const damage = ((P_Random() % 5) + 1) * 3;
  monsterHitscan(actor, damage);
}

// ---- A_CPosRefire — Chaingunner refire check ----
function A_CPosRefire_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;

  A_FaceTarget_impl(thingIndex);

  // Random chance to stop firing
  if (P_Random() < 40) return;

  // Stop if target is dead or lost sight
  const map = getWorld().map;
  if (!map) return;
  if (actor.target.health <= 0 || !P_CheckSight(actor, actor.target, map)) {
    // Return to see/chase state
    const animDef = getThingAnimDef(actor.type);
    if (animDef && animDef.seeState !== undefined) {
      setMonsterState(thingIndex, actor.type, animDef.seeState, 'chasing');
    }
  }
}

// ---- A_TroopAttack — Imp: melee (claw) or fireball ----
function A_TroopAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  const playerRef = getWorld().player;
  if (playerRef && playerRef.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  if (P_CheckMeleeRange(actor)) {
    // Melee: 1-24 damage (3*(rand%8+1))
    FX_Sound({ x: actor.x, y: actor.y }, Sfx.claw);
    const damage = ((P_Random() % 8) + 1) * 3;
    if (playerRef) playerRef.takeDamage(damage, actor.x, actor.y);
  } else {
    // Ranged: imp fireball
    spawnMonsterProjectile(actor, actor.target, ProjectileType.impFireball);
    FX_Sound({ x: actor.x, y: actor.y }, Sfx.firsht);
  }
}

// ---- A_SargAttack — Demon/Spectre: melee only ----
function A_SargAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  const playerRef = getWorld().player;
  if (playerRef && playerRef.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  if (P_CheckMeleeRange(actor)) {
    FX_Sound({ x: actor.x, y: actor.y }, Sfx.sgtatk);
    const damage = ((P_Random() % 10) + 1) * 4;  // 4-40 damage
    if (playerRef) playerRef.takeDamage(damage, actor.x, actor.y);
  }
}

// ---- A_HeadAttack — Cacodemon: melee or fireball ----
function A_HeadAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  const playerRef = getWorld().player;
  if (playerRef && playerRef.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  if (P_CheckMeleeRange(actor)) {
    const damage = ((P_Random() % 6) + 1) * 10;  // 10-60 damage
    if (playerRef) playerRef.takeDamage(damage, actor.x, actor.y);
  } else {
    spawnMonsterProjectile(actor, actor.target, ProjectileType.cacoFireball);
    FX_Sound({ x: actor.x, y: actor.y }, Sfx.firsht);
  }
}

// ---- A_BruisAttack — Baron/Hell Knight: melee or fireball ----
function A_BruisAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  const playerRef = getWorld().player;
  if (playerRef && playerRef.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  if (P_CheckMeleeRange(actor)) {
    const damage = ((P_Random() % 8) + 1) * 10;  // 10-80 damage
    FX_Sound({ x: actor.x, y: actor.y }, Sfx.claw);
    if (playerRef) playerRef.takeDamage(damage, actor.x, actor.y);
  } else {
    spawnMonsterProjectile(actor, actor.target, ProjectileType.baronFireball);
    FX_Sound({ x: actor.x, y: actor.y }, Sfx.firsht);
  }
}

// ---- A_CyberAttack — Cyberdemon: rocket ----
function A_CyberAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  const playerRef = getWorld().player;
  if (playerRef && playerRef.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  spawnMonsterProjectile(actor, actor.target, ProjectileType.cyberdemonRocket);
  FX_Sound({ x: actor.x, y: actor.y }, Sfx.rlaunc);
}

// ---- A_SkullAttack — Lost Soul: charge at player ----
function A_SkullAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  const playerRef = getWorld().player;
  if (playerRef && playerRef.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  // Set momentum directly toward target (charge attack)
  const speed = 20 * FRACUNIT;
  const dx = actor.target.x - actor.x;
  const dy = actor.target.y - actor.y;
  const dz = actor.target.z + (actor.target.height >> 1) - actor.z;
  const dist = Math.max(1, Math.sqrt(
    (dx / FRACUNIT) * (dx / FRACUNIT) +
    (dy / FRACUNIT) * (dy / FRACUNIT) +
    (dz / FRACUNIT) * (dz / FRACUNIT)
  ));

  actor.momx = Math.round((dx / FRACUNIT) / dist * (speed / FRACUNIT)) * FRACUNIT;
  actor.momy = Math.round((dy / FRACUNIT) / dist * (speed / FRACUNIT)) * FRACUNIT;
  actor.momz = Math.round((dz / FRACUNIT) / dist * (speed / FRACUNIT)) * FRACUNIT;
}

// ---- A_VileChase — Arch-vile chase (with resurrection ability) ----
// In original DOOM, A_VileChase scans for nearby corpses to resurrect.
// For now, it behaves like A_Chase. Resurrection can be added later.
function A_VileChase_impl(thingIndex: number): void {
  // TODO: Add corpse resurrection scan here
  // For now, just use standard chase behavior
  A_Chase_impl(thingIndex);
}

// ---- A_VileStart — Arch-vile attack start: play attack sound ----
function A_VileStart_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  A_FaceTarget_impl(thingIndex);
  FX_Sound({ x: actor.x, y: actor.y }, Sfx.vilatk);
}

// ---- A_VileTarget — Arch-vile: mark target, store reference ----
// In original DOOM this spawns MT_FIRE at target position.
// We store the target reference on the actor's tracer field for A_VileAttack.
function A_VileTarget_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  A_FaceTarget_impl(thingIndex);
  // Store target reference for the attack (tracer field)
  actor.tracer = actor.target;
  FX_Sound({ x: actor.x, y: actor.y }, Sfx.flamst);
}

// ---- A_VileAttack — Arch-vile: deal damage + vertical launch ----
// Original DOOM: 20 direct damage, 70 radius damage, momz = 1000*FRACUNIT/mass
function A_VileAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  const playerRef = getWorld().player;
  if (playerRef && playerRef.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  const target = actor.target;

  // Check line of sight
  const map = getWorld().map;
  if (!map) return;
  if (!P_CheckSight(actor, target, map)) return;

  FX_Sound({ x: actor.x, y: actor.y }, Sfx.barexp);

  // Direct damage: 20 hp
  // For player targets, use playerRef.takeDamage
  if (playerRef && target === playerMobj) {
    playerRef.takeDamage(20, actor.x, actor.y);
  } else {
    damageMobj(target, 20, actor);
  }

  // Vertical launch: momz = 1000 * FRACUNIT / target.info.mass
  // This is the iconic Arch-vile "bounce" — sends player flying
  const mass = target.info ? target.info.mass : 100;
  if (playerRef && target === playerMobj) {
    playerRef.momz = Math.round((1000 * FRACUNIT) / mass);
  } else {
    target.momz = Math.round((1000 * FRACUNIT) / mass);
  }

  // Radius blast: 70 damage (like a small explosion)
  // In original DOOM this uses P_RadiusAttack with 70 damage
  // For simplicity, apply additional 70 - distance based damage to player
  if (playerRef && playerRef.health > 0) {
    const dx = Math.abs(playerRef.x - target.x) >> FRACBITS;
    const dy = Math.abs(playerRef.y - target.y) >> FRACBITS;
    const dist = Math.max(dx, dy);
    if (dist < 70) {
      const blastDamage = 70 - dist;
      playerRef.takeDamage(blastDamage, actor.x, actor.y);
    }
  }
}

// ---- A_SpidRefire — Spiderdemon refire check ----
// Original DOOM uses threshold 10 (not 40 like Chaingunner) — Spiderdemon fires sustained bursts
function A_SpidRefire_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;

  A_FaceTarget_impl(thingIndex);

  // Only ~4% chance to stop firing per tic (vs chaingunner's ~16%)
  if (P_Random() < 10) return;

  // Stop if target is dead or lost sight
  const map = getWorld().map;
  if (!map) return;
  if (actor.target.health <= 0 || !P_CheckSight(actor, actor.target, map)) {
    const animDef = getThingAnimDef(actor.type);
    if (animDef && animDef.seeState !== undefined) {
      setMonsterState(thingIndex, actor.type, animDef.seeState, 'chasing');
    }
  }
}

/**
 * Legacy A_Look export (for anything still calling directly)
 */
export function A_Look(actor: MapObjState): void {
  A_Look_impl(actor.thingIndex);
}

/**
 * Initialize the enemy AI module (call on level start / reset)
 */
export function initEnemyAI(): void {
  playerMobj = null;
  soundValidcount = 0;
}
