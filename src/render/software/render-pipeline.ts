// ============================================================
// RenderPipeline — Orchestrates the Software Rendering Pipeline
// Composes all extracted stages into a coherent frame loop.
// ============================================================

import type { RenderContext } from './render-context';
import { ViewSetup } from './view-setup';
import { BSPTraverser } from './bsp-traverser';
import { WallRenderer } from './wall-renderer';
import { PlaneRenderer } from './plane-renderer';
import { SpriteRenderer } from './sprite-renderer';
import { WeaponOverlay } from './weapon-overlay';

/**
 * RenderPipeline composes all rendering stages.
 * The WallRenderer implements SegCollector, serving as the
 * bridge between BSP traversal and wall/sprite rendering.
 */
export class RenderPipeline {
  readonly view: ViewSetup;
  readonly bsp: BSPTraverser;
  readonly walls: WallRenderer;
  readonly planes: PlaneRenderer;
  readonly sprites: SpriteRenderer;
  readonly weapon: WeaponOverlay;

  constructor(
    public readonly ctx: RenderContext,
  ) {
    this.view = new ViewSetup();
    this.bsp = new BSPTraverser();
    this.planes = new PlaneRenderer();
    this.sprites = new SpriteRenderer();
    this.walls = new WallRenderer(this.planes, this.sprites);
    this.weapon = new WeaponOverlay();
  }
}
