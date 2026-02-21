// ============================================================
// Game State — global state machine (like DOOM's doomstat.h)
// Reference: doomdef.h, doomstat.h, g_game.c
// ============================================================

/** What the game is currently doing */
export enum GameState {
  GS_DEMOSCREEN,  // title / demo screens
  GS_LEVEL,       // active gameplay
  GS_INTERMISSION, // intermission stats screen between levels
  GS_FINALE,      // text screen between episodes / end of game
}

/** Deferred actions — set by menu/input, processed by G_Ticker in main loop */
export enum GameAction {
  ga_nothing,
  ga_newgame,
  ga_loadgame,
  ga_savegame,
  ga_warp,
  ga_completed,
}
