// ============================================================
// Low-Level Music Playback Backend
// Handles format detection (MUS vs MIDI) and MIDI playback
// via webaudio-tinysynth
// ============================================================

// @ts-ignore — no type declarations for webaudio-tinysynth
import WebAudioTinySynth from 'webaudio-tinysynth';
import type { WAD } from '../wad';
import { musToMidi } from './mus2midi';



/** Music format detected from lump data */
export enum MusicFormat {
  Unknown = 0,
  MUS,
  MIDI,
}

// ---- Module state ----
let synth: any = null;
let wadRef: WAD | null = null;
let musicInitialized = false;
let currentVolume = 0.5;

// ============================================================
// Public API
// ============================================================

/**
 * Initialize the music system.
 * Creates the webaudio-tinysynth instance.
 */
export function I_InitMusic(wad: WAD): void {
  wadRef = wad;

  try {
    synth = new WebAudioTinySynth({ quality: 1, useReverb: 1 });
    synth.setMasterVol(currentVolume);
    musicInitialized = true;
    console.log('[I_InitMusic] webaudio-tinysynth initialized');
  } catch (e) {
    console.warn('[I_InitMusic] Failed to initialize synth:', e);
    musicInitialized = false;
  }
}

/**
 * Detect the format of a music lump from its first 4 bytes.
 */
export function detectMusicFormat(data: Uint8Array): MusicFormat {
  if (data.byteLength < 4) return MusicFormat.Unknown;

  // Check for MUS format: "MUS\x1A" (bytes: 4D 55 53 1A)
  if (data[0] === 0x4D && data[1] === 0x55 && data[2] === 0x53 && data[3] === 0x1A) {
    return MusicFormat.MUS;
  }

  // Check for MIDI format: "MThd" (bytes: 4D 54 68 64)
  if (data[0] === 0x4D && data[1] === 0x54 && data[2] === 0x68 && data[3] === 0x64) {
    return MusicFormat.MIDI;
  }

  return MusicFormat.Unknown;
}

/**
 * Load music data from a WAD lump name.
 * Returns the raw Uint8Array, or null if not found.
 */
export function I_LoadMusicLump(lumpName: string): Uint8Array | null {
  if (!wadRef) return null;

  try {
    const data = wadRef.getLumpByName(lumpName);
    return data;
  } catch (e) {
    console.warn(`[I_LoadMusicLump] Lump "${lumpName}" not found`);
    return null;
  }
}

/**
 * Play a MIDI song from raw Uint8Array data.
 * Detects format: if MUS, logs and skips. If MIDI, loads and plays.
 * @param data  Raw lump data
 * @param looping  Whether to loop the song
 * @returns true if playback started
 */
export function I_PlaySong(data: Uint8Array, looping: boolean): boolean {
  if (!musicInitialized || !synth) {
    console.warn('[I_PlaySong] Music not initialized');
    return false;
  }

  const format = detectMusicFormat(data);

  switch (format) {
    case MusicFormat.MUS: {
      console.log('[I_PlaySong] MUS format detected — converting to MIDI');
      const midiData = musToMidi(data);
      if (!midiData) {
        console.warn('[I_PlaySong] MUS→MIDI conversion failed');
        return false;
      }
      try {
        synth.loop = looping ? 1 : 0;
        synth.loadMIDI(midiData.buffer.slice(midiData.byteOffset, midiData.byteOffset + midiData.byteLength));
        synth.playMIDI();
        console.log(`[I_PlaySong] MUS→MIDI: ${data.byteLength}b → ${midiData.byteLength}b`);
        return true;
      } catch (e) {
        console.warn('[I_PlaySong] Failed to play converted MIDI:', e);
        return false;
      }
    }

    case MusicFormat.MIDI:
      console.log('[I_PlaySong] MIDI format detected — loading and playing');
      try {
        synth.loop = looping ? 1 : 0;
        // webaudio-tinysynth expects an ArrayBuffer
        synth.loadMIDI(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        synth.playMIDI();
        return true;
      } catch (e) {
        console.warn('[I_PlaySong] Failed to play MIDI:', e);
        return false;
      }

    default:
      console.warn('[I_PlaySong] Unknown music format — skipping');
      return false;
  }
}

/**
 * Stop the currently playing song.
 */
export function I_StopSong(): void {
  if (!musicInitialized || !synth) return;

  try {
    synth.stopMIDI();
  } catch (e) {
    // ignore
  }
}

/**
 * Pause the currently playing song.
 */
export function I_PauseSong(): void {
  if (!musicInitialized || !synth) return;
  // webaudio-tinysynth doesn't have a native pause — we stop and track position
  // For simplicity, just stop (DOOM's original approach when pausing)
  I_StopSong();
}

/**
 * Resume a paused song.
 */
export function I_ResumeSong(): void {
  if (!musicInitialized || !synth) return;
  try {
    synth.playMIDI();
  } catch (e) {
    // ignore
  }
}

/**
 * Set music volume (0..15 from DOOM menu, converted to 0.0..1.0).
 */
export function I_SetMusicVolume(volume: number): void {
  currentVolume = Math.max(0, Math.min(1, volume / 15));
  if (musicInitialized && synth) {
    synth.setMasterVol(currentVolume);
  }
}
