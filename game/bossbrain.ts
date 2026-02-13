// ============================================================
// Boss Brain / Icon of Sin (MAP30)
// Reference: p_enemy.c — A_BrainAwake, A_BrainSpit, A_SpawnFly,
//            A_BrainPain, A_BrainScream, A_BrainExplode, A_BrainDie
// ============================================================

import { FRACUNIT, FRACBITS } from './math';
import { MapObjState, getMapObjects, getMapObjectByThingIndex, DI_NODIR } from './mobj';
import { MT, mobjinfo, MF_SHOOTABLE, MF_SOLID, MF_COUNTKILL } from './mobjinfo';
import { getWorld } from './world';
import { FX_Sound } from './effects';
import { Sfx } from './sounds';
import { P_Random } from './random';
import { G_ExitLevel } from './mapflow';
import { spawnTeleportFog } from './vfx';
import { registerActionCallback, setMonsterState, getThingAnimDef } from './animations';
import { getGameSkill, SkillLevel } from './skill';

// ---- Module state ----
let brainTargets: MapObjState[] = [];      // thing type 87 (spawn spots)
let brainTargetIndex = 0;                   // round-robin index
let bossBrainObj: MapObjState | null = null; // thing type 88 (brain)
let bossEyeObj: MapObjState | null = null;  // thing type 89 (eye/shooter)

// Thinker list for active spawn cubes
interface SpawnCube {
  x: number;
  y: number;
  z: number;
  momx: number;
  momy: number;
  momz: number;
  targetSpot: MapObjState;
  countdown: number;  // tics until spawn
}

const spawnCubes: SpawnCube[] = [];

// ---- Monster spawn table (from p_enemy.c braincastorder[]) ----
const BRAIN_CAST: MT[] = [
  MT.MT_TROOP,       // Imp
  MT.MT_SERGEANT,    // Demon
  MT.MT_SHADOWS,     // Spectre
  MT.MT_PAIN,        // Pain Elemental
  MT.MT_HEAD,        // Cacodemon
  MT.MT_VILE,        // Arch-vile
  MT.MT_UNDEAD,      // Revenant
  MT.MT_BABY,        // Arachnotron
  MT.MT_FATSO,       // Mancubus
  MT.MT_KNIGHT,      // Hell Knight
  MT.MT_BRUISER,     // Baron of Hell
  MT.MT_POSSESSED,   // Zombieman
  MT.MT_SHOTGUY,     // Shotgun Guy
  MT.MT_CHAINGUY,    // Chaingunner
  MT.MT_SKULL,       // Lost Soul
];

// MT enum → DoomEd number for spawning
const MT_TO_DOOMED: Partial<Record<MT, number>> = {
  [MT.MT_TROOP]: 3001,
  [MT.MT_SERGEANT]: 3002,
  [MT.MT_SHADOWS]: 58,
  [MT.MT_PAIN]: 71,
  [MT.MT_HEAD]: 3005,
  [MT.MT_VILE]: 64,
  [MT.MT_UNDEAD]: 66,
  [MT.MT_BABY]: 68,
  [MT.MT_FATSO]: 67,
  [MT.MT_KNIGHT]: 69,
  [MT.MT_BRUISER]: 3003,
  [MT.MT_POSSESSED]: 3004,
  [MT.MT_SHOTGUY]: 9,
  [MT.MT_CHAINGUY]: 65,
  [MT.MT_SKULL]: 3006,
};

// Dynamic thing counter for spawned monsters (negative to avoid map thing collisions)
let dynamicThingCounter = -2000;

// ---- Initialization ----

/**
 * Initialize boss brain state for the current level.
 * Called after initMapObjects() so all MapObjState entries exist.
 */
export function initBossBrain(): void {
  brainTargets = [];
  brainTargetIndex = 0;
  bossBrainObj = null;
  bossEyeObj = null;
  spawnCubes.length = 0;
  dynamicThingCounter = -2000;

  for (const obj of getMapObjects()) {
    if (obj.removed) continue;
    switch (obj.type) {
      case 87:  // MT_BOSSTARGET (spawn spot)
        brainTargets.push(obj);
        break;
      case 88:  // MT_BOSSBRAIN
        bossBrainObj = obj;
        break;
      case 89:  // MT_BOSSSPIT (eye)
        bossEyeObj = obj;
        break;
    }
  }

  if (bossBrainObj) {
    console.log(`[bossbrain] Brain at (${bossBrainObj.x >> FRACBITS}, ${bossBrainObj.y >> FRACBITS}), ${brainTargets.length} spawn spots`);
  }
}

// ---- Actions ----

/** A_BrainAwake — eye activates, plays sound */
export function A_BrainAwake_impl(_thingIndex: number): void {
  FX_Sound(null, Sfx.bossit);
}

/** A_BrainPain — brain takes damage */
export function A_BrainPain_impl(_thingIndex: number): void {
  FX_Sound(null, Sfx.bospn);
}

