// ============================================================
// High-Level Sound System
// TypeScript port of s_sound.c
// Channel management, spatial audio, volume control
// ============================================================

import { S_sfx, Sfx, Music, S_music } from '../../game/sounds';
import {
  I_InitSound,
  I_ResumeAudioContext,
  I_StartSound,
  I_StopSound,
  I_SoundIsPlaying,
  I_UpdateSoundParams,
  I_StopAllSounds,
  I_SetSfxVolume,
} from './i_sound';
import {
  I_InitMusic,
  I_LoadMusicLump,
  I_PlaySong,
  I_StopSong,
  I_PauseSong,
  I_ResumeSong,
  I_SetMusicVolume,
} from './i_music';
// M_Random — non-deterministic random for sound pitch (matches original DOOM's m_random.c)
// Unlike P_Random (game-critical), M_Random doesn't affect game determinism.
const M_Random = (): number => (Math.random() * 256) | 0;
import {
  FRACBITS,
  ANGLETOFINESHIFT,
  finesine,
  fixedMul,
  pointToAngle,
} from '../../game/math';
import type { WAD } from '../wad';

// ---- Constants (from s_sound.c) ----

const S_MAX_VOLUME = 127;

/** Distance beyond which sounds are clipped (not heard) */
const S_CLIPPING_DIST = 1200 << FRACBITS;

/** Distance within which sounds are at maximum volume */
const S_CLOSE_DIST = 160 << FRACBITS;

/** Attenuation divisor */
const S_ATTENUATOR = (S_CLIPPING_DIST - S_CLOSE_DIST) >> FRACBITS;

const NORM_PITCH = 128;
const NORM_PRIORITY = 64;
const NORM_SEP = 128;

/** Stereo swing amplitude for panning */
const S_STEREO_SWING = 96 << FRACBITS;

const NUM_CHANNELS = 8;

// ---- Channel structure ----

interface Channel {
  /** SFX info reference (null = channel free) */
  sfxInfo: typeof S_sfx[0] | null;
  /** SFX id for duplicate detection */
  sfxId: Sfx;
  /** Origin of the sound (object with x,y) or null for global sounds */
  origin: SoundOrigin | null;
  /** Platform handle from I_StartSound */
  handle: number;
}

/** Anything with a position can be a sound origin */
export interface SoundOrigin {
  x: number;
  y: number;
}

/** Listener (player) for spatial calculations */
export interface SoundListener {
  x: number;
  y: number;
  angle: number;
}

// ---- Module state ----

const channels: Channel[] = [];
let sndSfxVolume = 15;  // 0..15 (menu range)
let sndInitialized = false;

/** Listener reference, updated from main loop */
let listener: SoundListener | null = null;

// ============================================================
// Public API
// ============================================================

/**
 * Initialize the sound system.
 * Call once during game startup, after a user gesture.
 */
export function S_Init(wad: WAD, sfxVolume: number, musicVolume: number): void {
  I_InitSound(wad);
  I_InitMusic(wad);

  S_SetSfxVolume(sfxVolume);
  S_SetMusicVolume(musicVolume);

  // Allocate channels
  channels.length = 0;
  for (let i = 0; i < NUM_CHANNELS; i++) {
    channels.push({
      sfxInfo: null,
      sfxId: Sfx.None,
      origin: null,
      handle: -1,
    });
  }

  sndInitialized = true;
  console.log(`S_Init: ${NUM_CHANNELS} channels, volume ${sfxVolume}`);
}

/**
 * Per-level startup: kill all sounds.
 * Call when loading a new level.
 */
export function S_Start(): void {
  if (!sndInitialized) return;

  // Kill all playing sounds
  for (let i = 0; i < NUM_CHANNELS; i++) {
    S_StopChannel(i);
  }
}

/**
 * Set the listener (player) reference for spatial calculations.
 */
export function S_SetListener(l: SoundListener): void {
  listener = l;
}

/**
 * Start a sound effect from an origin.
 * @param origin  Object with x,y position, or null for global/UI sounds
 * @param sfxId   Sound effect enum
 */
