// ============================================================
// Mobile Touch Input Provider (Virtual Keyboard + Joystick)
// ============================================================

let touchEnabled = false;

// Map codes to "key" values for complete emulation
const keyValues: Record<string, string> = {
  'ArrowUp': 'ArrowUp',
  'ArrowDown': 'ArrowDown',
  'ArrowLeft': 'ArrowLeft',
  'ArrowRight': 'ArrowRight',
  'ControlLeft': 'Control',
  'Space': ' ',
  'ShiftLeft': 'Shift',
  'Escape': 'Escape',
  'Tab': 'Tab',
  'Enter': 'Enter',
};

// Dispatch events on document (or body) to ensure they bubble up correctly
// to listeners attached to document/window.
function simulateKey(code: string, down: boolean) {
  const eventName = down ? 'keydown' : 'keyup';
  const key = keyValues[code] || '';
  
  const event = new KeyboardEvent(eventName, {
    code: code,
    key: key,
    bubbles: true,
    cancelable: true,
    view: window,
    // Add these for better compatibility if needed
    // location: 0,
    // ctrlKey: ...
  });
  
  // Dispatch on document.body to be safe, or direct to document
  document.dispatchEvent(event);
}

// ── Key Repeat State ───────────────────────────────────────
const REPEAT_DELAY = 400;
const REPEAT_RATE = 100;

interface KeyState {
  code: string;
  isDown: boolean;
  lastRepeat: number;
  initialPressTime: number;
}

const keyStates = new Map<string, KeyState>();

function setKey(code: string, down: boolean) {
  const now = performance.now();
  let state = keyStates.get(code);
  
  if (!state) {
    state = { code, isDown: false, lastRepeat: 0, initialPressTime: 0 };
    keyStates.set(code, state);
  }

  if (down && !state.isDown) {
    // Initial press
    state.isDown = true;
    state.initialPressTime = now;
    state.lastRepeat = now;
    simulateKey(code, true);
  } else if (!down && state.isDown) {
    // Release
    state.isDown = false;
    simulateKey(code, false);
  }
}

// Polling loop for key repeat
function pollKeyRepeat() {
  if (touchEnabled) {
    const now = performance.now();

    keyStates.forEach(state => {
      if (!state.isDown) return;

      // Only repeat directional keys
      if (!state.code.startsWith('Arrow')) return;

      const timeHeld = now - state.initialPressTime;
      
      if (timeHeld > REPEAT_DELAY) {
        if (now - state.lastRepeat > REPEAT_RATE) {
          // Pulse key up then down to simulate repeat for menu
          simulateKey(state.code, false);
          simulateKey(state.code, true);
          state.lastRepeat = now;
        }
      }
    });
  }

  requestAnimationFrame(pollKeyRepeat);
}

// Start polling
requestAnimationFrame(pollKeyRepeat);


// ── Joystick State ─────────────────────────────────────────
let joyActive = false;
let joyOriginX = 0;
let joyOriginY = 0;
let joyPointerId = -1;

const JOY_THRESHOLD = 10; // reduced threshold for finer control
const JOY_MAX_RADIUS = 40; // clamp radius matching CSS

// Current active logical keys
const activeKeys = new Set<string>();

function updateJoystickKeys(x: number, y: number) {
  const dx = x - joyOriginX;
  const dy = y - joyOriginY;
  
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  // New state
  const newKeys = new Set<string>();

  if (absDy > JOY_THRESHOLD) {
    if (dy < 0) newKeys.add('ArrowUp');
    else newKeys.add('ArrowDown');
  }

  if (absDx > JOY_THRESHOLD) {
    if (dx < 0) newKeys.add('ArrowLeft');
    else newKeys.add('ArrowRight');
  }

  // Diff state using setKey helper
  activeKeys.forEach(key => {
    if (!newKeys.has(key)) {
      setKey(key, false);
      activeKeys.delete(key);
    }
  });

  newKeys.forEach(key => {
    if (!activeKeys.has(key)) {
      setKey(key, true);
      activeKeys.add(key);
    }
  });

  // Update visual knob
  const knob = document.getElementById('joystick-knob');
  if (knob) {
    const dist = Math.sqrt(dx * dx + dy * dy);
    let visDx = dx;
    let visDy = dy;
    
    // Clamp to radius
    if (dist > JOY_MAX_RADIUS) {
      visDx = (dx / dist) * JOY_MAX_RADIUS;
      visDy = (dy / dist) * JOY_MAX_RADIUS;
    }
    
    knob.style.transform = `translate(calc(-50% + ${visDx}px), calc(-50% + ${visDy}px))`;
  }
}

