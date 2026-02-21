// ============================================================
// Finale Screen — text between episodes / end-of-game art
// Reference: f_finale.c — F_StartFinale, F_Ticker, F_Drawer
// ============================================================

import { SCREENWIDTH, SCREENHEIGHT, rgbaBuffer, getUIWidth, getUIOffsetX } from '../render/software/draw';
import { PaletteData } from '../palette';
import { TextureData, Patch } from '../textures';
import { WAD } from '../wad';
import { FX_Music } from '../../game/effects';
import { Music } from '../../game/sounds';
import type { FinaleConfig } from '../../game/gameflow';

// ---- Constants (from f_finale.c) ----

const TEXTSPEED = 3;   // tics per character
const TEXTWAIT  = 250;  // tics to wait after text is done

// ---- Finale Stage ----

enum FinaleStage {
  Text = 0,     // typewriter text on flat background
  ArtScreen = 1, // fullscreen art image (Doom I only)
}

// ---- Episode text strings (from d_englsh.h) ----

const E1TEXT =
  "Once you beat the big badasses and\n" +
  "clean out the moon base you're supposed\n" +
  "to win, aren't you? Aren't you? Where's\n" +
  "your fat reward and ticket home? What\n" +
  "the hell is this? It's not supposed to\n" +
  "end this way!\n" +
  "\n" +
  "It stinks like rotten meat, but looks\n" +
  "like the lost Deimos base.  Looks like\n" +
  "you're stuck on The Shores of Hell.\n" +
  "The only way out is through.\n" +
  "\n" +
  "To continue the DOOM experience, play\n" +
  "The Shores of Hell and its amazing\n" +
  "sequel, Inferno!\n";

const E2TEXT =
  "You've done it! The hideous cyber-\n" +
  "demon lord that ruled the lost Deimos\n" +
  "moon base has been slain and you\n" +
  "are triumphant! But ... where are\n" +
  "you? You clamber to the edge of the\n" +
  "moon and look down to see the awful\n" +
  "truth.\n" +
  "\n" +
  "Deimos floats above Hell itself!\n" +
  "You've never heard of anyone escaping\n" +
  "from Hell, but you'll make the bastards\n" +
  "sorry they ever heard of you! Quickly,\n" +
  "you rappel down to  the surface of\n" +
  "Hell.\n" +
  "\n" +
  "Now, it's on to the final chapter of\n" +
  "DOOM! -- Inferno.";

const E3TEXT =
  "The loathsome spiderdemon that\n" +
  "masterminded the invasion of the moon\n" +
  "bases and caused so much death has had\n" +
  "its ass kicked for all time.\n" +
  "\n" +
  "A hidden doorway opens and you enter.\n" +
  "You've proven too tough for Hell to\n" +
  "contain, and now Hell at last plays\n" +
  "fair -- for you emerge from the door\n" +
  "to see the green fields of Earth!\n" +
  "Home at last.\n" +
  "\n" +
  "You wonder what's been happening on\n" +
  "Earth while you were battling evil\n" +
  "unleashed. It's good that no Hell-\n" +
  "spawn could have come through that\n" +
  "door with you ...";

const E4TEXT =
  "the spider mastermind must have sent forth\n" +
  "its legions of hellspawn before your\n" +
  "final confrontation with that terrible\n" +
  "beast from hell.  but you stepped forward\n" +
  "and brought forth eternal damnation and\n" +
  "suffering upon the horde as a true hero\n" +
  "would in the face of something so evil.\n" +
  "\n" +
  "besides, someone was gonna pay for what\n" +
  "happened to daisy, your pet rabbit.\n" +
  "\n" +
  "but now, you see spread before you more\n" +
  "potential pain and gibbitude as a nation\n" +
  "of demons run amok among our cities.\n" +
  "\n" +
  "next stop, hell on earth!";

// ---- Doom II text strings (from d_englsh.h) ----

