// ============================================================
// Client-side EffectHandler implementation
// Delegates FX_* calls to actual browser-based sound, light,
// and rendering modules.
// ============================================================

import type { EffectHandler, SoundOrigin } from '../game/effects';
import { setEffectHandler } from '../game/effects';
import { S_StartSound, S_ChangeMusic } from './sound/s_sound';
import { addDynLight, removeDynLightAt } from './render/dynlights';
import { setExtraLight } from './render/renderer';
import type { Sfx, Music } from '../game/sounds';

const clientEffects: EffectHandler = {
  sound(origin: SoundOrigin | null, sfx: Sfx): void {
    S_StartSound(origin as any, sfx);
  },

  music(mus: Music, looping: boolean): void {
    S_ChangeMusic(mus, looping);
  },

  dynLight(x, y, z, radius, r, g, b, intensity, ttl): void {
    addDynLight(x, y, z, radius, r, g, b, intensity, ttl);
  },

  removeDynLight(x: number, y: number, tolerance?: number): void {
    removeDynLightAt(x, y, tolerance);
  },

  setExtraLight(level: number): void {
    setExtraLight(level);
  },

  vibrate(weakMagnitude: number, strongMagnitude: number, durationMs: number): void {
    try {
      const gp = navigator.getGamepads?.()[0];
      if (!gp) return;
      const actuator = (gp as any).vibrationActuator;
      if (actuator?.playEffect) {
        actuator.playEffect('dual-rumble', {
          startDelay: 0,
          duration: durationMs,
          weakMagnitude: Math.min(1, Math.max(0, weakMagnitude)),
          strongMagnitude: Math.min(1, Math.max(0, strongMagnitude)),
        });
      }
    } catch { /* haptics not supported */ }
  },
};

/** Initialize the client-side effect handler. Call once at startup. */
export function initClientEffects(): void {
  setEffectHandler(clientEffects);
}
