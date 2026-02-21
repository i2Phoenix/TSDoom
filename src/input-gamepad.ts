// ============================================================
// Gamepad Input Provider — Doom-standard layout (Gamepad API)
// ============================================================
// Left Stick  = movement (forward/backward/strafe)
// Right Stick = turn (lookX/lookY)
// RT (7)      = Fire
// A  (0)      = Use
// LB (4)      = Run
// D-pad       = Weapon switch
// Start (9)   = Menu (handled externally)
// ============================================================

import { InputProvider, InputState, createDefaultInputState } from '../game/input-system';

const DEADZONE = 0.15;
const GAMEPAD_TURN_SENSITIVITY = 24; // tuned to feel close to mouse

function applyDeadzone(value: number, dz: number): number {
  if (Math.abs(value) < dz) return 0;
  // Remap [dz..1] → [0..1]
  const sign = value > 0 ? 1 : -1;
  return sign * ((Math.abs(value) - dz) / (1 - dz));
}

/** Track previous D-pad state for edge-triggered weapon switching */
let prevDpadUp = false;
let prevDpadDown = false;

/** Weapon select: -1 = none, -2 = next, -3 = prev, 0-6 = direct slot */
function pollWeaponDpad(gp: Gamepad): number {
  const up = gp.buttons[12]?.pressed ?? false;
  const down = gp.buttons[13]?.pressed ?? false;

  let select = -1;

  // Edge-triggered: only on press, not hold
  if (up && !prevDpadUp) {
    select = -2; // next weapon
  } else if (down && !prevDpadDown) {
    select = -3; // previous weapon
  }

  prevDpadUp = up;
  prevDpadDown = down;

  return select;
}

/** The gamepad input provider */
export const gamepadProvider: InputProvider = {
  poll(): InputState {
    const gamepads = navigator.getGamepads();
    const gp = gamepads[0];
    if (!gp) return createDefaultInputState();

    const leftX = applyDeadzone(gp.axes[0] ?? 0, DEADZONE);
    const leftY = applyDeadzone(gp.axes[1] ?? 0, DEADZONE);
    const rightX = applyDeadzone(gp.axes[2] ?? 0, DEADZONE);
    const rightY = applyDeadzone(gp.axes[3] ?? 0, DEADZONE);

    return {
      forward: leftY < -DEADZONE,
      backward: leftY > DEADZONE,
      strafeLeft: leftX < -DEADZONE,
      strafeRight: leftX > DEADZONE,
      turnLeft: false,   // analog turn via lookX
      turnRight: false,
      lookX: rightX * GAMEPAD_TURN_SENSITIVITY,
      lookY: rightY,
      fire: gp.buttons[7]?.pressed ?? false,   // RT
      use: gp.buttons[0]?.pressed ?? false,     // A
      run: gp.buttons[4]?.pressed ?? false,     // LB
      weaponSelect: pollWeaponDpad(gp),
      joyMoveX: 0,     // gamepad uses lookX for turning, left stick for digital move
      joyMoveY: leftY,  // analog forward/backward from left stick
    };
  },

  resetAccumulated(): void {
    // No accumulated state for gamepad — axes are instantaneous
  },

  clearAll(): void {
    prevDpadUp = false;
    prevDpadDown = false;
  },
};

/** Returns true if a gamepad is connected */
export function isGamepadConnected(): boolean {
  const gamepads = navigator.getGamepads();
  return gamepads[0] != null;
}
