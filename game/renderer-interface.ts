// ============================================================
// Renderer Interface
// Platform-independent abstraction over the rendering backend.
// Implementations: SoftwareRenderer, HeadlessRenderer, WebGPURenderer
// ============================================================

/**
 * Abstract renderer interface.
 *
 * The `init()` method is intentionally excluded — each implementation
 * has its own typed constructor/init that takes renderer-specific
 * dependencies (e.g. TextureData, PaletteData for software renderer).
 * Initialization is done once by the platform bootstrap (main.ts).
 */
export interface Renderer {
  /** Set camera position for the current frame */
  setView(x: number, y: number, z: number, angle: number): void;

  /**
   * Run the full render pipeline for one frame.
   * For software: BSP traversal → walls → planes → sprites → G-Buffer resolve → fuzz
   * For headless: no-op
   */
  renderFrame(): void;

  /** Draw weapon overlay on top of the scene */
  drawWeaponOverlay(): void;

  /** Set extra light level (0 = normal, 1–2 = gun flash) */
  setExtraLight(level: number): void;

  /** Cycle render debug mode (e.g. normal → depth → normal) */
  cycleRenderMode(): void;

  /** Get current render debug mode name */
  getRenderMode(): string;

  /** Rebuild lighting tables (after palette/color-mode change) */
  rebuildLightTables(): void;

  /** Change render resolution */
  setResolution(width: number, height: number): void;

  /** Current screen width in pixels */
  readonly screenWidth: number;

  /** Current screen height in pixels */
  readonly screenHeight: number;

  /** Get the RGBA frame buffer, or null for headless/GPU renderers */
  getFrameBuffer(): Uint32Array | null;

  // ---- Dynamic Lighting ----

  /** Add a dynamic point light (muzzle flash, explosion, torch glow) */
  addDynLight(
    x: number, y: number, z: number,
    radius: number,
    r: number, g: number, b: number,
    intensity: number,
    ttl: number,
  ): void;

  /** Remove a permanent light near a world position */
  removeDynLight(x: number, y: number, tolerance?: number): void;

  /** Tick lights: decay TTL, remove expired, flicker permanent lights */
  updateLights(): void;

  /** Clear all lights (level change) */
  clearLights(): void;

  /** Spawn static lights from map things (torches, lamps, candles) */
  spawnStaticLights(
    things: readonly { x: number; y: number; type: number }[],
    pointInSubsector: (x: number, y: number) => { sector?: { floorHeight: number } | null },
  ): void;

  /** Set camera position for light distance culling (call before render) */
  setLightView(x: number, y: number, z: number): void;

  /** Enable or disable dynamic lights */
  setDynLightsEnabled(enabled: boolean): void;
}
