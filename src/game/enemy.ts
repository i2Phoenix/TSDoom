// ============================================================
// Enemy AI — Monster behavior system
// Port of p_enemy.c — A_Look, P_NoiseAlert, P_LookForPlayers
// ============================================================

import { FRACBITS, FRACUNIT, ANG90, ANG180, ANG270, ANGLETOFINESHIFT, FINEMASK, finesine, finecosine, fixedMul } from '../math';
import { GameMap, Sector, LineDef, ML_TWOSIDED, ML_SOUNDBLOCK } from '../map';
import { MapObjState, getMapObjects, getMapObjectByThingIndex, getCurrentMap, DI_NODIR } from './mobj';
import { MF_SHOOTABLE, MF_AMBUSH, MF_COUNTKILL, MF_JUSTHIT, MF_JUSTATTACKED, MF_FLOAT, MF_NOGRAVITY, MF_SHADOW, MF_CORPSE } from './mobjinfo';
import { P_CheckSight } from './sight';
import { P_Random } from './random';
import { Player } from './player';
import { registerActionCallback, setMonsterState, getThingAnimDef } from './animations';
import { P_Move, P_NewChaseDir, P_CheckMeleeRange, P_CheckMissileRange } from './p_move';
import { S_StartSound } from '../sound/s_sound';
import { Sfx } from '../sound/sounds';
import { spawnMonsterProjectile, ProjectileType } from './projectiles';

// ---- Constants ----
const MELEERANGE = 64 * FRACUNIT;

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
  };
}

// Module-level player mobj reference (updated each tick)
let playerMobj: MapObjState | null = null;
let playerRef: Player | null = null;  // actual Player for takeDamage

/** Update the player shim mobj each tick (call from game loop) */
export function updatePlayerMobj(player: Player, map: GameMap): void {
  playerRef = player;  // store for attack callbacks
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
  const map = getCurrentMap();
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
      S_StartSound({ x: actor.x, y: actor.y }, sfx);
    }
  }
}

// ---- A_Chase (full implementation — Phase 4) ----