const C1TEXT =
  "YOU HAVE ENTERED DEEPLY INTO THE INFESTED\n" +
  "STARPORT. BUT SOMETHING IS WRONG. THE\n" +
  "MONSTERS HAVE BROUGHT THEIR OWN REALITY\n" +
  "WITH THEM, AND THE STARPORT'S TECHNOLOGY\n" +
  "IS BEING SUBVERTED BY THEIR PRESENCE.\n" +
  "\n" +
  "AHEAD, YOU SEE AN OUTPOST OF HELL, A\n" +
  "FORTIFIED ZONE. IF YOU CAN GET PAST IT,\n" +
  "YOU CAN PENETRATE INTO THE HAUNTED HEART\n" +
  "OF THE STARBASE AND FIND THE CONTROLLING\n" +
  "SWITCH WHICH HOLDS EARTH'S POPULATION\n" +
  "HOSTAGE.";

const C2TEXT =
  "YOU HAVE WON! YOUR VICTORY HAS ENABLED\n" +
  "HUMANKIND TO EVACUATE EARTH AND ESCAPE\n" +
  "THE NIGHTMARE.  NOW YOU ARE THE ONLY\n" +
  "HUMAN LEFT ON THE FACE OF THE PLANET.\n" +
  "CANNIBAL MUTATIONS, CARNIVOROUS ALIENS,\n" +
  "AND EVIL SPIRITS ARE YOUR ONLY NEIGHBORS.\n" +
  "YOU SIT BACK AND WAIT FOR DEATH, CONTENT\n" +
  "THAT YOU HAVE SAVED YOUR SPECIES.\n" +
  "\n" +
  "BUT THEN, EARTH CONTROL BEAMS DOWN A\n" +
  "MESSAGE FROM SPACE: \"SENSORS HAVE LOCATED\n" +
  "THE SOURCE OF THE ALIEN INVASION. IF YOU\n" +
  "GO THERE, YOU MAY BE ABLE TO BLOCK THEIR\n" +
  "ENTRY.  THE ALIEN BASE IS IN THE HEART OF\n" +
  "YOUR OWN HOME CITY, NOT FAR FROM THE\n" +
  "STARPORT.\" SLOWLY AND PAINFULLY YOU GET\n" +
  "UP AND RETURN TO THE FRAY.";

const C3TEXT =
  "YOU ARE AT THE CORRUPT HEART OF THE CITY,\n" +
  "SURROUNDED BY THE CORPSES OF YOUR ENEMIES.\n" +
  "YOU SEE NO WAY TO DESTROY THE CREATURES'\n" +
  "ENTRYWAY ON THIS SIDE, SO YOU CLENCH YOUR\n" +
  "TEETH AND PLUNGE THROUGH IT.\n" +
  "\n" +
  "THERE MUST BE A WAY TO CLOSE IT ON THE\n" +
  "OTHER SIDE. WHAT DO YOU CARE IF YOU'VE\n" +
  "GOT TO GO THROUGH HELL TO GET TO IT?";

const C4TEXT =
  "THE HORRENDOUS VISAGE OF THE BIGGEST\n" +
  "DEMON YOU'VE EVER SEEN CRUMBLES BEFORE\n" +
  "YOU, AFTER YOU PUMP YOUR ROCKETS INTO\n" +
  "HIS EXPOSED BRAIN. THE MONSTER SHRIVELS\n" +
  "UP AND DIES, ITS THRASHING LIMBS\n" +
  "DEVASTATING UNTOLD MILES OF HELL'S\n" +
  "SURFACE.\n" +
  "\n" +
  "YOU'VE DONE IT. THE INVASION IS OVER.\n" +
  "EARTH IS SAVED. HELL IS A WRECK. YOU\n" +
  "WONDER WHERE BAD FOLKS WILL GO WHEN THEY\n" +
  "DIE, NOW. WIPING THE SWEAT FROM YOUR\n" +
  "FOREHEAD YOU BEGIN THE LONG TREK BACK\n" +
  "HOME. REBUILDING EARTH OUGHT TO BE A\n" +
  "LOT MORE FUN THAN RUINING IT WAS.\n";

