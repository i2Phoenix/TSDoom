// ============================================================
// Map Flow — level exit and progression logic
// Reference: g_game.c  G_ExitLevel, G_SecretExitLevel, G_DoCompleted
// ============================================================

import { GameAction, setGameAction, setSecretExit } from './gamestate';

// ---- Map name parsing ----

export interface MapInfo {
  episode: number;   // 1-4 for Doom I, 0 for Doom II
  map: number;       // 1-9 for Doom I, 1-32 for Doom II
  isCommercial: boolean;
}

/**
 * Parse a DOOM map lump name into episode/map numbers.
 * Supports "ExMy" (Doom I) and "MAPxx" (Doom II) formats.
 */
export function parseMapName(name: string): MapInfo {
  const upper = name.toUpperCase();

  // Doom II: MAPxx
  const mapMatch = upper.match(/^MAP(\d{2})$/);
  if (mapMatch) {
    return { episode: 0, map: parseInt(mapMatch[1], 10), isCommercial: true };
  }

  // Doom I: ExMy
  const epMatch = upper.match(/^E(\d)M(\d)$/);
  if (epMatch) {
    return { episode: parseInt(epMatch[1], 10), map: parseInt(epMatch[2], 10), isCommercial: false };
  }

  // Fallback
  return { episode: 1, map: 1, isCommercial: false };
}

/**
 * Build a map lump name from episode/map numbers.
 */
function buildMapName(info: MapInfo): string {
  if (info.isCommercial) {
    return `MAP${info.map.toString().padStart(2, '0')}`;
  }
  return `E${info.episode}M${info.map}`;
}

// ---- Doom I secret exit return table ----
// When leaving ExM9 (secret level), return to this map
const SECRET_RETURN: Record<number, number> = {
  1: 4,  // E1M9 → E1M4
  2: 6,  // E2M9 → E2M6
  3: 7,  // E3M9 → E3M7
  4: 3,  // E4M9 → E4M3
};

/**
 * Determine the next map name based on current map and whether it's a secret exit.
 */
export function getNextMap(currentMapName: string, isSecretExit: boolean): string {
  const info = parseMapName(currentMapName);

  if (info.isCommercial) {
    // ── Doom II ──
    if (isSecretExit) {
      switch (info.map) {
        case 15: return 'MAP31';  // secret exit from MAP15 → MAP31
        case 31: return 'MAP32';  // secret exit from MAP31 → MAP32
      }
    }
    switch (info.map) {
      case 31:
      case 32: return 'MAP16';   // return from secret levels
      default: return buildMapName({ ...info, map: info.map + 1 });
    }
  } else {
    // ── Doom I (episodes) ──
    if (isSecretExit) {
      // Secret exit → ExM9
      return buildMapName({ ...info, map: 9 });
    }
    if (info.map === 9) {
      // Returning from secret level
      const returnMap = SECRET_RETURN[info.episode] ?? 4;
      return buildMapName({ ...info, map: returnMap });
    }
    if (info.map >= 8) {
      // E?M8 is end of episode — for now just wrap to next episode M1
      // (victory screen will be added later)
      const nextEp = info.episode < 4 ? info.episode + 1 : 1;
      return buildMapName({ episode: nextEp, map: 1, isCommercial: false });
    }
    // Normal progression
    return buildMapName({ ...info, map: info.map + 1 });
  }
}

// ---- Exit functions (called from specials.ts) ----

/** G_ExitLevel — normal exit */
export function G_ExitLevel(): void {
  setSecretExit(false);
  setGameAction(GameAction.ga_completed);
}

/** G_SecretExitLevel — secret exit */
export function G_SecretExitLevel(): void {
  setSecretExit(true);
  setGameAction(GameAction.ga_completed);
}
