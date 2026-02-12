// ============================================================
// Headless Renderer — No-op implementation for server / testing
// Zero dependencies. All draw calls are no-ops.
// ============================================================

import type { Renderer } from './renderer-interface';

export class HeadlessRenderer implements Renderer {
  private _width = 320;
  private _height = 200;

  setView(): void {}
  renderFrame(): void {}
  drawWeaponOverlay(): void {}
  setExtraLight(): void {}
  cycleRenderMode(): void {}
  getRenderMode(): string { return 'headless'; }
  rebuildLightTables(): void {}

  setResolution(width: number, height: number): void {
    this._width = width;
    this._height = height;
  }

  get screenWidth(): number { return this._width; }
  get screenHeight(): number { return this._height; }

  getFrameBuffer(): Uint32Array | null { return null; }

  // ---- Dynamic Lighting (no-ops for headless) ----
  addDynLight(): void {}
  removeDynLight(): void {}
  updateLights(): void {}
  clearLights(): void {}
  spawnStaticLights(): void {}
  setLightView(): void {}
  setDynLightsEnabled(): void {}
}