const C5TEXT =
  "CONGRATULATIONS, YOU'VE FOUND THE SECRET\n" +
  "LEVEL! LOOKS LIKE IT'S BEEN BUILT BY\n" +
  "HUMANS, RATHER THAN DEMONS. YOU WONDER\n" +
  "WHO THE INMATES OF THIS CORNER OF HELL\n" +
  "WILL BE.";

const C6TEXT =
  "CONGRATULATIONS, YOU'VE FOUND THE\n" +
  "SUPER SECRET LEVEL!  YOU'D BETTER\n" +
  "BLAZE THROUGH THIS ONE!\n";

// ---- Finale configuration lookup ----

// FinaleConfig imported from game/gameflow.ts — re-export for consumers
export type { FinaleConfig } from '../../game/gameflow';

/** Get finale config for Doom I by episode (1-based) */
function getDoom1FinaleConfig(episode: number): FinaleConfig | null {
  switch (episode) {
    case 1: return { text: E1TEXT, flat: 'FLOOR4_8', music: Music.victor, isCommercial: false, episode: 1 };
    case 2: return { text: E2TEXT, flat: 'SFLR6_1',  music: Music.victor, isCommercial: false, episode: 2 };
    case 3: return { text: E3TEXT, flat: 'MFLR8_4',  music: Music.victor, isCommercial: false, episode: 3 };
    case 4: return { text: E4TEXT, flat: 'MFLR8_3',  music: Music.victor, isCommercial: false, episode: 4 };
    default: return null;
  }
}

/** Get finale config for Doom II by completed map (1-based) */
function getDoom2FinaleConfig(map: number): FinaleConfig | null {
  switch (map) {
    case 6:  return { text: C1TEXT, flat: 'SLIME16', music: Music.read_m, isCommercial: true, episode: 0 };
    case 11: return { text: C2TEXT, flat: 'RROCK14', music: Music.read_m, isCommercial: true, episode: 0 };
    case 20: return { text: C3TEXT, flat: 'RROCK07', music: Music.read_m, isCommercial: true, episode: 0 };
    case 30: return { text: C4TEXT, flat: 'RROCK17', music: Music.read_m, isCommercial: true, episode: 0 };
    case 15: return { text: C5TEXT, flat: 'RROCK13', music: Music.read_m, isCommercial: true, episode: 0 };
    case 31: return { text: C6TEXT, flat: 'RROCK19', music: Music.read_m, isCommercial: true, episode: 0 };
    default: return null;
  }
}

/** Should a finale screen be shown after completing this map?
 *  Returns FinaleConfig or null if no finale.
 */
export function getFinaleConfig(mapName: string, isCommercial: boolean, secretExit: boolean): FinaleConfig | null {
  if (isCommercial) {
    // Parse MAPxx
    const match = mapName.match(/^MAP(\d{2})$/i);
    if (!match) return null;
    const map = parseInt(match[1], 10);
    // Doom II shows finale at MAP06, 11, 20, 30
    // Also MAP15 and MAP31 if NOT secret exit
    if (map === 6 || map === 11 || map === 20 || map === 30) {
      return getDoom2FinaleConfig(map);
    }
    if ((map === 15 || map === 31) && !secretExit) {
      return getDoom2FinaleConfig(map);
    }
    return null;
  } else {
    // Parse ExMy
    const match = mapName.match(/^E(\d)M(\d)$/i);
    if (!match) return null;
    const episode = parseInt(match[1], 10);
    const mapNum = parseInt(match[2], 10);
    // Doom I shows finale after E?M8
    if (mapNum === 8) {
      return getDoom1FinaleConfig(episode);
    }
    return null;
  }
}

// ---- HUD font constants ----
const HU_FONTSTART = 33;  // '!'
const HU_FONTSIZE  = 58;  // chars 33..90 (uppercase ASCII + symbols)

// ============================================================
// Finale Screen Class
// ============================================================

export class Finale {
  private wad: WAD;
  private palData: PaletteData;
  private texData: TextureData;

  // Graphics
  private fontPatches: Map<number, Patch> = new Map();

