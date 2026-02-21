// ============================================================
// Sector Specials -- Coordinator / Dispatcher
// Re-exports all domain modules so external consumers
// don't need to change their imports.
// Reference: p_spec.c, p_switch.c, p_telept.c
// ============================================================

import type { LineDef } from './map-types';
import { FRACBITS } from './math';
import { FX_Sound } from './effects';
import { Sfx } from './sounds';
import { G_ExitLevel, G_SecretExitLevel } from './mapflow';
import { evLightTurnOn, evTurnTagLightsOff, evStartLightStrobing } from './lights';
import { spawnTeleportFog } from './vfx';
import type { Player } from './player';

// -- Re-export from sector-utils --
export {
  initSpecials,
  initSwitchList,
  getSectorSpecialData,
  getActivePlats,
  clearSpecialsState,
  linkSectorSpecial,
  addActivePlat,
  changeSwitchTexture,
} from './sector-utils';

// -- Re-export from doors --
export {
  DoorType,
  type DoorThinker,
  evDoDoor,
  evVerticalDoor,
  evDoLockedDoor,
  restoreDoorThinker,
} from './doors';

// -- Re-export from platforms --
export {
  PlatType,
  PlatStatus,
  type PlatThinker,
  evDoPlat,
  evStopPlat,
  restorePlatThinker,
} from './platforms';

// -- Re-export from floors --
export {
  FloorType,
  type FloorThinker,
  evDoFloor,
  evBuildStairs,
  evDoDonut,
  restoreFloorThinker,
} from './floors';

// -- Re-export from ceilings --
export {
  CeilingType,
  type CeilingThinker,
  tickCeilingCounter,
  evDoCeiling,
  evCeilingCrushStop,
} from './ceilings';

// -- Import for local use in dispatch functions --
import { changeSwitchTexture, findSectorsFromTag } from './sector-utils';
import { GameInstance } from './game-instance';
import { DoorType, evDoDoor, evVerticalDoor, evDoLockedDoor } from './doors';
import { PlatType, evDoPlat, evStopPlat } from './platforms';
import { FloorType, evDoFloor, evBuildStairs, evDoDonut } from './floors';
import { CeilingType, evDoCeiling, evCeilingCrushStop } from './ceilings';

// ===============================================
// TELEPORTERS -- EV_Teleport
// Reference: p_telept.c
// ===============================================

/**
 * Teleportable actor -- either a Player or MapObjState.
 * We duck-type: if it has `viewheight`, it's a Player.
 */
export interface TeleportActor {
  x: number;
  y: number;
  z: number;
  angle: number;
  momx: number;
  momy: number;
  momz: number;
  // Player-specific (optional)
  viewheight?: number;
  deltaviewheight?: number;
  viewz?: number;
  reactiontime?: number;
}

function isPlayerActor(actor: TeleportActor): boolean {
  return 'viewheight' in actor && 'deltaviewheight' in actor;
}

/**
 * EV_Teleport -- teleport an actor to a destination thing.
 * Finds thing type 14 in sectors matching the line's tag.
 * Reference: p_telept.c EV_Teleport
 */