function A_Chase_impl(thingIndex: number): void {
  const map = getCurrentMap();
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

  // Turn towards movement direction
  if (actor.movedir < 8) {
    actor.angle = (actor.movedir << 29) >>> 0;
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
  if (actor.flags & MF_JUSTATTACKED) {
    actor.flags &= ~MF_JUSTATTACKED;
    // Skip attack this frame but still move
  } else {
    // Check melee attack
    const animDef = getThingAnimDef(actor.type);
    if (animDef && animDef.meleeState !== undefined) {
      if (P_CheckMeleeRange(actor)) {
        // TODO: Play attack sound
        setMonsterState(thingIndex, actor.type, animDef.meleeState, 'attacking');
        return;
      }
    }

    // Check ranged attack
    if (animDef && animDef.missileState !== undefined) {
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
      S_StartSound({ x: actor.x, y: actor.y }, animDef2.activeSound);
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
}

// ---- Attack helper: hitscan toward target ----

function monsterHitscan(actor: MapObjState, spread: number, damage: number): void {
  if (!actor.target || !playerRef) return;
  if (actor.target.health <= 0) return;  // don't attack dead target
  A_FaceTarget_impl(actor.thingIndex);

  // Base angle with random spread
  // Original DOOM: angle += (P_Random()-P_Random()) << 20; (BAM angle)
  // Conversion: << 20 BAM to radians = multiply by 2π / 4096
  const dx = actor.target.x - actor.x;
  const dy = actor.target.y - actor.y;
  let angle = Math.atan2(dy / FRACUNIT, dx / FRACUNIT);
  if (spread > 0) {
    angle += (P_Random() - P_Random()) * spread;
  }

  // Check LOS first
  const map = getCurrentMap();
  if (!map || !P_CheckSight(actor, actor.target, map)) return;

  // Apply damage to player
  playerRef.takeDamage(damage, actor.x, actor.y);
}

// DOOM hitscan spread constant: (1 << 20) BAM → radians = 2π / 4096
const HITSCAN_SPREAD = 2 * Math.PI / 4096;  // ~0.00153 rad per random unit

// ---- A_PosAttack — Zombieman: single bullet ----
function A_PosAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  if (actor.target.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  S_StartSound({ x: actor.x, y: actor.y }, Sfx.pistol);
  const damage = ((P_Random() % 5) + 1) * 3;  // 3-15 damage
  monsterHitscan(actor, HITSCAN_SPREAD, damage);
}

// ---- A_SPosAttack — Shotgun Guy: 3 bullets ----
function A_SPosAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  if (actor.target.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  S_StartSound({ x: actor.x, y: actor.y }, Sfx.shotgn);

  const map = getCurrentMap();
  if (!map || !P_CheckSight(actor, actor.target, map)) return;
  if (!playerRef) return;

  // 3 bullets, each with spread (original DOOM: << 20 BAM)
  let totalDamage = 0;
  for (let i = 0; i < 3; i++) {
    totalDamage += ((P_Random() % 5) + 1) * 3;
  }
  playerRef.takeDamage(totalDamage, actor.x, actor.y);
}

// ---- A_CPosAttack — Chaingunner: 1 bullet per frame ----
function A_CPosAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  if (actor.target.health <= 0) return;

  S_StartSound({ x: actor.x, y: actor.y }, Sfx.shotgn);
  const damage = ((P_Random() % 5) + 1) * 3;
  monsterHitscan(actor, HITSCAN_SPREAD, damage);
}

// ---- A_CPosRefire — Chaingunner refire check ----
function A_CPosRefire_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;

  A_FaceTarget_impl(thingIndex);

  // Random chance to stop firing
  if (P_Random() < 40) return;

  // Stop if target is dead or lost sight
  const map = getCurrentMap();
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
  if (actor.target.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  if (P_CheckMeleeRange(actor)) {
    // Melee: 1-24 damage (3*(rand%8+1))
    S_StartSound({ x: actor.x, y: actor.y }, Sfx.claw);
    const damage = ((P_Random() % 8) + 1) * 3;
    if (playerRef) playerRef.takeDamage(damage, actor.x, actor.y);
  } else {
    // Ranged: imp fireball
    spawnMonsterProjectile(actor, actor.target, ProjectileType.impFireball);
    S_StartSound({ x: actor.x, y: actor.y }, Sfx.firsht);
  }
}

// ---- A_SargAttack — Demon/Spectre: melee only ----
function A_SargAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  if (actor.target.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  if (P_CheckMeleeRange(actor)) {
    S_StartSound({ x: actor.x, y: actor.y }, Sfx.sgtatk);
    const damage = ((P_Random() % 10) + 1) * 4;  // 4-40 damage
    if (playerRef) playerRef.takeDamage(damage, actor.x, actor.y);
  }
}

// ---- A_HeadAttack — Cacodemon: melee or fireball ----
function A_HeadAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  if (actor.target.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  if (P_CheckMeleeRange(actor)) {
    const damage = ((P_Random() % 6) + 1) * 10;  // 10-60 damage
    if (playerRef) playerRef.takeDamage(damage, actor.x, actor.y);
  } else {
    spawnMonsterProjectile(actor, actor.target, ProjectileType.cacoFireball);
    S_StartSound({ x: actor.x, y: actor.y }, Sfx.firsht);
  }
}

// ---- A_BruisAttack — Baron/Hell Knight: melee or fireball ----
function A_BruisAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  if (actor.target.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  if (P_CheckMeleeRange(actor)) {
    const damage = ((P_Random() % 8) + 1) * 10;  // 10-80 damage
    S_StartSound({ x: actor.x, y: actor.y }, Sfx.claw);
    if (playerRef) playerRef.takeDamage(damage, actor.x, actor.y);
  } else {
    spawnMonsterProjectile(actor, actor.target, ProjectileType.baronFireball);
    S_StartSound({ x: actor.x, y: actor.y }, Sfx.firsht);
  }
}

// ---- A_CyberAttack — Cyberdemon: rocket ----
function A_CyberAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  if (actor.target.health <= 0) return;
  A_FaceTarget_impl(thingIndex);

  spawnMonsterProjectile(actor, actor.target, ProjectileType.cyberdemonRocket);
  S_StartSound({ x: actor.x, y: actor.y }, Sfx.rlaunc);
}

// ---- A_SkullAttack — Lost Soul: charge at player ----
function A_SkullAttack_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor || !actor.target) return;
  if (actor.target.health <= 0) return;
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

// ---- A_SpidRefire — Spiderdemon refire check ----
function A_SpidRefire_impl(thingIndex: number): void {
  // Same logic as CPosRefire
  A_CPosRefire_impl(thingIndex);
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