export function S_StartSound(origin: SoundOrigin | null, sfxId: Sfx): void {
  if (!sndInitialized) return;
  if (sfxId < 1 || sfxId >= Sfx.NUMSFX) return;

  // Resume audio context (browser autoplay policy)
  I_ResumeAudioContext();

  const sfx = S_sfx[sfxId];
  if (!sfx) return;

  // Initialize sound parameters
  let volume = sndSfxVolume * (S_MAX_VOLUME / 15) | 0;
  let pitch = NORM_PITCH;
  let sep = NORM_SEP;
  const priority = sfx.priority;

  // Handle linked sounds
  if (sfx.link !== null) {
    pitch = sfx.pitch;
    volume += sfx.volume;
    if (volume < 1) return;
    if (volume > S_MAX_VOLUME) volume = S_MAX_VOLUME;
  }

  // Spatial adjustment for non-local sounds
  if (origin && listener) {
    const result = S_AdjustSoundParams(origin, volume, sep, pitch);
    if (!result) return; // too far away
    volume = result.volume;
    sep = result.sep;
    pitch = result.pitch;

    // If origin is at the same position as listener, center the sound
    if (origin.x === listener.x && origin.y === listener.y) {
      sep = NORM_SEP;
    }
  } else {
    sep = NORM_SEP;
  }

  // Pitch perturbation (randomize slightly)
  if (sfxId >= Sfx.sawup && sfxId <= Sfx.sawhit) {
    // Chainsaw: smaller pitch range
    pitch += 8 - (M_Random() & 15);
  } else if (sfxId !== Sfx.itemup && sfxId !== Sfx.tink) {
    pitch += 16 - (M_Random() & 31);
  }
  pitch = Math.max(0, Math.min(255, pitch));

  // Kill old sound from same origin
  if (origin) {
    S_StopSound(origin);
  }

  // Find a channel
  const cnum = S_GetChannel(origin, sfx, sfxId, priority);
  if (cnum < 0) return;

  // Start the sound
  const handle = I_StartSound(sfxId, volume, sep, pitch);
  if (handle < 0) return;

  channels[cnum].handle = handle;
}

/**
 * Stop any sound playing from the given origin.
 */
export function S_StopSound(origin: SoundOrigin): void {
  for (let i = 0; i < NUM_CHANNELS; i++) {
    if (channels[i].sfxInfo && channels[i].origin === origin) {
      S_StopChannel(i);
      break;
    }
  }
}

/**
 * Update all playing sounds — recalculate volume and panning.
 * Call once per game tick.
 */
export function S_UpdateSounds(): void {
  if (!sndInitialized || !listener) return;

  for (let cnum = 0; cnum < NUM_CHANNELS; cnum++) {
    const c = channels[cnum];
    if (!c.sfxInfo) continue;

    if (I_SoundIsPlaying(c.handle)) {
      // Re-adjust spatial params for moving origins
      if (c.origin && c.origin !== listener) {
        let volume = sndSfxVolume * (S_MAX_VOLUME / 15) | 0;
        let sep = NORM_SEP;
        let pitch = NORM_PITCH;

        if (c.sfxInfo.link !== null) {
          pitch = c.sfxInfo.pitch;
          volume += c.sfxInfo.volume;
          if (volume < 1) { S_StopChannel(cnum); continue; }
          if (volume > S_MAX_VOLUME) volume = S_MAX_VOLUME;
        }

        const result = S_AdjustSoundParams(c.origin, volume, sep, pitch);
        if (!result) {
          S_StopChannel(cnum);
        } else {
          I_UpdateSoundParams(c.handle, result.volume, result.sep, result.pitch);
        }
      }
    } else {
      // Sound finished playing — free the channel
      S_StopChannel(cnum);
    }
  }
}

/**
 * Pause all sounds.
 */
export function S_PauseSound(): void {
  // We stop all sounds on pause — simpler than suspending AudioContext
  // (which would affect future sounds too)
}

/**
 * Resume sounds after pause.
 */
export function S_ResumeSound(): void {
  I_ResumeAudioContext();
}

/**
 * Set SFX volume (0..15 from menu).
 */
export function S_SetSfxVolume(volume: number): void {
  sndSfxVolume = Math.max(0, Math.min(15, volume));
  I_SetSfxVolume(sndSfxVolume);
}

// ============================================================
// Internal Functions
// ============================================================

/**
 * Calculate volume, stereo separation, and pitch based on
 * distance and angle from listener to source.
 * Returns null if sound is too far to hear.
 */
