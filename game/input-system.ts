// ============================================================
// InputSystem — Platform-independent input abstraction
// ============================================================

/**
 * Pure, platform-independent input state.
 * Game logic reads this; platform providers produce it.
 */
export interface InputState {
  forward: boolean;
  backward: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  strafeLeft: boolean;
  strafeRight: boolean;
  use: boolean;
  fire: boolean;
  run: boolean;
  lookX: number;      // accumulated analog turn (mouse or stick), reset each tick
  lookY: number;      // vertical (for free look)
  weaponSelect: number; // -1 = none, 0-6 = weapon slot
}

/** Provider interface — implemented per-platform */
export interface InputProvider {
  /** Poll current input state */
  poll(): InputState;
  /** Reset accumulated axes (mouse delta / stick) — call once per tick after reading */
  resetAccumulated(): void;
  /** Full reset — call when opening menu to release stale held keys */
  clearAll(): void;
}

/** Default empty input state */
export function createDefaultInputState(): InputState {
  return {
    forward: false,
    backward: false,
    turnLeft: false,
    turnRight: false,
    strafeLeft: false,
    strafeRight: false,
    use: false,
    fire: false,
    run: false,
    lookX: 0,
    lookY: 0,
    weaponSelect: -1,
  };
}

/** Null/no-op provider for server or tests */
export function createNullInputProvider(): InputProvider {
  return {
    poll: () => createDefaultInputState(),
    resetAccumulated: () => {},
    clearAll: () => {},
  };
}

// ---- Global injectable provider ----
let _provider: InputProvider = createNullInputProvider();

export function setInputProvider(p: InputProvider): void {
  _provider = p;
}

/** Game logic calls this to get input */
export function getInput(): InputState {
  return _provider.poll();
}

/** Game logic calls this to reset accumulated mouse/stick after reading */
export function resetInputAccumulated(): void {
  _provider.resetAccumulated();
}

/** Call when opening menu to release stale held keys */
export function clearInputState(): void {
  _provider.clearAll();
}