  // State
  private stage: FinaleStage = FinaleStage.Text;
  private config: FinaleConfig | null = null;
  private count = 0;          // tic counter
  private finished = false;
  private onFinished: (() => void) | null = null;

  // Art screen patch (Doom I stages)
  private artPatch: Patch | null = null;

  constructor(wad: WAD, palData: PaletteData, texData: TextureData) {
    this.wad = wad;
    this.palData = palData;
    this.texData = texData;
    this.loadFont();
  }

  private loadPatch(name: string): Patch | null {
    const idx = this.wad.checkNumForName(name);
    if (idx === -1) return null;
    return this.texData.parsePatchLump(idx);
  }

  private loadFont(): void {
    for (let i = HU_FONTSTART; i <= HU_FONTSTART + HU_FONTSIZE; i++) {
      const name = `STCFN${i.toString().padStart(3, '0')}`;
      const p = this.loadPatch(name);
      if (p) this.fontPatches.set(i, p);
    }
  }

  // ============================================================
  // F_StartFinale
  // ============================================================

  start(config: FinaleConfig, onFinished: () => void): void {
    this.config = config;
    this.onFinished = onFinished;
    this.stage = FinaleStage.Text;
    this.count = 0;
    this.finished = false;
    this.artPatch = null;

    // Start finale music
    FX_Music(config.music, true);
  }

  // ============================================================
  // F_Ticker
  // ============================================================

  tick(): void {
    if (!this.config) return;

    // Doom II: allow skip after 50 tics (from f_finale.c F_Ticker)
    // Skip is handled via pressKey() which sets finished or advances stage

    this.count++;

    if (this.stage === FinaleStage.ArtScreen) {
      // Art screen — just wait, any key exits
      return;
    }

    // Text stage: check if text is fully displayed + wait elapsed
    if (this.stage === FinaleStage.Text && !this.config.isCommercial) {
      const textLen = this.config.text.length;
      if (this.count > textLen * TEXTSPEED + TEXTWAIT) {
        // Text done + wait elapsed → advance to art screen (Doom I)
        this.count = 0;
        this.stage = FinaleStage.ArtScreen;
        this.loadArtScreen();
      }
    }
  }

  /** Load the art screen patch for the current Doom I episode */
  private loadArtScreen(): void {
    if (!this.config || this.config.isCommercial) return;

    switch (this.config.episode) {
      case 1:
        // Ultimate DOOM uses CREDIT, otherwise HELP2
        this.artPatch = this.loadPatch('CREDIT') || this.loadPatch('HELP2');
        break;
      case 2:
        this.artPatch = this.loadPatch('VICTORY2');
        break;
      case 3:
        // E3 uses bunny scroll in original — show ENDPIC as fallback
        this.artPatch = this.loadPatch('ENDPIC') || this.loadPatch('CREDIT');
        break;
      case 4:
        this.artPatch = this.loadPatch('ENDPIC');
        break;
    }
  }

  /** Handle key press — skip text (Doom II) or exit art screen (Doom I) */
  pressKey(): void {
    if (!this.config) return;

    if (this.config.isCommercial) {
      // Doom II: any key after 50 tics → done
      if (this.count > 50) {
        this.finish();
      }
    } else {
      // Doom I:
      if (this.stage === FinaleStage.Text) {
        // Skip text — advance to art screen immediately
        this.count = 0;
        this.stage = FinaleStage.ArtScreen;
        this.loadArtScreen();
      } else if (this.stage === FinaleStage.ArtScreen) {
        // Art screen — exit finale
        this.finish();
      }
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.onFinished) this.onFinished();
  }

  isFinished(): boolean {
    return this.finished;
  }

  // ============================================================
  // F_Drawer
  // ============================================================

  draw(): void {
    if (!this.config) return;

    const pal = this.palData.rgbaLookup;
    const scale = getUIWidth() / 320;

    if (this.stage === FinaleStage.ArtScreen) {
      this.drawArtScreen(pal, scale);
    } else {
      this.drawTextScreen(pal, scale);
    }
  }

  // ---- Text screen: tiled flat background + typewriter text ----