function endJoystick() {
  if (!joyActive) return;
  
  joyActive = false;
  joyPointerId = -1;
  const knob = document.getElementById('joystick-knob');
  if (knob) {
    knob.style.transform = `translate(-50%, -50%)`;
  }

  activeKeys.forEach(key => {
    setKey(key, false);
  });
  activeKeys.clear();
}

/**
 * Initialize touch controls if valid touch elements exist.
 */
export function initTouchControls(): void {
  const container = document.getElementById('touch-controls');
  if (!container) return;

  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  
  if (isTouchDevice) {
    console.log('[Input] Touch device detected, enabling on-screen controls.');
    container.style.display = 'flex';
    touchEnabled = true;

    // ── Bind Standard Buttons (Action, Utils, and D-Pad Segments) ──
    const buttons = document.querySelectorAll('.touch-btn, .dpad-segment');
    buttons.forEach((btn) => {
      const code = btn.getAttribute('data-key');
      if (!code) return;

      const handleStart = (e: Event) => {
        if (e.cancelable) e.preventDefault();
        btn.classList.add('active');
        setKey(code, true);
        try { if (navigator.vibrate) navigator.vibrate(10); } catch (_) {}
      };

      const handleEnd = (e: Event) => {
        if (e.cancelable) e.preventDefault();
        btn.classList.remove('active');
        setKey(code, false);
      };

      btn.addEventListener('pointerdown', (e) => {
        handleStart(e);
        (btn as HTMLElement).setPointerCapture((e as PointerEvent).pointerId);
      });
      btn.addEventListener('pointerup', (e) => {
        handleEnd(e);
        (btn as HTMLElement).releasePointerCapture((e as PointerEvent).pointerId);
      });
      btn.addEventListener('pointercancel', handleEnd);
      // Prevent context menu
      btn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    });

    // ── Bind Fixed Joystick (Base + Knob) ──
    const joyBase = document.getElementById('joystick-base');
    
    if (joyBase) {
      joyBase.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (joyActive) return;
        
        (joyBase as HTMLElement).setPointerCapture(e.pointerId);
        joyActive = true;
        joyPointerId = e.pointerId;

        // Origin is the center of the base element
        const rect = joyBase.getBoundingClientRect();
        joyOriginX = rect.left + rect.width / 2;
        joyOriginY = rect.top + rect.height / 2;

        // Update immediately based on touch position relative to center
        updateJoystickKeys(e.clientX, e.clientY);
        
        try { if (navigator.vibrate) navigator.vibrate(10); } catch (_) {}
      });

      joyBase.addEventListener('pointermove', (e) => {
        if (!joyActive || e.pointerId !== joyPointerId) return;
        e.preventDefault();
        updateJoystickKeys(e.clientX, e.clientY);
      });

      const handleJoyEnd = (e: PointerEvent) => {
        if (!joyActive || e.pointerId !== joyPointerId) return;
        e.preventDefault();
        (joyBase as HTMLElement).releasePointerCapture(e.pointerId);
        endJoystick();
      };

      joyBase.addEventListener('pointerup', handleJoyEnd);
      joyBase.addEventListener('pointercancel', handleJoyEnd);
      joyBase.addEventListener('pointerleave', handleJoyEnd);
    }
  }
}
