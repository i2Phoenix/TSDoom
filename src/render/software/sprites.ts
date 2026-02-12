// ============================================================
// Sprite Loader & Frame Lookup
// Reference: r_things.c, info.c — sprite definitions
// ============================================================

import { WAD } from '../../wad';
import { TextureData, Patch } from '../../textures';

/** A single sprite frame — one rotation */
export interface SpriteFrame {
  /** Patches for 8 rotations (0-7). If rotation=0, all slots hold the same patch */
  patches: (Patch | null)[];
  /** Whether each rotation is flipped horizontally */
  flip: boolean[];
}

/** A sprite definition: all frames for one 4-char name */
export interface SpriteDef {
  name: string;
  frames: SpriteFrame[];
}

/** Thing type → sprite name + default state mapping (DOOM1) */
export const THING_INFO: Record<number, { sprite: string; frame: number; radius: number; height: number }> = {
  // Monsters
  3004: { sprite: 'POSS', frame: 0, radius: 20, height: 56 },  // Zombieman
  9:    { sprite: 'SPOS', frame: 0, radius: 20, height: 56 },   // Shotgun Guy
  3001: { sprite: 'TROO', frame: 0, radius: 20, height: 56 },   // Imp
  3002: { sprite: 'SARG', frame: 0, radius: 30, height: 56 },   // Demon
  58:   { sprite: 'SARG', frame: 0, radius: 30, height: 56 },   // Spectre
  3006: { sprite: 'SKUL', frame: 0, radius: 16, height: 56 },   // Lost Soul
  3005: { sprite: 'HEAD', frame: 0, radius: 31, height: 56 },   // Cacodemon
  69:   { sprite: 'BOS2', frame: 0, radius: 24, height: 64 },   // Hell Knight
  3003: { sprite: 'BOSS', frame: 0, radius: 24, height: 64 },   // Baron of Hell
  16:   { sprite: 'CYBR', frame: 0, radius: 40, height: 110 },  // Cyberdemon
  7:    { sprite: 'SPID', frame: 0, radius: 128, height: 100 }, // Spider Mastermind

  // Decorations
  2035: { sprite: 'BAR1', frame: 0, radius: 10, height: 42 },   // Barrel
  2028: { sprite: 'COLU', frame: 0, radius: 16, height: 48 },   // Column
  34:   { sprite: 'CAND', frame: 0, radius: 20, height: 16 },   // Candle
  35:   { sprite: 'CBRA', frame: 0, radius: 16, height: 16 },   // Candelabra
  44:   { sprite: 'TBLU', frame: 0, radius: 16, height: 16 },   // Tall blue torch
  45:   { sprite: 'TGRN', frame: 0, radius: 16, height: 16 },   // Tall green torch
  46:   { sprite: 'TRED', frame: 0, radius: 16, height: 16 },   // Tall red torch
  55:   { sprite: 'SMBT', frame: 0, radius: 16, height: 16 },   // Short blue torch
  56:   { sprite: 'SMGT', frame: 0, radius: 16, height: 16 },   // Short green torch
  57:   { sprite: 'SMRT', frame: 0, radius: 16, height: 16 },   // Short red torch
  48:   { sprite: 'ELEC', frame: 0, radius: 16, height: 16 },   // Tech column
  30:   { sprite: 'COL1', frame: 0, radius: 16, height: 16 },   // Tall green pillar
  32:   { sprite: 'COL3', frame: 0, radius: 16, height: 16 },   // Tall red pillar
  31:   { sprite: 'COL2', frame: 0, radius: 16, height: 16 },   // Short green pillar
  36:   { sprite: 'COL5', frame: 0, radius: 16, height: 16 },   // Short green pillar + heart
  33:   { sprite: 'COL4', frame: 0, radius: 16, height: 16 },   // Short red pillar
  37:   { sprite: 'COL6', frame: 0, radius: 16, height: 16 },   // Short red pillar + skull
  47:   { sprite: 'SMIT', frame: 0, radius: 16, height: 16 },   // Stalagmite
  43:   { sprite: 'TRE1', frame: 0, radius: 16, height: 16 },   // Grey tree
  54:   { sprite: 'TRE2', frame: 0, radius: 32, height: 16 },   // Brown tree
  2018: { sprite: 'ARM1', frame: 0, radius: 20, height: 16 },   // Green armor
  2019: { sprite: 'ARM2', frame: 0, radius: 20, height: 16 },   // Blue armor

  // Corpses / gore
  10:   { sprite: 'PLAY', frame: 22, radius: 20, height: 16 },  // Bloody mess (S_PLAY_XDIE9)
  12:   { sprite: 'PLAY', frame: 22, radius: 20, height: 16 },  // Bloody mess 2 (S_PLAY_XDIE9)
  15:   { sprite: 'PLAY', frame: 13, radius: 20, height: 16 },  // Dead player (S_PLAY_DIE7)
  18:   { sprite: 'POSS', frame: 11, radius: 20, height: 16 },  // Dead former human (S_POSS_DIE5)
  19:   { sprite: 'SPOS', frame: 11, radius: 20, height: 16 },  // Dead sergeant (S_SPOS_DIE5)
  20:   { sprite: 'TROO', frame: 12, radius: 20, height: 16 },  // Dead imp
  21:   { sprite: 'SARG', frame: 13, radius: 20, height: 16 },  // Dead demon
  22:   { sprite: 'HEAD', frame: 11, radius: 20, height: 16 },  // Dead cacodemon
  23:   { sprite: 'SKUL', frame: 10, radius: 20, height: 16 },  // Dead lost soul
  24:   { sprite: 'POL5', frame: 0, radius: 16, height: 16 },   // Pool of blood
  79:   { sprite: 'POB1', frame: 0, radius: 16, height: 16 },   // Pool of blood 2
  80:   { sprite: 'POB2', frame: 0, radius: 16, height: 16 },   // Pool of blood 3
  81:   { sprite: 'BRS1', frame: 0, radius: 16, height: 16 },   // Brain stem
  25:   { sprite: 'POL1', frame: 0, radius: 16, height: 16 },   // Impaled
  26:   { sprite: 'POL6', frame: 0, radius: 16, height: 16 },   // Twitching impaled
  27:   { sprite: 'POL4', frame: 0, radius: 16, height: 16 },   // Skull on pole
  28:   { sprite: 'POL2', frame: 0, radius: 16, height: 16 },   // Skewered heads
  29:   { sprite: 'POL3', frame: 0, radius: 16, height: 16 },   // Head-ka-bob
  49:   { sprite: 'GOR1', frame: 0, radius: 16, height: 68 },   // Hanging victim twitching
  50:   { sprite: 'GOR2', frame: 0, radius: 16, height: 84 },   // Hanging victim arms out
  51:   { sprite: 'GOR3', frame: 0, radius: 16, height: 84 },   // Hanging victim onelugged
  52:   { sprite: 'GOR4', frame: 0, radius: 16, height: 68 },   // Hanging torso
  53:   { sprite: 'GOR5', frame: 0, radius: 16, height: 52 },   // Hanging leg

  // Keys
  13:   { sprite: 'RKEY', frame: 0, radius: 20, height: 16 },   // Red keycard
  6:    { sprite: 'BKEY', frame: 0, radius: 20, height: 16 },   // Blue keycard
  5:    { sprite: 'YKEY', frame: 0, radius: 20, height: 16 },   // Yellow keycard
  38:   { sprite: 'RSKU', frame: 0, radius: 20, height: 16 },   // Red skull key
  39:   { sprite: 'BSKU', frame: 0, radius: 20, height: 16 },   // Blue skull key
  40:   { sprite: 'YSKU', frame: 0, radius: 20, height: 16 },   // Yellow skull key

  // Pickups
  2011: { sprite: 'STIM', frame: 0, radius: 20, height: 16 },   // Stimpack
  2012: { sprite: 'MEDI', frame: 0, radius: 20, height: 16 },   // Medikit
  2014: { sprite: 'BON1', frame: 0, radius: 20, height: 16 },   // Health bonus
  2015: { sprite: 'BON2', frame: 0, radius: 20, height: 16 },   // Armor bonus
  2013: { sprite: 'SOUL', frame: 0, radius: 20, height: 16 },   // Soulsphere
  2022: { sprite: 'PINV', frame: 0, radius: 20, height: 16 },   // Invulnerability
  2023: { sprite: 'PSTR', frame: 0, radius: 20, height: 16 },   // Berserk
  2024: { sprite: 'PINS', frame: 0, radius: 20, height: 16 },   // Partial invisibility
  2025: { sprite: 'SUIT', frame: 0, radius: 20, height: 16 },   // Radiation suit
  2026: { sprite: 'PMAP', frame: 0, radius: 20, height: 16 },   // Computer map
  2045: { sprite: 'PVIS', frame: 0, radius: 20, height: 16 },   // Light amp goggles

  // Ammo
  2007: { sprite: 'CLIP', frame: 0, radius: 20, height: 16 },   // Clip
  2048: { sprite: 'AMMO', frame: 0, radius: 20, height: 16 },   // Box of bullets
  2008: { sprite: 'SHEL', frame: 0, radius: 20, height: 16 },   // Shells
  2049: { sprite: 'SBOX', frame: 0, radius: 20, height: 16 },   // Box of shells
  2010: { sprite: 'ROCK', frame: 0, radius: 20, height: 16 },   // Rocket
  2046: { sprite: 'BROK', frame: 0, radius: 20, height: 16 },   // Box of rockets
  2047: { sprite: 'CELL', frame: 0, radius: 20, height: 16 },   // Cell charge
  17:   { sprite: 'CELP', frame: 0, radius: 20, height: 16 },   // Cell charge pack
  8:    { sprite: 'BPAK', frame: 0, radius: 20, height: 16 },   // Backpack

  // Weapons on ground
  2001: { sprite: 'SHOT', frame: 0, radius: 20, height: 16 },   // Shotgun
  82:   { sprite: 'SGN2', frame: 0, radius: 20, height: 16 },   // Super shotgun
  2002: { sprite: 'MGUN', frame: 0, radius: 20, height: 16 },   // Chaingun
  2003: { sprite: 'LAUN', frame: 0, radius: 20, height: 16 },   // Rocket launcher
  2004: { sprite: 'PLAS', frame: 0, radius: 20, height: 16 },   // Plasma rifle
  2006: { sprite: 'BFUG', frame: 0, radius: 20, height: 16 },   // BFG9000
  2005: { sprite: 'CSAW', frame: 0, radius: 20, height: 16 },   // Chainsaw
};

