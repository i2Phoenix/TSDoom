// ============================================================
// Composite Input Provider — transparent keyboard ↔ gamepad
// Both devices always active, no manual switching needed.
// ============================================================

import { InputProvider, InputState, createDefaultInputState } from '../game/input-system';

export type ActiveDevice = 'keyboard' | 'gamepad';

function hasActivity(state: InputState): boolean {
  return (
    state.forward || state.backward ||
    state.turnLeft || state.turnRight ||
    state.strafeLeft || state.strafeRight ||
    state.use || state.fire || state.run ||
    Math.abs(state.lookX) > 0.01 ||
    state.weaponSelect >= 0
  );
}

export class CompositeInputProvider implements InputProvider {
  private providers: InputProvider[];
  private lastActiveDevice: ActiveDevice = 'keyboard';

  /**
   * @param providers — [keyboard, gamepad] (order matters for device detection)
   */
  constructor(providers: InputProvider[]) {
    this.providers = providers;
  }

  poll(): InputState {
    const states = this.providers.map(p => p.poll());

    // Auto-detect active device (for UI hints only)
    if (states.length > 1 && hasActivity(states[1])) {
      this.lastActiveDevice = 'gamepad';
    } else if (states.length > 0 && hasActivity(states[0])) {
      this.lastActiveDevice = 'keyboard';
    }

    return this.merge(states);
  }

  resetAccumulated(): void {
    for (const p of this.providers) p.resetAccumulated();
  }

  clearAll(): void {
    for (const p of this.providers) p.clearAll();
  }

  /** Last active device — for showing button glyphs vs key text in HUD */
  getActiveDevice(): ActiveDevice {
    return this.lastActiveDevice;
  }

  private merge(states: InputState[]): InputState {
    if (states.length === 0) return createDefaultInputState();
    if (states.length === 1) return states[0];

    const a = states[0];
    const b = states[1];

    return {
      // Boolean actions: OR (either device triggers)
      forward: a.forward || b.forward,
      backward: a.backward || b.backward,
      turnLeft: a.turnLeft || b.turnLeft,
      turnRight: a.turnRight || b.turnRight,
      strafeLeft: a.strafeLeft || b.strafeLeft,
      strafeRight: a.strafeRight || b.strafeRight,
      use: a.use || b.use,
      fire: a.fire || b.fire,
      run: a.run || b.run,
      // Analog axes: sum (mouse + right stick)
      lookX: a.lookX + b.lookX,
      lookY: a.lookY + b.lookY,
      // Weapon select: prefer most recent non-negative
      weaponSelect: b.weaponSelect >= 0 ? b.weaponSelect : a.weaponSelect,
    };
  }
}
