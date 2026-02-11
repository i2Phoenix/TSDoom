// ============================================================
// Input Handler
// Reference: i_video.c — keyboard/mouse events
// ============================================================

import { menuactive } from './gamestate';

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
  mouseX: number;  // accumulated mouse movement
  mouseY: number;
  weaponSelect: number; // -1 = none, 0-6 = weapon slot (Digit1-7)
}

const state: InputState = {
  forward: false,
  backward: false,
  turnLeft: false,
  turnRight: false,
  strafeLeft: false,
  strafeRight: false,
  use: false,
  fire: false,
  run: false,
  mouseX: 0,
  mouseY: 0,
  weaponSelect: -1,
};

let pointerLocked = false;

export function initInput(canvas: HTMLCanvasElement): void {
  window.addEventListener('keydown', (e) => {
    if (!menuactive) handleKey(e.code, true);
    e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    if (!menuactive) handleKey(e.code, false);
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
    if (pointerLocked && !menuactive) {
      state.mouseX += e.movementX;
      state.mouseY += e.movementY;
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (pointerLocked && !menuactive) {
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
}

function handleKey(code: string, down: boolean): void {
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
    case 'Digit1': if (down) state.weaponSelect = 0; break;
    case 'Digit2': if (down) state.weaponSelect = 1; break;
    case 'Digit3': if (down) state.weaponSelect = 2; break;
    case 'Digit4': if (down) state.weaponSelect = 3; break;
    case 'Digit5': if (down) state.weaponSelect = 4; break;
    case 'Digit6': if (down) state.weaponSelect = 5; break;
    case 'Digit7': if (down) state.weaponSelect = 6; break;
  }
}

export function getInput(): InputState {
  return state;
}

export function resetMouseAccumulation(): void {
  state.mouseX = 0;
  state.mouseY = 0;
}

/** Reset all input state — call when opening menu to release stale held keys */
export function clearInputState(): void {
  state.forward = false;
  state.backward = false;
  state.turnLeft = false;
  state.turnRight = false;
  state.strafeLeft = false;
  state.strafeRight = false;
  state.use = false;
  state.fire = false;
  state.run = false;
  state.mouseX = 0;
  state.mouseY = 0;
  state.weaponSelect = -1;
}

export function isPointerLocked(): boolean {
  return pointerLocked;
}