function evTeleport(line: LineDef, side: number, actor: TeleportActor, gi: GameInstance): boolean {
  // Don't teleport if you're on the back side of the teleporter line
  // (prevents teleporting back immediately after arriving)
  if (side === 1) return false;
  const currentMap = gi.currentMap;
  if (!currentMap) return false;

  const tag = line.tag;
  if (tag === 0) return false;

  // Find sectors with this tag
  const sectors = findSectorsFromTag(tag, currentMap);
  if (sectors.length === 0) return false;

  // Find a teleport destination thing (type 14) in one of those sectors
  for (const thing of currentMap.things) {
    if (thing.type !== 14) continue; // T_TELEPORTMAN = 14

    // Check if this thing is inside one of the tagged sectors
    const thingX = thing.x << FRACBITS;
    const thingY = thing.y << FRACBITS;
    const ss = currentMap.pointInSubsector(thingX, thingY);
    if (!ss.sector) continue;
    if (!sectors.includes(ss.sector)) continue;

    // Found destination! Perform teleport.
    const oldX = actor.x;
    const oldY = actor.y;
    const oldZ = actor.z;

    // Destination angle (MapThing.angle is in degrees)
    const destAngle = ((thing.angle * 0xFFFFFFFF / 360) >>> 0);

    // Spawn fog at OLD position
    spawnTeleportFog(oldX, oldY, oldZ, gi);
    FX_Sound({ x: oldX, y: oldY }, Sfx.telept);

    // Move actor to destination
    const destZ = ss.sector.floorHeight;
    actor.x = thingX;
    actor.y = thingY;
    actor.z = destZ;
    actor.angle = destAngle;

    // Zero momentum
    actor.momx = 0;
    actor.momy = 0;
    actor.momz = 0;

    // Player-specific: reset view for smooth transition
    if (isPlayerActor(actor)) {
      const VIEWHEIGHT = 41 << FRACBITS;
      actor.viewheight = VIEWHEIGHT;
      actor.deltaviewheight = 0;
      actor.viewz = destZ + VIEWHEIGHT;
      actor.reactiontime = 18; // freeze controls briefly (18 tics)
    }

    // Spawn fog at NEW position (offset slightly in front based on angle)
    // Original DOOM spawns fog 20 units in front of destination
    const fineAngle = (destAngle >>> 19) & 0x1FFF;
    const TELEPORTOFFSET = 20 << FRACBITS;
    // Use lookup for cos/sin
    const fogX = thingX + Math.round(TELEPORTOFFSET * Math.cos(fineAngle * Math.PI * 2 / 8192));
    const fogY = thingY + Math.round(TELEPORTOFFSET * Math.sin(fineAngle * Math.PI * 2 / 8192));
    spawnTeleportFog(fogX, fogY, destZ, gi);
    FX_Sound({ x: fogX, y: fogY }, Sfx.telept);

    return true;
  }

  return false;
}

