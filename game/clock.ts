// ============================================================
// PlatformClock — abstract timing interface
// Browser: performance.now() + requestAnimationFrame
// Server:  process.hrtime + setImmediate / fixed-step
// ============================================================

export interface PlatformClock {
  /** Current time in milliseconds (high resolution) */
  now(): number;
  /** Request next frame callback (like rAF) */
  requestFrame(callback: (time: number) => void): void;
  /** Cancel pending frame request */
  cancelFrame(): void;
}

/** Browser clock — uses performance.now + requestAnimationFrame */
export function createBrowserClock(): PlatformClock {
  let rafId = 0;
  return {
    now: () => performance.now(),
    requestFrame(cb) { rafId = requestAnimationFrame(cb); },
    cancelFrame() { cancelAnimationFrame(rafId); },
  };
}
