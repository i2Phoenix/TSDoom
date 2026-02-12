// ============================================================
// Low-Level Sound Interface — Web Audio API Backend
// TypeScript port of i_sound.c
// Handles WAD lump decoding, AudioContext, and playback
// ============================================================

import type { WAD } from '../wad';
import { S_sfx, Sfx } from '../../game/sounds';

// ---- Constants ----
const NUM_CHANNELS = 8;
const DOOM_SAMPLERATE = 11025;

// ---- Types ----
interface SoundHandle {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode;
  id: number;
}

// ---- Module state ----
let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;

/** Decoded AudioBuffers indexed by Sfx enum */
const sfxBuffers: (AudioBuffer | null)[] = [];

/** Active playback handles indexed by channel */
const channels: (SoundHandle | null)[] = new Array(NUM_CHANNELS).fill(null);

/** Monotonically increasing handle counter */
let nextHandle = 1;

// ============================================================
// Initialization
// ============================================================

/**
 * Create AudioContext and decode all DS* lumps from the WAD.
 * Must be called after a user gesture (click) to satisfy browser autoplay policy.
 */
export function I_InitSound(wad: WAD): void {
  if (audioCtx) return; // already initialized

  audioCtx = new AudioContext({ sampleRate: 44100 });
  masterGain = audioCtx.createGain();
  masterGain.connect(audioCtx.destination);

  // Pre-load all SFX from WAD
  for (let i = 1; i < Sfx.NUMSFX; i++) {
    const info = S_sfx[i];
    if (!info) continue;

    // Linked sounds (e.g. chaingun → pistol) share the same buffer
    if (info.link !== null) {
      continue; // will resolve after all non-linked sounds are loaded
    }

    const lumpName = `DS${info.name.toUpperCase()}`;
    const lumpIdx = wad.checkNumForName(lumpName);
    if (lumpIdx === -1) {
      // Sound not found in WAD (might be Doom II only)
      sfxBuffers[i] = null;
      continue;
    }

    const data = wad.getLumpData(lumpIdx);
    sfxBuffers[i] = decodeDoomSound(data);
  }

  // Resolve linked sounds
  for (let i = 1; i < Sfx.NUMSFX; i++) {
    const info = S_sfx[i];
    if (info && info.link !== null) {
      sfxBuffers[i] = sfxBuffers[info.link] || null;
    }
  }

  console.log(`I_InitSound: loaded ${sfxBuffers.filter(b => b !== null).length} sound effects`);
}

/**
 * Ensure AudioContext is running (must be called from user gesture).
 */
export function I_ResumeAudioContext(): void {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// ============================================================
// WAD Sound Lump Decoding
// ============================================================

/**
 * Decode a DOOM sound lump (raw unsigned 8-bit PCM with 8-byte header)
 * Header format:
 *   [0-1] format identifier (3 = PCM)
 *   [2-3] sample rate (usually 11025)
 *   [4-7] number of samples
 *   [8+]  unsigned 8-bit PCM data
 */
function decodeDoomSound(data: Uint8Array): AudioBuffer | null {
  if (!audioCtx || data.length < 8) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sampleRate = view.getUint16(2, true);
  const numSamples = view.getUint32(4, true);

  if (numSamples === 0 || data.length < 8 + numSamples) return null;

  // Create AudioBuffer at the sound's native sample rate
  // Web Audio will handle resampling
  const rate = sampleRate || DOOM_SAMPLERATE;
  const buffer = audioCtx.createBuffer(1, numSamples, rate);
  const channel = buffer.getChannelData(0);

  // Convert unsigned 8-bit [0..255] to float [-1..1]
  for (let i = 0; i < numSamples; i++) {
    channel[i] = (data[8 + i] - 128) / 128;
  }

  return buffer;
}

// ============================================================
// Playback API
// ============================================================

/**
 * Start playing a sound effect.
 * @param sfxId  SFX enum value
 * @param volume 0..127
 * @param sep    stereo separation: 0=full left, 128=center, 255=full right
 * @param pitch  pitch: 128=normal, <128=lower, >128=higher (unused for now)
 * @returns handle ID, or -1 if failed
 */
export function I_StartSound(
  sfxId: number,
  volume: number,
  sep: number,
  pitch: number
): number {
  if (!audioCtx || !masterGain) return -1;

  const buffer = sfxBuffers[sfxId];
  if (!buffer) return -1;

  // Find a free channel or the oldest one
  let slot = -1;
  for (let i = 0; i < NUM_CHANNELS; i++) {
    if (!channels[i]) {
      slot = i;
      break;
    }
  }

  if (slot === -1) {
    // All channels busy — overwrite channel 0 (oldest convention)
    slot = 0;
    I_StopChannel(0);
  }

  // Create audio nodes
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;

  // Pitch: DOOM pitch 128 = normal, we convert to playbackRate
  // playbackRate = 2^((pitch - 128) / 64)
  if (pitch !== 128) {
    source.playbackRate.value = Math.pow(2, (pitch - 128) / 64);
  }

  const gain = audioCtx.createGain();
  // Volume: 0..127 → 0..1
  gain.gain.value = Math.max(0, Math.min(1, volume / 127));

  const panner = audioCtx.createStereoPanner();
  // Separation: 0=full left(-1), 128=center(0), 255=full right(+1)
  panner.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128));

  // Connect chain: source → gain → panner → master
  source.connect(gain);
  gain.connect(panner);
  panner.connect(masterGain!);

  const handle: SoundHandle = {
    source,
    gain,
    panner,
    id: nextHandle++,
  };

  // Clean up when sound finishes
  source.onended = () => {
    if (channels[slot] && channels[slot]!.id === handle.id) {
      channels[slot] = null;
    }
  };

  source.start();
  channels[slot] = handle;

  return handle.id;
}

/**
 * Stop a sound by handle ID.
 */
export function I_StopSound(handle: number): void {
  for (let i = 0; i < NUM_CHANNELS; i++) {
    if (channels[i] && channels[i]!.id === handle) {
      I_StopChannel(i);
      return;
    }
  }
}

/**
 * Check if a sound handle is still playing.
 */
export function I_SoundIsPlaying(handle: number): boolean {
  for (let i = 0; i < NUM_CHANNELS; i++) {
    if (channels[i] && channels[i]!.id === handle) {
      return true;
    }
  }
  return false;
}

/**
 * Update volume and panning for a playing sound.
 */
export function I_UpdateSoundParams(
  handle: number,
  volume: number,
  sep: number,
  _pitch: number
): void {
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const ch = channels[i];
    if (ch && ch.id === handle) {
      ch.gain.gain.value = Math.max(0, Math.min(1, volume / 127));
      ch.panner.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128));
      return;
    }
  }
}

/**
 * Stop all playing sounds (used on level change).
 */
export function I_StopAllSounds(): void {
  for (let i = 0; i < NUM_CHANNELS; i++) {
    I_StopChannel(i);
  }
}

/**
 * Set master SFX volume (0..15, mapped from menu).
 */
export function I_SetSfxVolume(volume: number): void {
  if (masterGain) {
    masterGain.gain.value = Math.max(0, Math.min(1, volume / 15));
  }
}

// ---- Internal ----

function I_StopChannel(cnum: number): void {
  const ch = channels[cnum];
  if (ch) {
    try {
      ch.source.stop();
    } catch (_e) {
      // Already stopped
    }
    ch.source.disconnect();
    ch.gain.disconnect();
    ch.panner.disconnect();
    channels[cnum] = null;
  }
}
