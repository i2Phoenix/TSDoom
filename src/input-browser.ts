// ============================================================
// Browser Keyboard + Mouse Input Provider
// Extracted from src/game/input.ts — implements InputProvider
// ============================================================

import { InputProvider, InputState, createDefaultInputState, setInputProvider } from '../game/input-system';
import { gamepadProvider } from './input-gamepad';
import { CompositeInputProvider } from './input-composite';

const state: InputState = createDefaultInputState();
let pointerLocked = false;

function handleKey(code: string, down: boolean, repeat: boolean = false): void {
  switch (code) {
    case 'KeyW':
    case 'ArrowUp':
      state.forward = down;
      break;
    case 'KeyS':
    case 'ArrowDown':
      state.backward = down;
      break;
    case 'KeyA':
      state.strafeLeft = down;
      break;
    case 'KeyD':
      state.strafeRight = down;
      break;
    case 'ArrowLeft':
      state.turnLeft = down;
      break;
    case 'ArrowRight':
      state.turnRight = down;
      break;
    case 'Space':
    case 'KeyE':
      state.use = down;
      break;
    case 'ControlLeft':
    case 'ControlRight':
      state.fire = down;
      break;
    case 'ShiftLeft':
    case 'ShiftRight':
      state.run = down;
      break;
    // Weapon slots: only on initial press, not key repeat
    case 'Digit1': if (down && !repeat) state.weaponSelect = 0; break;
    case 'Digit2': if (down && !repeat) state.weaponSelect = 1; break;
    case 'Digit3': if (down && !repeat) state.weaponSelect = 2; break;
    case 'Digit4': if (down && !repeat) state.weaponSelect = 3; break;
    case 'Digit5': if (down && !repeat) state.weaponSelect = 4; break;
    case 'Digit6': if (down && !repeat) state.weaponSelect = 5; break;
    case 'Digit7': if (down && !repeat) state.weaponSelect = 6; break;
  }
}

/** The browser keyboard+mouse input provider */
const browserKeyboardMouseProvider: InputProvider = {
  poll(): InputState {
    return state;
  },
  resetAccumulated(): void {
    state.lookX = 0;
    state.lookY = 0;
    state.weaponSelect = -1;  // consume weapon selection each tick
  },
  clearAll(): void {
    state.forward = false;
    state.backward = false;
    state.turnLeft = false;
    state.turnRight = false;
    state.strafeLeft = false;
    state.strafeRight = false;
    state.use = false;
    state.fire = false;
    state.run = false;
    state.lookX = 0;
    state.lookY = 0;
    state.weaponSelect = -1;
    state.joyMoveX = 0;
    state.joyMoveY = 0;
  },
};

/** Is the pointer currently locked? */
export function isPointerLocked(): boolean {
  return pointerLocked;
}

/** Accumulate touch look deltas into the keyboard+mouse input state. */
export function accumulateTouchLook(dx: number, dy: number): void {
  state.lookX += dx;
  state.lookY += dy;
}

/** Set analog joystick axes (persistent until changed, not accumulated). */
export function setJoystickAxes(x: number, y: number): void {
  state.joyMoveX = x;
  state.joyMoveY = y;
}

/**
 * Initialize browser keyboard + mouse input and register as the active provider.
 * Call once at startup after the canvas is created.
 * @param menuActiveCheck — function returning true when menu is active (input suppressed)
 */
export function initBrowserInput(canvas: HTMLCanvasElement, menuActiveCheck: () => boolean): void {
  window.addEventListener('keydown', (e) => {
    if (!menuActiveCheck()) handleKey(e.code, true, e.repeat);
    e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    if (!menuActiveCheck()) handleKey(e.code, false);
    e.preventDefault();
  });

  // Pointer lock for mouse control
  canvas.addEventListener('click', () => {
    if (!pointerLocked) {
      canvas.requestPointerLock();
    }
  });

  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
  });

  document.addEventListener('mousemove', (e) => {
    if (pointerLocked && !menuActiveCheck()) {
      state.lookX += e.movementX;
      state.lookY += e.movementY;
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (pointerLocked && !menuActiveCheck()) {
      if (e.button === 0) state.fire = true;
      if (e.button === 2) state.use = true;
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) state.fire = false;
    if (e.button === 2) state.use = false;
  });

  // Prevent context menu
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Register composite provider: keyboard + gamepad (both always active)
  const composite = new CompositeInputProvider([browserKeyboardMouseProvider, gamepadProvider]);
  setInputProvider(composite);
}
