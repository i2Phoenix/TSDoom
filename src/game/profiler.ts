// ============================================================
// Performance Profiler — per-frame timing breakdown
// Toggle with F3 key
// ============================================================

const HISTORY_SIZE = 60; // average over 60 frames (~1 sec at 60fps)

interface PhaseEntry {
  name: string;
  times: Float64Array;
  idx: number;
  sum: number;
}

const phases = new Map<string, PhaseEntry>();
const phaseOrder: string[] = [];

let frameStart = 0;
let frameTimes = new Float64Array(HISTORY_SIZE);
let frameIdx = 0;
let frameSum = 0;

let tickStart = 0;
let tickTimes = new Float64Array(HISTORY_SIZE);
let tickIdx = 0;
let tickSum = 0;

let enabled = false;
let overlayVisible = false;

// ---- Public API ----

export function isProfilerVisible(): boolean {
  return overlayVisible;
}

export function toggleProfiler(): void {
  overlayVisible = !overlayVisible;
  if (!overlayVisible) {
    enabled = false;
  } else {
    enabled = true;
  }
}

/** Call at the start of the draw function */
export function profilerFrameStart(): void {
  if (!enabled) return;
  frameStart = performance.now();
}

/** Call at the end of the draw function */
export function profilerFrameEnd(): void {
  if (!enabled) return;
  const elapsed = performance.now() - frameStart;
  frameSum -= frameTimes[frameIdx];
  frameTimes[frameIdx] = elapsed;
  frameSum += elapsed;
  frameIdx = (frameIdx + 1) % HISTORY_SIZE;
}

/** Call at the start of the tick function */
export function profilerTickStart(): void {
  if (!enabled) return;
  tickStart = performance.now();
}

/** Call at the end of the tick function */
export function profilerTickEnd(): void {
  if (!enabled) return;
  const elapsed = performance.now() - tickStart;
  tickSum -= tickTimes[tickIdx];
  tickTimes[tickIdx] = elapsed;
  tickSum += elapsed;
  tickIdx = (tickIdx + 1) % HISTORY_SIZE;
}

const phaseStack: number[] = [];

/** Begin timing a named phase */
export function profilerBegin(name: string): void {
  if (!enabled) return;
  // Register phase on first encounter (parent before children)
  if (!phases.has(name)) {
    phases.set(name, {
      name,
      times: new Float64Array(HISTORY_SIZE),
      idx: 0,
      sum: 0,
    });
    phaseOrder.push(name);
  }
  phaseStack.push(performance.now());
}

/** End timing a named phase */
export function profilerEnd(name: string): void {
  if (!enabled) return;
  const start = phaseStack.pop();
  if (start === undefined) return;
  const elapsed = performance.now() - start;

  const entry = phases.get(name)!;
  entry.sum -= entry.times[entry.idx];
  entry.times[entry.idx] = elapsed;
  entry.sum += elapsed;
  entry.idx = (entry.idx + 1) % HISTORY_SIZE;
}

/** Get the average frame time in ms */
function avgFrame(): number {
  return frameSum / HISTORY_SIZE;
}

/** Get the average tick time in ms */
function avgTick(): number {
  return tickSum / HISTORY_SIZE;
}

/**
 * Draw the profiler overlay onto the given RGBA buffer.
 * Uses a simple text renderer via canvas 2D passed from main.
 */
export function drawProfilerOverlay(div: HTMLDivElement, fps: number): void {
  if (!overlayVisible) {
    div.style.display = 'none';
    return;
  }

  div.style.display = 'block';

  const ft = avgFrame();
  const tt = avgTick();
  const lines: string[] = [];

  lines.push(`${fps} FPS | frame ${ft.toFixed(2)}ms | tick ${tt.toFixed(2)}ms`);
  lines.push('─'.repeat(42));

  // Phase breakdown
  let totalPhase = 0;
  for (const name of phaseOrder) {
    const entry = phases.get(name)!;
    const avg = entry.sum / HISTORY_SIZE;
    totalPhase += avg;
    const bar = '█'.repeat(Math.min(Math.round(avg * 2), 20));
    lines.push(`${name.padEnd(16)} ${avg.toFixed(2).padStart(6)}ms ${bar}`);
  }

  lines.push('─'.repeat(42));
  lines.push(`${'total'.padEnd(16)} ${totalPhase.toFixed(2).padStart(6)}ms`);

  div.textContent = lines.join('\n');
}
