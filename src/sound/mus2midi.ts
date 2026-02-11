// ============================================================
// MUS-to-MIDI Converter
// Converts DOOM MUS format to standard MIDI Type 0
// Based on the mus2mid algorithm from Chocolate Doom / PrBoom
// ============================================================

// ── MUS header structure ────────────────────────────────────
// Offset  Size  Description
//   0      4    Magic "MUS\x1A"
//   4      2    Score length (bytes)
//   6      2    Score start offset
//   8      2    Number of primary channels
//  10      2    Number of secondary channels
//  12      2    Number of instruments
//  14      2    Padding / dummy
//  16      2*N  Instrument list (N = instrCnt)

// ── MUS event types ─────────────────────────────────────────
const MUS_RELEASE_NOTE = 0;
const MUS_PLAY_NOTE    = 1;
const MUS_PITCH_BEND   = 2;
const MUS_SYS_EVENT    = 3;
const MUS_CONTROLLER   = 4;
const MUS_END          = 6;

// ── MUS controller → MIDI CC mapping ────────────────────────
const MUS_TO_MIDI_CTRL: number[] = [
  // MUS ctrl 0 is special (= program change, handled separately)
   0,   // 0 → (program change placeholder, not used as CC)
   0,   // 1 → Bank Select (CC 0)
   1,   // 2 → Modulation (CC 1)
   7,   // 3 → Volume (CC 7)
  10,   // 4 → Pan (CC 10)
  11,   // 5 → Expression (CC 11)
  91,   // 6 → Reverb depth (CC 91)
  93,   // 7 → Chorus depth (CC 93)
  64,   // 8 → Sustain pedal (CC 64)
  67,   // 9 → Soft pedal (CC 67)
];

// ── MIDI constants ──────────────────────────────────────────
const MIDI_MAX_CHANNELS = 16;
const MIDI_PERCUSSION_CHAN = 9;

// MUS channel 15 = percussion → maps to MIDI channel 9
// Other MUS channels map to MIDI channels dynamically (skipping 9)

/**
 * Convert MUS format data to standard MIDI Type 0.
 * @param musData  Raw MUS lump bytes
 * @returns  MIDI file as Uint8Array, or null on error
 */