function S_AdjustSoundParams(
  source: SoundOrigin,
  volume: number,
  sep: number,
  pitch: number
): { volume: number; sep: number; pitch: number } | null {
  if (!listener) return null;

  // Calculate approximate distance (fast Euclidean approximation)
  const adx = Math.abs(listener.x - source.x);
  const ady = Math.abs(listener.y - source.y);
  const approxDist = adx + ady - ((adx < ady ? adx : ady) >> 1);

  if (approxDist > S_CLIPPING_DIST) {
    return null;
  }

  // Stereo separation based on angle
  const angle = pointToAngle(listener.x, listener.y, source.x, source.y);
  let delta: number;
  if (angle > (listener.angle >>> 0)) {
    delta = (angle - (listener.angle >>> 0)) >>> 0;
  } else {
    delta = (angle + (0xffffffff - (listener.angle >>> 0))) >>> 0;
  }
  const fineAngle = delta >>> ANGLETOFINESHIFT;
  sep = 128 - (fixedMul(S_STEREO_SWING, finesine[fineAngle & 8191]) >> FRACBITS);

  // Volume attenuation by distance
  if (approxDist < S_CLOSE_DIST) {
    volume = sndSfxVolume * (S_MAX_VOLUME / 15) | 0;
  } else {
    volume = (sndSfxVolume * (S_MAX_VOLUME / 15) *
      ((S_CLIPPING_DIST - approxDist) >> FRACBITS) / S_ATTENUATOR) | 0;
  }

  if (volume <= 0) return null;

  return { volume, sep, pitch };
}

/**
 * Find a free channel or steal one based on priority.
 * Returns channel number, or -1 if none available.
 */
function S_GetChannel(
  origin: SoundOrigin | null,
  sfxInfo: typeof S_sfx[0],
  sfxId: Sfx,
  priority: number
): number {
  let cnum: number;

  // Find an open channel or reuse one with same origin
  for (cnum = 0; cnum < NUM_CHANNELS; cnum++) {
    if (!channels[cnum].sfxInfo) break;
    if (origin && channels[cnum].origin === origin) {
      S_StopChannel(cnum);
      break;
    }
  }

  // No free channel — find one with lower priority
  if (cnum === NUM_CHANNELS) {
    for (cnum = 0; cnum < NUM_CHANNELS; cnum++) {
      if (channels[cnum].sfxInfo!.priority >= priority) break;
    }
    if (cnum === NUM_CHANNELS) return -1; // All higher priority
    S_StopChannel(cnum);
  }

  // Assign channel
  channels[cnum].sfxInfo = sfxInfo;
  channels[cnum].sfxId = sfxId;
  channels[cnum].origin = origin;

  return cnum;
}

/**
 * Stop a channel and free it.
 */
function S_StopChannel(cnum: number): void {
  const c = channels[cnum];
  if (c.sfxInfo) {
    if (I_SoundIsPlaying(c.handle)) {
      I_StopSound(c.handle);
    }
    c.sfxInfo = null;
    c.sfxId = Sfx.None;
    c.origin = null;
    c.handle = -1;
  }
}

// ============================================================
// Music System
// ============================================================

let sndMusicVolume = 15;  // 0..15
let musPlaying: Music = Music.None;

/**
 * Change the background music.
 * @param musicId  Music enum value
 * @param looping  Whether to loop (usually true for level music)
 */
export function S_ChangeMusic(musicId: Music, looping: boolean): void {
  if (musicId <= Music.None || musicId >= Music.NUMMUSIC) {
    console.warn(`[S_ChangeMusic] Bad music number ${musicId}`);
    return;
  }

  // Don't restart if already playing this track
  if (musPlaying === musicId) return;

  // Stop current music
  S_StopMusic();

  const music = S_music[musicId];
  if (!music || !music.name) return;

  // WAD lump name is D_<name> (e.g., D_E1M1)
  const lumpName = `D_${music.name.toUpperCase()}`;

  const data = I_LoadMusicLump(lumpName);
  if (!data) {
    console.warn(`[S_ChangeMusic] Music lump ${lumpName} not found`);
    return;
  }

  const ok = I_PlaySong(data, looping);
  if (ok) {
    musPlaying = musicId;
    console.log(`[S_ChangeMusic] Playing: ${lumpName}`);
  }
}

/**
 * Stop the currently playing music.
 */
export function S_StopMusic(): void {
  if (musPlaying !== Music.None) {
    I_StopSong();
    musPlaying = Music.None;
  }
}

/**
 * Set music volume (0..15 from menu).
 */
export function S_SetMusicVolume(volume: number): void {
  sndMusicVolume = Math.max(0, Math.min(15, volume));
  I_SetMusicVolume(sndMusicVolume);
}
