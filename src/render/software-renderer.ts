// ============================================================
// SoftwareRenderer — wraps existing free-function BSP renderer
// Delegates all calls to renderer.ts, draw.ts, gbuffer.ts, etc.
// No internal refactoring — existing code stays as-is.
// ============================================================

import type { Renderer } from '../../game/renderer-interface';
import type { GameMap } from '../map';
import type { TextureData } from '../textures';
import type { PaletteData } from '../palette';
import type { WAD } from '../wad';
import type { WeaponPlayer } from '../../game/weapons';
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

export class SoftwareRenderer implements Renderer {
  /** Call once per level load with renderer-specific dependencies. */
  init(map: GameMap, texData: TextureData, palData: PaletteData, wad?: WAD): void {
    initRenderer(map, texData, palData, wad);
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
}
