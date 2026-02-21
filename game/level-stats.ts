// ============================================================
// Level Statistics — kill/item/secret counters
// Used by game/ modules to track progress. Read by intermission.
// Reference: p_inter.c, p_mobj.c, wi_stuff.c
// ============================================================

export let totalKills = 0;
export let totalItems = 0;
export let totalSecrets = 0;
export let playerKills = 0;
export let playerItems = 0;
export let playerSecrets = 0;

export function resetLevelStats(): void {
  totalKills = 0;
  totalItems = 0;
  totalSecrets = 0;
  playerKills = 0;
  playerItems = 0;
  playerSecrets = 0;
}

export function addTotalKill(): void { totalKills++; }
export function addTotalItem(): void { totalItems++; }
export function addTotalSecret(): void { totalSecrets++; }
export function addPlayerKill(): void { playerKills++; }
export function addPlayerItem(): void { playerItems++; }
export function addPlayerSecret(): void { playerSecrets++; }
