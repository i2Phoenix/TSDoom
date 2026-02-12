// ============================================================
// Renderer Singleton Accessor
// Same pattern as world.ts — crash-on-null guarantees init order.
// ============================================================

import type { Renderer } from './renderer-interface';

let renderer: Renderer | null = null;

/** Register the active renderer implementation. Call once at startup. */
export function setRenderer(r: Renderer): void {
  renderer = r;
}

/**
 * Get the active renderer.
 * Crashes if called before setRenderer() — this is intentional to
 * surface init-order bugs immediately.
 */
export function getRenderer(): Renderer {
  if (!renderer) throw new Error('getRenderer() called before setRenderer()');
  return renderer;
}
