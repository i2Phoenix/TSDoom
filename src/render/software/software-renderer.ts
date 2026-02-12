// ============================================================
// SoftwareRenderer — wraps existing free-function BSP renderer
// Delegates all calls to renderer.ts, draw.ts, gbuffer.ts, etc.
// No internal refactoring — existing code stays as-is.
// ============================================================

import type { Renderer } from '../../../game/renderer-interface';
import type { GameMap } from '../../map';
import type { TextureData } from '../../textures';
import type { PaletteData } from '../../palette';
import type { WAD } from '../../wad';
import type { WeaponPlayer } from '../../../game/weapons';
import {
  initRenderer,
  setViewPosition,
  renderFrame as renderFrame_internal,
  resolveGBuffer,
  resolveFuzzPixels,
  drawPSprites,
  setPspritePlayer,
  setExtraLight as setExtraLight_internal,
  cycleRenderMode as cycleRenderMode_internal,
  getRenderMode as getRenderMode_internal,
  rebuildLightTables as rebuildLightTables_internal,
  renderDepthOverlay,
} from './renderer';
import {
  SCREENWIDTH,
  SCREENHEIGHT,
  rgbaBuffer,
  setResolution as setResolution_internal,
} from './draw';
import {
  addDynLight as addDynLight_internal,
  removeDynLightAt,
  updateDynLights,
  clearDynLights,
  spawnStaticLights as spawnStaticLights_internal,
  setDynLightView,
  setDynLightsEnabled as setDynLightsEnabled_internal,
  dynamicLightsPass,
} from './dynlights';
import { lightSmoothPass } from './lightsmooth';
import { addPostProcessPass } from './postprocess';

export class SoftwareRenderer implements Renderer {
  private _passesRegistered = false;

  /** Call once per level load with renderer-specific dependencies. */
  init(map: GameMap, texData: TextureData, palData: PaletteData, wad?: WAD): void {
    initRenderer(map, texData, palData, wad);
    // Register software-specific postprocess passes (once)
    if (!this._passesRegistered) {
      addPostProcessPass(lightSmoothPass);
      addPostProcessPass(dynamicLightsPass);
      this._passesRegistered = true;
    }
  }

  setView(x: number, y: number, z: number, angle: number): void {
    setViewPosition(x, y, z, angle);
  }

  renderFrame(): void {
    renderFrame_internal();
    resolveGBuffer();
    resolveFuzzPixels();
    if (getRenderMode_internal() === 'depth') {
      renderDepthOverlay();
    }
  }

  setWeaponPlayer(player: WeaponPlayer): void {
    setPspritePlayer(player);
  }

  drawWeaponOverlay(): void {
    drawPSprites();
  }

  setExtraLight(level: number): void {
    setExtraLight_internal(level);
  }

  cycleRenderMode(): void {
    cycleRenderMode_internal();
  }

  getRenderMode(): string {
    return getRenderMode_internal();
  }

  rebuildLightTables(): void {
    rebuildLightTables_internal();
  }

  setResolution(width: number, height: number): void {
    setResolution_internal(width, height);
  }

  get screenWidth(): number {
    return SCREENWIDTH;
  }

  get screenHeight(): number {
    return SCREENHEIGHT;
  }

  getFrameBuffer(): Uint32Array | null {
    return rgbaBuffer;
  }

  // ---- Dynamic Lighting ----

  addDynLight(
    x: number, y: number, z: number,
    radius: number,
    r: number, g: number, b: number,
    intensity: number,
    ttl: number,
  ): void {
    addDynLight_internal(x, y, z, radius, r, g, b, intensity, ttl);
  }

  removeDynLight(x: number, y: number, tolerance?: number): void {
    removeDynLightAt(x, y, tolerance);
  }

  updateLights(): void {
    updateDynLights();
  }

  clearLights(): void {
    clearDynLights();
  }

  spawnStaticLights(
    things: readonly { x: number; y: number; type: number }[],
    pointInSubsector: (x: number, y: number) => { sector?: { floorHeight: number } | null },
  ): void {
    spawnStaticLights_internal(things as any, pointInSubsector);
  }

  setLightView(x: number, y: number, z: number): void {
    setDynLightView(x, y, z);
  }

  setDynLightsEnabled(enabled: boolean): void {
    setDynLightsEnabled_internal(enabled);
  }
}