/** Sprite data manager */
export class SpriteData {
  /** Map of 4-char sprite names to sprite defs */
  private spriteDefs: Map<string, SpriteDef> = new Map();
  /** Map of lump name to Patch */
  private patchCache: Map<string, Patch> = new Map();

  constructor(private wad: WAD, private texData: TextureData) {
    this.loadSprites();
  }

  private loadSprites(): void {
    // Find S_START/S_END markers
    let sStart = this.wad.checkNumForName('S_START');
    if (sStart === -1) sStart = this.wad.checkNumForName('SS_START');
    let sEnd = this.wad.checkNumForName('S_END');
    if (sEnd === -1) sEnd = this.wad.checkNumForName('SS_END');

    if (sStart === -1 || sEnd === -1) {
      console.warn('No sprite markers found in WAD');
      return;
    }

    // Parse each sprite lump into frames
    // Lump names: XXXXFR[FR] where XXXX=sprite, F=frame(A-Z), R=rotation(0-8)
    // Optional second FR pair means the same patch is used for mirrored rotation
    for (let i = sStart + 1; i < sEnd; i++) {
      const lump = this.wad.lumps[i];
      if (lump.size === 0) continue; // marker

      const name = lump.name;
      if (name.length < 6) continue;

      const spriteName = name.substring(0, 4);
      const frame1 = name.charCodeAt(4) - 65; // A=0, B=1, ...
      const rot1 = parseInt(name[5]);

      // Parse the patch and cache it
      let patch = this.patchCache.get(name);
      if (!patch) {
        try {
          patch = this.texData.parsePatchLump(i);
          this.patchCache.set(name, patch);
        } catch {
          continue;
        }
      }

      this.addSpriteFrame(spriteName, frame1, rot1, patch, false);

      // Check for mirrored frame (e.g., TROOAB = frame A rot B + frame B rot A mirrored... 
      // Actually: TROOA2A8 means frame A rotation 2, and frame A rotation 8 mirrored)
      if (name.length >= 8) {
        const frame2 = name.charCodeAt(6) - 65;
        const rot2 = parseInt(name[7]);
        this.addSpriteFrame(spriteName, frame2, rot2, patch, true);
      }
    }

    console.log(`Sprites: ${this.spriteDefs.size} sprite types loaded`);
  }