/** A_BrainSpit — eye fires a spawn cube toward next spawn spot */
export function A_BrainSpit_impl(_thingIndex: number): void {
  if (brainTargets.length === 0 || !bossEyeObj) return;

  const target = brainTargets[brainTargetIndex % brainTargets.length];
  brainTargetIndex++;

  // Calculate velocity toward target
  const dx = target.x - bossEyeObj.x;
  const dy = target.y - bossEyeObj.y;
  const dist = Math.max(1, Math.sqrt(
    (dx / FRACUNIT) * (dx / FRACUNIT) +
    (dy / FRACUNIT) * (dy / FRACUNIT)
  ));

  // Cube speed: ~15 map units/tic
  const speed = 15;
  const momx = Math.round((dx / FRACUNIT) / dist * speed) * FRACUNIT;
  const momy = Math.round((dy / FRACUNIT) / dist * speed) * FRACUNIT;
  const travelTics = Math.max(1, Math.round(dist / speed));

  spawnCubes.push({
    x: bossEyeObj.x,
    y: bossEyeObj.y,
    z: bossEyeObj.z,
    momx,
    momy,
    momz: 0,
    targetSpot: target,
    countdown: travelTics,
  });

  FX_Sound(null, Sfx.bospit);
}

/** Spawn a random monster at a boss target spot */
function spawnMonsterAtSpot(spot: MapObjState): void {
  const mt = BRAIN_CAST[P_Random() % BRAIN_CAST.length];
  const doomedNum = MT_TO_DOOMED[mt];
  if (doomedNum === undefined) return;

  const mInfo = mobjinfo[mt];
  if (!mInfo) return;

  const map = getWorld().map;
  if (!map) return;

  const ss = map.pointInSubsector(spot.x, spot.y);
  const floorZ = ss.sector ? ss.sector.floorHeight : 0;
  const ceilZ = ss.sector ? ss.sector.ceilingHeight : 0;

  const thingIdx = dynamicThingCounter--;

  const monster: MapObjState = {
    thingIndex: thingIdx,
    x: spot.x,
    y: spot.y,
    z: floorZ,
    health: mInfo.spawnhealth,
    spawnHealth: mInfo.spawnhealth,
    radius: mInfo.radius,
    height: mInfo.height,
    flags: mInfo.flags,
    mass: mInfo.mass,
    type: doomedNum,
    removed: false,
    deathHandled: false,
    mobjType: mt,
    angle: spot.angle,
    movedir: DI_NODIR,
    movecount: 0,
    target: null,
    threshold: 0,
    reactiontime: (getGameSkill() === SkillLevel.sk_nightmare) ? 0 : mInfo.reactiontime,
    lastlook: 0,
    momx: 0,
    momy: 0,
    momz: 0,
    floorz: floorZ,
    ceilingz: ceilZ,
    tracer: null,
    info: mInfo,
    spawnX: spot.x,
    spawnY: spot.y,
    spawnAngle: spot.angle,
    respawnTimer: 0,
  };

  getMapObjects().push(monster);

  // Telefog + sound at spawn spot
  spawnTeleportFog(spot.x, spot.y, floorZ);
  FX_Sound({ x: spot.x, y: spot.y }, Sfx.telept);

  // Set into see/chase state immediately
  const animDef = getThingAnimDef(doomedNum);
  if (animDef && animDef.seeState !== undefined) {
    setMonsterState(thingIdx, doomedNum, animDef.seeState, 'chasing');
  }
}

/** A_BrainScream — cascade of explosions across the brain */
export function A_BrainScream_impl(_thingIndex: number): void {
  if (!bossBrainObj) return;

  const startX = bossBrainObj.x - 196 * FRACUNIT;
  const endX = bossBrainObj.x + 320 * FRACUNIT;

  for (let x = startX; x < endX; x += 8 * FRACUNIT) {
    const y = bossBrainObj.y - 320 * FRACUNIT;
    FX_Sound({ x, y }, Sfx.bosdth);
  }
}

/** A_BrainExplode — random explosion near brain during death */
export function A_BrainExplode_impl(thingIndex: number): void {
  const actor = getMapObjectByThingIndex(thingIndex);
  if (!actor) return;

  const x = actor.x + ((P_Random() - P_Random()) << 11);
  FX_Sound({ x, y: actor.y }, Sfx.barexp);
}

/** A_BrainDie — exit the level */
export function A_BrainDie_impl(_thingIndex: number): void {
  console.log('[bossbrain] Brain destroyed — exiting level');
  G_ExitLevel();
}

// ---- Tick: advance spawn cubes ----

export function tickBossBrain(): void {
  for (let i = spawnCubes.length - 1; i >= 0; i--) {
    const cube = spawnCubes[i];
    cube.x += cube.momx;
    cube.y += cube.momy;
    cube.z += cube.momz;
    cube.countdown--;

    if (cube.countdown <= 0) {
      spawnMonsterAtSpot(cube.targetSpot);
      FX_Sound({ x: cube.targetSpot.x, y: cube.targetSpot.y }, Sfx.boscub);
      spawnCubes.splice(i, 1);
    }
  }
}

// ---- Registration ----

export function registerBossBrainCallbacks(): void {
  registerActionCallback('A_BrainAwake', A_BrainAwake_impl);
  registerActionCallback('A_BrainPain', A_BrainPain_impl);
  registerActionCallback('A_BrainSpit', A_BrainSpit_impl);
  registerActionCallback('A_BrainScream', A_BrainScream_impl);
  registerActionCallback('A_BrainExplode', A_BrainExplode_impl);
  registerActionCallback('A_BrainDie', A_BrainDie_impl);
}