export function musToMidi(musData: Uint8Array): Uint8Array | null {
  if (musData.length < 16) return null;

  // Verify magic
  if (musData[0] !== 0x4D || musData[1] !== 0x55 ||
      musData[2] !== 0x53 || musData[3] !== 0x1A) {
    return null;
  }

  const view = new DataView(musData.buffer, musData.byteOffset, musData.byteLength);
  const scoreLen   = view.getUint16(4, true);
  const scoreStart = view.getUint16(6, true);

  if (scoreStart >= musData.length) return null;

  // ── Channel mapping ─────────────────────────────────────
  // MUS has 16 logical channels; channel 15 → MIDI 9 (percussion)
  // Other channels get assigned to MIDI channels 0-15 (skipping 9)
  const channelMap = new Int8Array(16).fill(-1);
  channelMap[15] = MIDI_PERCUSSION_CHAN;  // percussion always maps to 9
  let nextMidiChan = 0;

  function getMidiChannel(musChan: number): number {
    if (channelMap[musChan] >= 0) return channelMap[musChan];
    // Assign next available MIDI channel (skip percussion channel 9)
    if (nextMidiChan === MIDI_PERCUSSION_CHAN) nextMidiChan++;
    if (nextMidiChan >= MIDI_MAX_CHANNELS) nextMidiChan = 0; // wrap (shouldn't happen)
    channelMap[musChan] = nextMidiChan;
    return nextMidiChan++;
  }

  // ── Track per-channel volume for note events ────────────
  const channelVolumes = new Uint8Array(16).fill(127);

  // ── Collect MIDI events ─────────────────────────────────
  // Each event: { delta: number, bytes: number[] }
  interface MidiEvent {
    delta: number;
    bytes: number[];
  }
  const events: MidiEvent[] = [];

  let pos = scoreStart;
  let delta = 0;
  let done = false;

  while (pos < musData.length && !done) {
    const eventByte = musData[pos++];
    const lastFlag  = (eventByte & 0x80) !== 0;
    const eventType = (eventByte >> 4) & 0x07;
    const musChan   = eventByte & 0x0F;
    const midiChan  = getMidiChannel(musChan);

    switch (eventType) {
      case MUS_RELEASE_NOTE: {
        if (pos >= musData.length) { done = true; break; }
        const note = musData[pos++] & 0x7F;
        events.push({ delta, bytes: [0x80 | midiChan, note, 0] });
        delta = 0;
        break;
      }

      case MUS_PLAY_NOTE: {
        if (pos >= musData.length) { done = true; break; }
        const noteData = musData[pos++];
        const note = noteData & 0x7F;
        const hasVol = (noteData & 0x80) !== 0;
        let vol = channelVolumes[musChan];
        if (hasVol) {
          if (pos >= musData.length) { done = true; break; }
          vol = musData[pos++] & 0x7F;
          channelVolumes[musChan] = vol;
        }
        events.push({ delta, bytes: [0x90 | midiChan, note, vol] });
        delta = 0;
        break;
      }

      case MUS_PITCH_BEND: {
        if (pos >= musData.length) { done = true; break; }
        const bend = musData[pos++];
        // MUS bend is 0-255 (128 = center), convert to MIDI 14-bit pitch bend
        // MIDI pitch bend: 0x2000 = center, range 0x0000 - 0x3FFF
        const midiBend = bend << 6;  // scale 0-255 → 0-16320
        const bendLSB = midiBend & 0x7F;
        const bendMSB = (midiBend >> 7) & 0x7F;
        events.push({ delta, bytes: [0xE0 | midiChan, bendLSB, bendMSB] });
        delta = 0;
        break;
      }

      case MUS_SYS_EVENT: {
        if (pos >= musData.length) { done = true; break; }
        const ctrl = musData[pos++] & 0x7F;
        // System events map to MIDI CCs with value 0
        switch (ctrl) {
          case 10: // All sounds off
            events.push({ delta, bytes: [0xB0 | midiChan, 120, 0] });
            break;
          case 11: // All notes off
            events.push({ delta, bytes: [0xB0 | midiChan, 123, 0] });
            break;
          case 14: // Reset all controllers
            events.push({ delta, bytes: [0xB0 | midiChan, 121, 0] });
            break;
          // 12 (mono) and 13 (poly) are rarely used, ignore
        }
        delta = 0;
        break;
      }

      case MUS_CONTROLLER: {
        if (pos + 1 >= musData.length) { done = true; break; }
        const ctrl  = musData[pos++] & 0x7F;
        const value = musData[pos++] & 0x7F;

        if (ctrl === 0) {
          // MUS ctrl 0 = program change
          events.push({ delta, bytes: [0xC0 | midiChan, value] });
        } else if (ctrl < MUS_TO_MIDI_CTRL.length) {
          // Map MUS ctrl to MIDI CC
          events.push({ delta, bytes: [0xB0 | midiChan, MUS_TO_MIDI_CTRL[ctrl], value] });
        }
        delta = 0;
        break;
      }

      case MUS_END:
      case 5: // Some MUS files use type 5 for end too
        done = true;
        break;

      default:
        // Unknown event — skip
        break;
    }

    // If last flag set, read variable-length delay
    if (lastFlag && !done) {
      let delayVal = 0;
      let b: number;
      do {
        if (pos >= musData.length) { done = true; break; }
        b = musData[pos++];
        delayVal = (delayVal << 7) | (b & 0x7F);
      } while ((b & 0x80) !== 0);
      delta += delayVal;
    }
  }

  // ── Build MIDI file ───────────────────────────────────────
  // Standard MIDI File Type 0 (single track)

  // Add end-of-track meta event
  events.push({ delta: 0, bytes: [0xFF, 0x2F, 0x00] });

  // Calculate track data size
  let trackDataSize = 0;
  for (const ev of events) {
    trackDataSize += varLenSize(ev.delta) + ev.bytes.length;
  }

  // MIDI header (14 bytes) + track header (8 bytes) + track data
  const midiSize = 14 + 8 + trackDataSize;
  const midi = new Uint8Array(midiSize);
  const out = new DataView(midi.buffer);
  let wp = 0;

  // ── MIDI header chunk ("MThd") ────────────────────────────
  // "MThd"
  midi[wp++] = 0x4D; midi[wp++] = 0x54;
  midi[wp++] = 0x68; midi[wp++] = 0x64;
  // Chunk length = 6
  out.setUint32(wp, 6); wp += 4;
  // Format = 0 (single track)
  out.setUint16(wp, 0); wp += 2;
  // Number of tracks = 1
  out.setUint16(wp, 1); wp += 2;
  // Division = 70 ticks per quarter note (MUS uses 140Hz ticks,
  // with tempo 500000 μs/beat → 120 BPM. 140 ticks/sec ÷ 2 beats/sec = 70 ticks/beat)
  out.setUint16(wp, 70); wp += 2;

  // ── MIDI track chunk ("MTrk") ─────────────────────────────
  // "MTrk"
  midi[wp++] = 0x4D; midi[wp++] = 0x54;
  midi[wp++] = 0x72; midi[wp++] = 0x6B;
  // Track length
  out.setUint32(wp, trackDataSize); wp += 4;

  // ── Write events ──────────────────────────────────────────
  for (const ev of events) {
    wp = writeVarLen(midi, wp, ev.delta);
    for (const b of ev.bytes) {
      midi[wp++] = b;
    }
  }

  return midi;
}

// ── Variable-length quantity encoding ───────────────────────

/** Calculate the byte size of a variable-length encoded value */
function varLenSize(value: number): number {
  if (value < 0x80) return 1;
  if (value < 0x4000) return 2;
  if (value < 0x200000) return 3;
  return 4;
}

/** Write a variable-length quantity to buffer, return new write position */
function writeVarLen(buf: Uint8Array, pos: number, value: number): number {
  // Encode from MSB to LSB
  const bytes: number[] = [];
  bytes.push(value & 0x7F);
  value >>= 7;
  while (value > 0) {
    bytes.push((value & 0x7F) | 0x80);
    value >>= 7;
  }
  // Write in reverse order (MSB first)
  for (let i = bytes.length - 1; i >= 0; i--) {
    buf[pos++] = bytes[i];
  }
  return pos;
}