  private addSpriteFrame(spriteName: string, frame: number, rotation: number, patch: Patch, flip: boolean): void {
    let def = this.spriteDefs.get(spriteName);
    if (!def) {
      def = { name: spriteName, frames: [] };
      this.spriteDefs.set(spriteName, def);
    }

    // Ensure frames array is big enough
    while (def.frames.length <= frame) {
      def.frames.push({
        patches: new Array(8).fill(null),
        flip: new Array(8).fill(false),
      });
    }

    const sf = def.frames[frame];
    if (rotation === 0) {
      // Rotation 0 means the same patch for all angles
      for (let r = 0; r < 8; r++) {
        sf.patches[r] = patch;
        sf.flip[r] = flip;
      }
    } else {
      // Rotation 1-8 maps to index 0-7
      const idx = rotation - 1;
      sf.patches[idx] = patch;
      sf.flip[idx] = flip;
    }
  }

  /** Get a sprite patch for a given sprite name, frame, and angle relative to viewer */
  getSpriteFrame(spriteName: string, frame: number, viewAngle: number): { patch: Patch; flip: boolean } | null {
    const def = this.spriteDefs.get(spriteName);
    if (!def || frame >= def.frames.length) return null;

    const sf = def.frames[frame];
    // Convert angle to rotation index (0-7). DOOM uses 8 rotations.
    // Rotation 0 = facing viewer, going clockwise
    const rot = Math.floor(((viewAngle + (Math.PI / 8)) % (Math.PI * 2)) / (Math.PI / 4)) & 7;
    
    const patch = sf.patches[rot];
    if (!patch) {
      // Fall back to rotation 0 if available
      return sf.patches[0] ? { patch: sf.patches[0], flip: sf.flip[0] } : null;
    }
    return { patch, flip: sf.flip[rot] };
  }

  /** Check if a sprite exists */
  hasSprite(name: string): boolean {
    return this.spriteDefs.has(name);
  }
}