// ===============================================
// P_UseSpecialLine -- main dispatch
// Reference: p_switch.c P_UseSpecialLine
// ===============================================
export function useSpecialLine(line: LineDef, player: Player | null, gi: GameInstance): boolean {
  const currentMap = gi.currentMap!;

  switch (line.special) {
    // MANUALS (doors you press Use on)
    case 1:   // Vertical Door (raise)
    case 26:  // Blue locked door raise
    case 27:  // Yellow locked door raise
    case 28:  // Red locked door raise
    case 31:  // Manual door open (stay open)
    case 32:  // Blue locked door open
    case 33:  // Red locked door open
    case 34:  // Yellow locked door open
    case 117: // Blazing door raise
    case 118: // Blazing door open
      evVerticalDoor(line, player, gi);
      return true;

    // SWITCHES (one-shot)
    case 11:
      // Exit level (switch)
      changeSwitchTexture(line, false, gi);
      G_ExitLevel(gi);
      return true;
    case 124:
      // Secret exit (switch)
      changeSwitchTexture(line, false, gi);
      G_SecretExitLevel(gi);
      return true;
    case 7:  // S1 Build Stairs 8
      if (evBuildStairs(line, false, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 127: // S1 Build Stairs 16 (turbo)
      if (evBuildStairs(line, true, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 49: // S1 Ceiling Crush And Raise
      if (evDoCeiling(line, CeilingType.crushAndRaise, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 9:  // S1 Change Donut (EV_DoDonut)
      if (evDoDonut(line, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 21: // PlatDownWaitUpStay (switch)
      if (evDoPlat(line, PlatType.downWaitUpStay, 0, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 23: // Lower floor to lowest
      if (evDoFloor(line, FloorType.lowerFloorToLowest, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 29: // Raise door (switch)
      if (evDoDoor(line, DoorType.normal, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 18: // Raise floor to next highest
      if (evDoFloor(line, FloorType.raiseFloorToNearest, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 20: // Raise plat to nearest and change
      if (evDoPlat(line, PlatType.raiseToNearestAndChange, 0, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 101: // Raise floor
      if (evDoFloor(line, FloorType.raiseFloor, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 102: // Lower floor
      if (evDoFloor(line, FloorType.lowerFloor, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 103: // Open door (switch)
      if (evDoDoor(line, DoorType.open, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 50: // Close door (switch)
      if (evDoDoor(line, DoorType.close, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 71: // Turbo lower floor
      if (evDoFloor(line, FloorType.turboLower, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 14: // S1 Raise Floor 32 And Change
      if (evDoPlat(line, PlatType.raiseAndChange, 32, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 15: // S1 Raise Floor 24 And Change
      if (evDoPlat(line, PlatType.raiseAndChange, 24, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 41: // S1 Lower Ceiling To Floor
      if (evDoCeiling(line, CeilingType.lowerToFloor, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 55: // S1 Raise Floor Crush
      if (evDoFloor(line, FloorType.raiseFloorCrush, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 111: // S1 Blazing Door Raise
      if (evDoDoor(line, DoorType.blazeRaise, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 112: // S1 Blazing Door Open
      if (evDoDoor(line, DoorType.blazeOpen, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 113: // S1 Blazing Door Close
      if (evDoDoor(line, DoorType.blazeClose, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 122: // S1 Blazing PlatDownWaitUpStay
      if (evDoPlat(line, PlatType.blazeDWUS, 0, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 131: // S1 Raise Floor Turbo
      if (evDoFloor(line, FloorType.raiseFloorTurbo, gi))
        changeSwitchTexture(line, false, gi);
      return true;
    case 140: // S1 Raise Floor 512
      if (evDoFloor(line, FloorType.raiseFloor512, gi))
        changeSwitchTexture(line, false, gi);
      return true;

    // LOCKED DOOR SWITCHES (one-shot)
    case 133: // BlzOpenDoor BLUE
    case 135: // BlzOpenDoor RED
    case 137: // BlzOpenDoor YELLOW
      if (evDoLockedDoor(line, DoorType.blazeOpen, player, gi))
        changeSwitchTexture(line, false, gi);
      return true;

    // BUTTONS (repeatable switches)
    case 42: // Close door (button)
      if (evDoDoor(line, DoorType.close, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 45: // Lower floor (button)
      if (evDoFloor(line, FloorType.lowerFloor, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 60: // Lower floor to lowest (button)
      if (evDoFloor(line, FloorType.lowerFloorToLowest, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 61: // Open door (button)
      if (evDoDoor(line, DoorType.open, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 62: // PlatDownWaitUpStay (button)
      if (evDoPlat(line, PlatType.downWaitUpStay, 1, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 63: // Raise door normal (button)
      if (evDoDoor(line, DoorType.normal, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 64: // Raise floor (button)
      if (evDoFloor(line, FloorType.raiseFloor, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 65: // Raise floor crush (button)
      if (evDoFloor(line, FloorType.raiseFloorCrush, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 69: // Raise floor to nearest (button)
      if (evDoFloor(line, FloorType.raiseFloorToNearest, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 70: // Turbo lower floor (button)
      if (evDoFloor(line, FloorType.turboLower, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 43: // SR Lower Ceiling To Floor
      if (evDoCeiling(line, CeilingType.lowerToFloor, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 66: // SR Raise Floor 24 And Change
      if (evDoPlat(line, PlatType.raiseAndChange, 24, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 67: // SR Raise Floor 32 And Change
      if (evDoPlat(line, PlatType.raiseAndChange, 32, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 68: // SR Raise Plat To Nearest And Change
      if (evDoPlat(line, PlatType.raiseToNearestAndChange, 0, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 114: // SR Blazing Door Raise
      if (evDoDoor(line, DoorType.blazeRaise, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 115: // SR Blazing Door Open
      if (evDoDoor(line, DoorType.blazeOpen, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 116: // SR Blazing Door Close
      if (evDoDoor(line, DoorType.blazeClose, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 123: // SR Blazing PlatDownWaitUpStay
      if (evDoPlat(line, PlatType.blazeDWUS, 0, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 132: // SR Raise Floor Turbo
      if (evDoFloor(line, FloorType.raiseFloorTurbo, gi))
        changeSwitchTexture(line, true, gi);
      return true;
    case 138: // SR Light Turn On 255
      evLightTurnOn(line.tag, 255, currentMap);
      changeSwitchTexture(line, true, gi);
      return true;
    case 139: // SR Light Turn Off (35)
      evLightTurnOn(line.tag, 35, currentMap);
      changeSwitchTexture(line, true, gi);
      return true;
    // LOCKED DOOR BUTTONS (repeatable)
    case 99:  // BlzOpenDoor BLUE
    case 134: // BlzOpenDoor RED
    case 136: // BlzOpenDoor YELLOW
      if (evDoLockedDoor(line, DoorType.blazeOpen, player, gi))
        changeSwitchTexture(line, true, gi);
      return true;
  }

  return false;
}

/**
 * P_UseSpecialLine for monsters -- only manual doors (special 1).
 * Reference: p_spec.c -- monsters can only activate type 1 doors.
 */
export function monsterUseSpecialLine(line: LineDef, gi: GameInstance): boolean {
  if (line.special === 1) {
    evVerticalDoor(line, null, gi);
    return true;
  }
  return false;
}

/**
 * P_CrossSpecialLine -- triggered when player/monster crosses a line
 * Reference: p_spec.c P_CrossSpecialLine
 */
export function crossSpecialLine(line: LineDef, side: number, actor: TeleportActor | undefined, gi: GameInstance): void {
  const currentMap = gi.currentMap!;

  // Monster filter: in original DOOM (p_spec.c), monsters can only trigger
  // walk-over doors, lifts/platforms, and teleports -- NOT exits, floors, ceilings, etc.
  if (actor && !isPlayerActor(actor)) {
    switch (line.special) {
      // Doors: W1 / WR
      case 2: case 3: case 4: case 16: case 108: case 109: case 110:  // W1 doors
      case 75: case 76: case 86: case 90:                              // WR doors
      // Lifts/platforms: W1 / WR
      case 10: case 22:                                                // W1 lifts
      case 87: case 88: case 95:                                       // WR lifts
      // Teleporters
      case 39: case 97: case 125: case 126:
        break; // allowed -- continue to the switch below
      default:
        return; // all other specials are player-only
    }
  }

  switch (line.special) {
    case 2: // Open door (walk trigger)
      evDoDoor(line, DoorType.open, gi);
      line.special = 0;
      break;
    case 3: // Close door (walk trigger)
      evDoDoor(line, DoorType.close, gi);
      line.special = 0;
      break;
    case 4: // Raise door normal (walk trigger)
      evDoDoor(line, DoorType.normal, gi);
      line.special = 0;
      break;
    case 5: // Raise floor (walk trigger)
      evDoFloor(line, FloorType.raiseFloor, gi);
      line.special = 0;
      break;
    case 10: // PlatDownWaitUpStay (walk trigger)
      evDoPlat(line, PlatType.downWaitUpStay, 0, gi);
      line.special = 0;
      break;
    case 16: // Close door 30 then open
      evDoDoor(line, DoorType.close30ThenOpen, gi);
      line.special = 0;
      break;
    case 19: // Lower floor (walk trigger)
      evDoFloor(line, FloorType.lowerFloor, gi);
      line.special = 0;
      break;
    case 22: // Raise to nearest and change
      evDoPlat(line, PlatType.raiseToNearestAndChange, 0, gi);
      line.special = 0;
      break;
    case 36: // Lower floor turbo (walk trigger)
      evDoFloor(line, FloorType.turboLower, gi);
      line.special = 0;
      break;
    case 37: // Lower and change
      evDoFloor(line, FloorType.lowerAndChange, gi);
      line.special = 0;
      break;
    case 38: // Lower floor to lowest
      evDoFloor(line, FloorType.lowerFloorToLowest, gi);
      line.special = 0;
      break;
    case 6: // W1 Fast Ceiling Crush And Raise
      evDoCeiling(line, CeilingType.fastCrushAndRaise, gi);
      line.special = 0;
      break;
    case 25: // W1 Crush And Raise
      evDoCeiling(line, CeilingType.crushAndRaise, gi);
      line.special = 0;
      break;
    case 44: // W1 Lower And Crush
      evDoCeiling(line, CeilingType.lowerAndCrush, gi);
      line.special = 0;
      break;
    case 40: // W1 Raise Ceiling To Highest
      evDoCeiling(line, CeilingType.raiseToHighest, gi);
      line.special = 0;
      break;
    case 41: // W1 Lower Ceiling To Floor
      evDoCeiling(line, CeilingType.lowerToFloor, gi);
      line.special = 0;
      break;
    case 57: // W1 Ceiling Crush Stop
      evCeilingCrushStop(line, gi);
      line.special = 0;
      break;
    case 141: // W1 Silent Crush And Raise
      evDoCeiling(line, CeilingType.silentCrushAndRaise, gi);
      line.special = 0;
      break;
    case 52: // EXIT (walk trigger)
      G_ExitLevel(gi);
      line.special = 0;
      break;
    case 51: // SECRET EXIT (walk trigger)
      G_SecretExitLevel(gi);
      line.special = 0;
      break;
    case 12: // W1 Light Turn On -- brightest near
      evLightTurnOn(line.tag, 0, currentMap);
      line.special = 0;
      break;
    case 13: // W1 Light Turn On 255
      evLightTurnOn(line.tag, 255, currentMap);
      line.special = 0;
      break;
    case 17: // W1 Start Light Strobing
      evStartLightStrobing(line.tag, currentMap, gi);
      line.special = 0;
      break;
    case 35: // W1 Lights Very Dark (35)
      evLightTurnOn(line.tag, 35, currentMap);
      line.special = 0;
      break;
    case 104: // W1 Turn Tag Lights Off
      evTurnTagLightsOff(line.tag, currentMap);
      line.special = 0;
      break;
    case 53: // W1 Perpetual Platform Raise
      evDoPlat(line, PlatType.perpetualRaise, 0, gi);
      line.special = 0;
      break;
    case 54: // W1 Platform Stop
      evStopPlat(line, gi);
      line.special = 0;
      break;
    case 56: // W1 Raise Floor Crush
      evDoFloor(line, FloorType.raiseFloorCrush, gi);
      line.special = 0;
      break;
    case 58: // W1 Raise Floor 24
      evDoFloor(line, FloorType.raiseFloor24, gi);
      line.special = 0;
      break;
    case 59: // W1 Raise Floor 24 And Change
      evDoFloor(line, FloorType.raiseFloor24AndChange, gi);
      line.special = 0;
      break;
    case 30: // W1 Raise Floor To Texture
      evDoFloor(line, FloorType.raiseToTexture, gi);
      line.special = 0;
      break;
    case 119: // W1 Raise Floor To Nearest
      evDoFloor(line, FloorType.raiseFloorToNearest, gi);
      line.special = 0;
      break;
    case 121: // W1 Blazing PlatDownWaitUpStay
      evDoPlat(line, PlatType.blazeDWUS, 0, gi);
      line.special = 0;
      break;
    case 130: // W1 Raise Floor Turbo
      evDoFloor(line, FloorType.raiseFloorTurbo, gi);
      line.special = 0;
      break;
    case 108: // Blazing door raise (walk trigger)
      evDoDoor(line, DoorType.blazeRaise, gi);
      line.special = 0;
      break;
    case 109: // Blazing door open (walk trigger)
      evDoDoor(line, DoorType.blazeOpen, gi);
      line.special = 0;
      break;
    case 110: // Blazing door close (walk trigger)
      evDoDoor(line, DoorType.blazeClose, gi);
      line.special = 0;
      break;

    // RETRIGGERS (don't clear special)
    case 72: // WR Lower Ceiling And Crush
      evDoCeiling(line, CeilingType.lowerAndCrush, gi);
      break;
    case 73: // WR Crush And Raise
      evDoCeiling(line, CeilingType.crushAndRaise, gi);
      break;
    case 74: // WR Ceiling Crush Stop
      evCeilingCrushStop(line, gi);
      break;
    case 77: // WR Fast Crush And Raise
      evDoCeiling(line, CeilingType.fastCrushAndRaise, gi);
      break;
    case 75: // Close door (retrigger)
      evDoDoor(line, DoorType.close, gi);
      break;
    case 76: // Close door 30 (retrigger)
      evDoDoor(line, DoorType.close30ThenOpen, gi);
      break;
    case 86: // Open door (retrigger)
      evDoDoor(line, DoorType.open, gi);
      break;
    case 87: // Perpetual platform raise
      evDoPlat(line, PlatType.perpetualRaise, 0, gi);
      break;
    case 88: // PlatDownWaitUpStay (retrigger)
      evDoPlat(line, PlatType.downWaitUpStay, 0, gi);
      break;
    case 90: // Raise door normal (retrigger)
      evDoDoor(line, DoorType.normal, gi);
      break;
    case 91: // Raise floor (retrigger)
      evDoFloor(line, FloorType.raiseFloor, gi);
      break;
    case 92: // Raise floor 24 (retrigger)
      evDoFloor(line, FloorType.raiseFloor24, gi);
      break;
    case 93: // Raise floor 24 and change (retrigger)
      evDoFloor(line, FloorType.raiseFloor24AndChange, gi);
      break;
    case 94: // Raise floor crush (retrigger)
      evDoFloor(line, FloorType.raiseFloorCrush, gi);
      break;
    case 95: // Raise nearest and change (retrigger)
      evDoPlat(line, PlatType.raiseToNearestAndChange, 0, gi);
      break;
    case 96: // Raise floor to nearest (retrigger)
      // Short texture raise -- simplify to raise floor
      evDoFloor(line, FloorType.raiseFloor24, gi);
      break;
    case 98: // Lower floor turbo (retrigger)
      evDoFloor(line, FloorType.turboLower, gi);
      break;
    case 82: // WR Lower Floor To Lowest
      evDoFloor(line, FloorType.lowerFloorToLowest, gi);
      break;
    case 83: // WR Lower Floor
      evDoFloor(line, FloorType.lowerFloor, gi);
      break;
    case 84: // WR Lower And Change
      evDoFloor(line, FloorType.lowerAndChange, gi);
      break;
    case 89: // WR Platform Stop
      evStopPlat(line, gi);
      break;
    case 105: // WR Blazing Door Raise
      evDoDoor(line, DoorType.blazeRaise, gi);
      break;
    case 106: // WR Blazing Door Open
      evDoDoor(line, DoorType.blazeOpen, gi);
      break;
    case 107: // WR Blazing Door Close
      evDoDoor(line, DoorType.blazeClose, gi);
      break;
    case 120: // WR Blazing PlatDownWaitUpStay
      evDoPlat(line, PlatType.blazeDWUS, 0, gi);
      break;
    case 128: // WR Raise Floor To Nearest
      evDoFloor(line, FloorType.raiseFloorToNearest, gi);
      break;
    case 129: // WR Raise Floor Turbo
      evDoFloor(line, FloorType.raiseFloorTurbo, gi);
      break;
    case 79: // WR Lights Very Dark (35)
      evLightTurnOn(line.tag, 35, currentMap);
      break;
    case 80: // WR Light Turn On -- brightest near
      evLightTurnOn(line.tag, 0, currentMap);
      break;
    case 81: // WR Light Turn On 255
      evLightTurnOn(line.tag, 255, currentMap);
      break;

    // STAIR BUILDING
    case 8: // W1 Build Stairs 8
      evBuildStairs(line, false, gi);
      line.special = 0;
      break;
    case 100: // W1 Build Stairs 16 (turbo)
      evBuildStairs(line, true, gi);
      line.special = 0;
      break;

    // TELEPORTERS
    case 39: // W1 Teleport
      if (actor) {
        if (evTeleport(line, side, actor, gi)) {
          line.special = 0;
        }
      }
      break;
    case 97: // WR Teleport (retrigger)
      if (actor) {
        evTeleport(line, side, actor, gi);
      }
      break;
    case 125: // W1 Teleport -- monsters only
      if (actor && !isPlayerActor(actor)) {
        if (evTeleport(line, side, actor, gi)) {
          line.special = 0;
        }
      }
      break;
    case 126: // WR Teleport -- monsters only (retrigger)
      if (actor && !isPlayerActor(actor)) {
        evTeleport(line, side, actor, gi);
      }
      break;
  }
}

/**
 * P_ShootSpecialLine -- IMPACT SPECIALS
 * Called when a projectile or bullet hits a linedef with a special.
 * Only 3 cases exist in original DOOM.
 * Reference: p_spec.c P_ShootSpecialLine
 */
export function shootSpecialLine(line: LineDef, gi: GameInstance): void {
  switch (line.special) {
    case 24: // G1 Raise Floor
      if (evDoFloor(line, FloorType.raiseFloor, gi))
        changeSwitchTexture(line, false, gi);
      break;
    case 46: // GR Open Door (impact)
      if (evDoDoor(line, DoorType.open, gi))
        changeSwitchTexture(line, true, gi);
      break;
    case 47: // G1 Raise Floor Near And Change
      if (evDoPlat(line, PlatType.raiseToNearestAndChange, 0, gi))
        changeSwitchTexture(line, false, gi);
      break;
  }
}
