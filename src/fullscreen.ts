// ============================================================
// Fullscreen API + Screen Orientation management for mobile
// ============================================================

let isFs = false;
let onChangeCb: ((fs: boolean) => void) | null = null;

/** Check if Fullscreen API is available */
export function isFullscreenSupported(): boolean {
  return !!(
    document.documentElement.requestFullscreen ||
    (document.documentElement as any).webkitRequestFullscreen
  );
}

/** Current fullscreen state */
export function isFullscreen(): boolean {
  return isFs;
}

/** Toggle fullscreen (must be called from a user gesture) */
export function toggleFullscreen(): void {
  if (isFs) {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if ((document as any).webkitExitFullscreen) {
      (document as any).webkitExitFullscreen();
    }
  } else {
    const el = document.documentElement;
    if (el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' } as any).catch(() => {});
    } else if ((el as any).webkitRequestFullscreen) {
      (el as any).webkitRequestFullscreen();
    }
  }
}

function tryLockLandscape(): void {
  try {
    const o = screen.orientation as any;
    if (o && typeof o.lock === 'function') {
      o.lock('landscape').catch(() => {});
    }
  } catch {}
}

function unlockOrientation(): void {
  try {
    const o = screen.orientation as any;
    if (o && typeof o.unlock === 'function') {
      o.unlock();
    }
  } catch {}
}

/** Initialize fullscreen event listeners. Call once at startup. */
export function initFullscreen(onChange: (fs: boolean) => void): void {
  onChangeCb = onChange;

  const handler = () => {
    isFs = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
    if (isFs) {
      tryLockLandscape();
    } else {
      unlockOrientation();
    }
    onChangeCb?.(isFs);
  };

  document.addEventListener('fullscreenchange', handler);
  document.addEventListener('webkitfullscreenchange', handler);
}