  private drawTextScreen(pal: Uint32Array, scale: number): void {
    if (!this.config) return;

    // Draw tiled flat background
    this.drawFlatBackground(this.config.flat, pal);

    // Draw text with typewriter effect
    const charsToShow = Math.max(0, Math.floor((this.count - 10) / TEXTSPEED));
    this.drawFinaleText(this.config.text, charsToShow, pal, scale);
  }

  /** Tile a 64×64 flat across the UI area (centered in widescreen) */
  private drawFlatBackground(flatName: string, pal: Uint32Array): void {
    // Clear full screen (widescreen side bars)
    rgbaBuffer.fill(0xFF000000);

    const flat = this.texData.flats.get(flatName.toUpperCase());
    if (!flat) return;

    const offsetX = getUIOffsetX();
    const uiWidth = getUIWidth();
    const scale = uiWidth / 320;
    const srcW = 64;

    for (let sy = 0; sy < SCREENHEIGHT; sy++) {
      const origY = Math.floor(sy / scale);
      const fy = origY & 63;

      for (let sx = 0; sx < uiWidth; sx++) {
        const origX = Math.floor(sx / scale);
        const fx = origX & 63;

        const pixel = flat.data[fy * srcW + fx];
        rgbaBuffer[sy * SCREENWIDTH + (offsetX + sx)] = pal[pixel];
      }
    }
  }

  /** Draw typewriter text using HUD font */
  private drawFinaleText(text: string, maxChars: number, pal: Uint32Array, scale: number): void {
    let cx = Math.round(10 * scale);
    let cy = Math.round(10 * scale);
    const lineHeight = Math.round(11 * scale);

    let charIdx = 0;
    for (let i = 0; i < text.length && charIdx < maxChars; i++) {
      const ch = text[i];

      if (ch === '\n') {
        cx = Math.round(10 * scale);
        cy += lineHeight;
        charIdx++;
        continue;
      }

      const code = ch.toUpperCase().charCodeAt(0);
      if (code < HU_FONTSTART || code > HU_FONTSTART + HU_FONTSIZE) {
        cx += Math.round(4 * scale);
        charIdx++;
        continue;
      }

      const patch = this.fontPatches.get(code);
      if (patch) {
        if (cx + Math.round(patch.width * scale) > getUIWidth()) {
          // wrap — don't draw past right edge
          cx = Math.round(10 * scale);
          cy += lineHeight;
        }
        this.drawPatch(patch, cx, cy, pal, scale);
        cx += Math.round(patch.width * scale);
      } else {
        cx += Math.round(4 * scale);
      }

      charIdx++;
    }
  }

  // ---- Art screen ----

  private drawArtScreen(pal: Uint32Array, scale: number): void {
    rgbaBuffer.fill(0xFF000000);
    if (this.artPatch) {
      this.drawPatch(this.artPatch, 0, 0, pal, scale);
    } else {
      // Fallback: just keep showing text screen
      this.drawTextScreen(pal, scale);
    }
  }

  // ---- Patch rendering (same as intermission) ----

  private drawPatch(patch: Patch, x: number, y: number, pal: Uint32Array, scale: number): void {
    x += getUIOffsetX();
    const scaledW = Math.round(patch.width * scale);

    for (let sx = 0; sx < scaledW; sx++) {
      const screenX = x + sx;
      if (screenX < 0 || screenX >= SCREENWIDTH) continue;

      const origCx = Math.min(Math.floor(sx / scale), patch.width - 1);
      const col = patch.columns[origCx];

      for (const post of col) {
        for (let dy = 0; dy < post.length; dy++) {
          const origY = post.topDelta + dy;
          const startSY = Math.round(origY * scale);
          const endSY = Math.round((origY + 1) * scale);
          for (let sy = startSY; sy < endSY; sy++) {
            const screenY = y + sy;
            if (screenY < 0 || screenY >= SCREENHEIGHT) continue;

            const pixel = post.data[dy];
            rgbaBuffer[screenY * SCREENWIDTH + screenX] = pal[pixel];
          }
        }
      }
    }
  }
}
