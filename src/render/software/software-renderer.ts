// ============================================================
// SoftwareRenderer — Implements the Renderer interface using
// a CPU-based BSP renderer pipeline.
// ============================================================

import type { Renderer } from '../../../game/renderer-interface';
import type { GameMap } from '../../map';
import type { TextureData } from '../../textures';
import type { PaletteData } from '../../palette';
import type { WAD } from '../../wad';
import type { WeaponPlayer } from '../../../game/weapons';
import { RenderPipeline } from './render-pipeline';
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
  private pipeline = new RenderPipeline();
  private _passesRegistered = false;

  /** Call once per level load with renderer-specific dependencies. */
  init(map: GameMap, texData: TextureData, palData: PaletteData, wad?: WAD): void {
    this.pipeline.init(map, texData, palData, wad);
    // Register software-specific postprocess passes (once)
    if (!this._passesRegistered) {
      addPostProcessPass(lightSmoothPass);
      addPostProcessPass(dynamicLightsPass);
      this._passesRegistered = true;
    }
  }

  setView(x: number, y: number, z: number, angle: number): void {
    this.pipeline.view.setPosition(this.pipeline.ctx, x, y, z, angle);
  }

  renderFrame(): void {
    this.pipeline.renderFrame();
    this.pipeline.resolve();
  }

  setWeaponPlayer(player: WeaponPlayer): void {
    this.pipeline.weapon.setPlayer(player);
  }

  drawWeaponOverlay(): void {
    this.pipeline.weapon.draw(this.pipeline.ctx);
  }

  setWeaponInvisible(invisible: boolean): void {
    this.pipeline.weapon.invisible = invisible;
  }

  setExtraLight(level: number): void {
    this.pipeline.ctx.extralight = level;
  }

  cycleRenderMode(): void {
    this.pipeline.cycleRenderMode();
  }

  getRenderMode(): string {
    return this.pipeline.getRenderMode();
  }

  rebuildLightTables(): void {
    this.pipeline.rebuildLightTables();
  }

  setResolution(width: number, height: number): void {
    setResolution_internal(width, height);
    this.pipeline.setResolution();
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
    spawnStaticLights_internal(things, pointInSubsector);
  }

  setLightView(x: number, y: number, z: number): void {
    setDynLightView(x, y, z);
  }

  setDynLightsEnabled(enabled: boolean): void {
    setDynLightsEnabled_internal(enabled);
  }
}
