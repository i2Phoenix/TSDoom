// ============================================================
// Boss Death Triggers — A_BossDeath
// Reference: p_enemy.c A_BossDeath
//
// When specific boss-type monsters die, environmental effects trigger
// (floors lower, doors open, levels exit) if ALL monsters of that type
// on the level are dead.
// ============================================================

import type { MapObjState } from './mobj';
import { getMapObjects } from './mobj';
import { GameInstance } from './game-instance';
import { parseMapName } from './mapflow';
import { G_ExitLevel } from './mapflow';
import { evDoFloor, evDoDoor, FloorType, DoorType } from './specials';
import type { LineDef } from './map-types';

// ---- DoomEd thing type constants ----
const DOOMEDNUM_BARON = 3003;  // Baron of Hell (Boss, E1M8)
const DOOMEDNUM_CYBERDEMON = 16;   // Cyberdemon (Boss, E2M8 / E4M6)
const DOOMEDNUM_SPIDER = 7;     // Spider Mastermind (Boss, E3M8 / E4M8)
const DOOMEDNUM_MANCUBUS = 67;    // Mancubus (MAP07)
const DOOMEDNUM_ARACHNOTRON = 68;  // Arachnotron (MAP07)
const DOOMEDNUM_KEEN = 72;    // Commander Keen

/**
 * Create a synthetic LineDef with only a tag set.
 * Used to pass to evDoFloor/evDoDoor which expect a LineDef
 * (mirrors the original Doom `junk` line in A_BossDeath).
 */
function makeJunkLine(tag: number): LineDef {
    return {
        v1: 0, v2: 0,
        flags: 0,
        special: 0,
        tag,
        sidenum: [-1, -1],
        frontsector: null,
        backsector: null,
        dx: 0, dy: 0,
        validcount: 0,
    };
}

/**
 * Check whether all monsters of a given DoomEd type are dead.
 * A monster is considered "alive" if it has health > 0 and hasn't been removed.
 */
function allBossTypesDead(doomedType: number, gi: GameInstance): boolean {
    for (const obj of getMapObjects(gi)) {
        if (obj.removed) continue;
        if (obj.type === doomedType && obj.health > 0) {
            return false;
        }
    }
    return true;
}

/**
 * A_BossDeath — called from killMobj when a COUNTKILL thing dies.
 * Checks if the level has a boss trigger for this monster type,
 * and if all monsters of that type are now dead, fires the trigger.
 */
export function A_BossDeath(target: MapObjState, gi: GameInstance): void {
    const map = gi.currentMap;
    if (!map) return;

    const info = parseMapName(map.name);

    if (info.isCommercial) {
        // ── Doom II: MAP07 ──
        if (info.map === 7) {
            if (target.type === DOOMEDNUM_MANCUBUS) {
                if (allBossTypesDead(DOOMEDNUM_MANCUBUS, gi)) {
                    // All Mancubi dead → lower floor tag 666
                    evDoFloor(makeJunkLine(666), FloorType.lowerFloorToLowest, gi);
                }
                return;
            }
            if (target.type === DOOMEDNUM_ARACHNOTRON) {
                if (allBossTypesDead(DOOMEDNUM_ARACHNOTRON, gi)) {
                    // All Arachnotrons dead → raise floor tag 667
                    evDoFloor(makeJunkLine(667), FloorType.raiseToTexture, gi);
                }
                return;
            }
        }
        // No other Doom II boss triggers (MAP30 uses spawn shooter, not A_BossDeath)
    } else {
        // ── Doom I (episodes) ──
        switch (info.episode) {
            case 1:
                if (info.map === 8 && target.type === DOOMEDNUM_BARON) {
                    if (allBossTypesDead(DOOMEDNUM_BARON, gi)) {
                        evDoFloor(makeJunkLine(666), FloorType.lowerFloorToLowest, gi);
                    }
                }
                break;

            case 2:
                if (info.map === 8 && target.type === DOOMEDNUM_CYBERDEMON) {
                    if (allBossTypesDead(DOOMEDNUM_CYBERDEMON, gi)) {
                        G_ExitLevel(gi);
                    }
                }
                break;

            case 3:
                if (info.map === 8 && target.type === DOOMEDNUM_SPIDER) {
                    if (allBossTypesDead(DOOMEDNUM_SPIDER, gi)) {
                        G_ExitLevel(gi);
                    }
                }
                break;

            case 4:
                if (info.map === 6 && target.type === DOOMEDNUM_CYBERDEMON) {
                    if (allBossTypesDead(DOOMEDNUM_CYBERDEMON, gi)) {
                        evDoDoor(makeJunkLine(666), DoorType.blazeOpen, gi);
                    }
                } else if (info.map === 8 && target.type === DOOMEDNUM_SPIDER) {
                    if (allBossTypesDead(DOOMEDNUM_SPIDER, gi)) {
                        evDoFloor(makeJunkLine(666), FloorType.lowerFloorToLowest, gi);
                    }
                }
                break;
        }
    }

    // Commander Keen — any level: when all Keens die, open door tag 666
    if (target.type === DOOMEDNUM_KEEN) {
        if (allBossTypesDead(DOOMEDNUM_KEEN, gi)) {
            evDoDoor(makeJunkLine(666), DoorType.open, gi);
        }
    }
}
