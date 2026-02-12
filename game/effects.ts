// ============================================================
// EffectHandler — Platform-agnostic abstraction for side effects
// (sound, dynamic lights, muzzle flash).
//
// Game logic calls FX_* wrappers which delegate to the current
// handler.  Client sets a real handler; server uses a null/no-op.
// ============================================================

import { Sfx, Music } from './sounds';

/** Anything with a world position (for positional sounds) */
export interface SoundOrigin {
  x: number;
  y: number;
}

/**
 * EffectHandler interface — implemented by the platform layer.
 */
export interface EffectHandler {
  /** Play a positional sound effect at (x, y) */
  sound(origin: SoundOrigin | null, sfx: Sfx): void;

  /** Change background music */
  music(mus: Music, looping: boolean): void;

  /** Add a temporary or permanent dynamic point light */
  dynLight(
    x: number, y: number, z: number,
    radius: number,
    r: number, g: number, b: number,
    intensity: number,
    ttl: number
  ): void;

  /** Remove a permanent dynamic light near a position */
  removeDynLight(x: number, y: number, tolerance?: number): void;

  /** Set extra light level (muzzle flash: 0 = off, 1-2 = flash) */
  setExtraLight(level: number): void;

  /**
   * Trigger controller vibration / haptic feedback.
   * @param weakMagnitude  — high-frequency motor (0..1)
   * @param strongMagnitude — low-frequency motor (0..1)
   * @param durationMs — how long to vibrate in milliseconds
   */
  vibrate(weakMagnitude: number, strongMagnitude: number, durationMs: number): void;
}

// ---- Null (no-op) handler for server / tests ----

function createNullHandler(): EffectHandler {
  return {
    sound() {},
    music() {},
    dynLight() {},
    removeDynLight() {},
    setExtraLight() {},
    vibrate() {},
  };
}

// ---- Global handler + registration ----

let _handler: EffectHandler = createNullHandler();

/** Register the platform-specific EffectHandler */
export function setEffectHandler(h: EffectHandler): void {
  _handler = h;
}

// ---- FX_ wrapper functions (called by game logic) ----

/** Play a positional or global sound */
export function FX_Sound(origin: SoundOrigin | null, sfx: Sfx): void {
  _handler.sound(origin, sfx);
}

/** Change background music */
export function FX_Music(mus: Music, looping: boolean): void {
  _handler.music(mus, looping);
}

/** Add a dynamic point light */
export function FX_DynLight(
  x: number, y: number, z: number,
  radius: number,
  r: number, g: number, b: number,
  intensity: number,
  ttl: number
): void {
  _handler.dynLight(x, y, z, radius, r, g, b, intensity, ttl);
}

/** Remove a permanent light near a world position */
export function FX_RemoveDynLight(x: number, y: number, tolerance?: number): void {
  _handler.removeDynLight(x, y, tolerance);
}

/** Set extra light level (muzzle flash) */
export function FX_SetExtraLight(level: number): void {
  _handler.setExtraLight(level);
}

/** Trigger controller vibration */
export function FX_Vibrate(weakMagnitude: number, strongMagnitude: number, durationMs: number): void {
  _handler.vibrate(weakMagnitude, strongMagnitude, durationMs);
}
