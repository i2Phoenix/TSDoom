# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TSDoom — a from-scratch DOOM engine in TypeScript, running in the browser via HTML5 Canvas 2D software rendering. Port of the original id Tech 1 engine (1993). No WebGL, no game logic dependencies — only `webaudio-tinysynth` for MIDI synthesis.

## Commands

```bash
npm run dev        # Vite dev server at http://localhost:5173
npm run build      # TypeScript check + Vite production build
npm run preview    # Preview production build
npm run extract    # WAD extraction utility (tsx tools/wad-extract.ts)
```

No automated tests exist. Testing is manual in-browser with a WAD file in `data/`.

## Architecture

### Two-Layer Separation

The codebase is split into platform-independent game logic and browser-specific platform code:

- **`game/`** — Pure game simulation (no DOM, no browser APIs). Physics, AI, combat, sector specials, weapons, thinkers, map objects. Can theoretically run headless.
- **`src/`** — Browser platform layer. WAD loading, rendering, input (keyboard/mouse/touch/gamepad), sound (Web Audio), HUD, menus, game loop timing.

### Entry Point & Game Loop

`src/main.ts` is the entry point. Initialization flow: load WAD → parse textures/sprites/palette → init map → init renderer → init input/audio → start game loop.

The game loop (`src/game/loop.ts`) runs at a fixed 35 tics/second (TICRATE) with accumulator-based timing. Each frame has two phases:
1. **Tick** — update game logic (player, thinkers, AI, projectiles, specials)
2. **Draw** — render current state via the software renderer

### Game State Machine (`game/gamestate.ts`)

States: `GS_LEVEL` (gameplay), `GS_INTERMISSION` (stats screen), `GS_FINALE` (story text), `GS_DEMOSCREEN` (title). Transitions driven by `GameAction` enum.

### Software Renderer (`src/render/software/`)

BSP tree traversal renderer faithful to the original DOOM algorithm:
- `render-pipeline.ts` — orchestrates render passes
- `bsp-traverser.ts` — BSP tree traversal for visibility
- `wall-renderer.ts` — wall segments with texture mapping
- `plane-renderer.ts` — floor/ceiling (horizontal spans)
- `sprite-renderer.ts` — enemies, items, projectiles
- `weapon-overlay.ts` — first-person weapon sprites
- `gbuffer.ts` — G-Buffer for deferred effects (fuzz, lights)
- `postprocess.ts` — dynamic lights, light smoothing, fuzz resolution
- `draw.ts` — low-level pixel output, SCREENWIDTH/SCREENHEIGHT constants

### Key Game Systems

| System | Files | Notes |
|--------|-------|-------|
| Map Objects | `game/mobj.ts`, `game/mobjinfo.ts` | Runtime thing state, 60+ thing definitions with flags |
| Player | `game/player.ts` | Movement, collision, weapon switching, momentum |
| AI | `game/enemy.ts` | A_Look, A_Chase, pathfinding, sound propagation, infighting |
| Physics | `game/p_move.ts` | Linedef collision, blockmap acceleration, step-ups, dropoffs |
| Combat | `game/combat.ts` | Hitscan raycasting, radius damage, explosions |
| Projectiles | `game/projectiles.ts` | 12+ types, spawning, movement, collision |
| Weapons | `game/weapons.ts` | 9 weapon types, psprite animation, fire logic |
| Sector Specials | `game/specials.ts` | Doors, lifts, crushers, stairs, teleporters, lighting (~1700 lines) |
| Thinkers | `game/thinkers.ts` | Per-tick update loop for all active game objects |
| Sight | `game/sight.ts` | Line-of-sight checking for AI and combat |
| Sound | `src/sound/s_sound.ts`, `src/sound/i_sound.ts` | 8 channels, positional audio, distance attenuation |
| Save/Load | `game/savegame.ts` | Full game state serialization |

### Math Conventions (matching original DOOM)

- **Fixed-point**: 16-bit fractional part (`FRACBITS=16`, `FRACUNIT=65536`). All positions/velocities use this.
- **BAM angles**: 32-bit binary angles (`0x40000000` = 90 degrees). Lookup tables: `finesine[]`, `finecosine[]`.
- **Blockmap**: 128x128 unit grid accelerating collision and sight checks.
- **Validcount pattern**: global counter to mark visited nodes without clearing arrays.
- **Random**: `game/random.ts` — deterministic PRNG table matching original DOOM.

## Coding Conventions

- Code references original DOOM C source in comments (e.g., `// Reference: p_enemy.c (A_Chase)`)
- Function/variable names mirror the original where applicable (`P_RadiusAttack`, `A_Chase`, `FRACUNIT`)
- TypeScript strict mode enabled
- ES modules throughout, bundled by Vite
- No automated linting or formatting tools configured

## Feature Completeness

See `.docs/UNIMPLEMENTED_MECHANICS.md` for a detailed checklist (~125/157 mechanics implemented). Key gaps: Revenant homing missiles, Icon of Sin cube spawner, Cast Call screen, demo recording, multiplayer.
