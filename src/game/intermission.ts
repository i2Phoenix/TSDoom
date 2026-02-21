// ============================================================
// Intermission Screen — statistics between levels
// Reference: wi_stuff.c — WI_Start, WI_Ticker, WI_Drawer
// ============================================================

import { SCREENWIDTH, SCREENHEIGHT, rgbaBuffer, getUIWidth, getUIOffsetX } from '../render/software/draw';
import { PaletteData } from '../palette';
import { TextureData, Patch } from '../textures';
import { WAD } from '../wad';
import { FX_Sound, FX_Music } from '../../game/effects';
import { Sfx, Music } from '../../game/sounds';
import type { WBStartStruct } from '../../game/gameflow';

// ---- Constants (from wi_stuff.c) ----

const TICRATE = 35;

// Screen coordinates (320×200 space)
const WI_TITLEY     = 2;
const WI_SPACINGY   = 33;
const SP_STATSX     = 50;
const SP_STATSY     = 50;
const SP_TIMEX      = 16;
const SP_TIMEY      = 200 - 32;
const SP_PAUSE      = 1; // tics pause between stats phases

const SHOWNEXTLOCDELAY = 4; // seconds

// ---- Intermission State ----

enum IntState {
  StatCount,
  ShowNextLoc,
  NoState,
}

// WBStartStruct imported from game/gameflow.ts — re-export for consumers
export type { WBStartStruct } from '../../game/gameflow';


// ---- Par Times (in tics) ----
// Episode par times from wi_stuff.c (Doom I only, episodes 0-2)
const PAR_TIMES: number[][] = [
  // E1M1-E1M9
  [0, 30, 75, 120, 90, 165, 180, 180, 30, 165].map(s => s * TICRATE),
  // E2M1-E2M9
  [0, 90, 90, 90, 120, 90, 360, 240, 30, 170].map(s => s * TICRATE),
  // E3M1-E3M9
  [0, 90, 45, 150, 150, 90, 90, 165, 30, 135].map(s => s * TICRATE),
];

// Doom II par times (from wi_stuff.c cpars[], MAP01-MAP32, in seconds)
const CPARS: number[] = [
   30,  90, 120, 120,  90, 150, 120, 120, 270,  90, //  1-10
  210, 150, 150, 150, 210, 150, 420, 150, 210, 150, // 11-20
  240, 150, 180, 150, 150, 300, 330, 420, 300, 180, // 21-30
  120,  30,                                          // 31-32
].map(s => s * TICRATE);

function getParTime(epsd: number, map: number): number {
  if (epsd >= 0 && epsd < PAR_TIMES.length) {
    const pars = PAR_TIMES[epsd];
    if (map >= 0 && map < pars.length) return pars[map];
  }
  return 0;
}

function getDoom2ParTime(map: number): number {
  // map is 1-based; CPARS is 0-based
  if (map >= 1 && map <= CPARS.length) return CPARS[map - 1];
  return 0;
}

// ---- Doom I Episode Map Location Dots ----
const LNODES: { x: number; y: number }[][] = [
  // Episode 1
  [
    { x: 185, y: 164 }, { x: 148, y: 143 }, { x: 69, y: 122 },
    { x: 209, y: 102 }, { x: 116, y: 89 },  { x: 166, y: 55 },
    { x: 71, y: 56 },   { x: 135, y: 29 },  { x: 71, y: 24 },
  ],
  // Episode 2
  [
    { x: 254, y: 25 },  { x: 97, y: 50 },   { x: 188, y: 64 },
    { x: 128, y: 78 },  { x: 214, y: 92 },  { x: 133, y: 130 },
    { x: 208, y: 136 }, { x: 148, y: 140 }, { x: 235, y: 158 },
  ],
  // Episode 3
  [
    { x: 156, y: 168 }, { x: 48, y: 154 },  { x: 174, y: 95 },
    { x: 265, y: 75 },  { x: 130, y: 48 },  { x: 279, y: 23 },
    { x: 198, y: 48 },  { x: 140, y: 25 },  { x: 281, y: 136 },
  ],
];

// ============================================================
// Intermission Screen Class
// ============================================================

export class Intermission {
  private wad: WAD;
  private palData: PaletteData;
  private texData: TextureData;

  // Graphics
  private nums: (Patch | null)[] = [];        // WINUM0-9
  private percent: Patch | null = null;       // WIPCNT
  private colon: Patch | null = null;         // WICOLON
  private wiminus: Patch | null = null;       // WIMINUS
  private finished: Patch | null = null;      // WIF
  private entering: Patch | null = null;      // WIENTER
  private wiKills: Patch | null = null;       // WIOSTK
  private wiItems: Patch | null = null;       // WIOSTI
  private wiSecret: Patch | null = null;      // WISCRT2
  private wiTime: Patch | null = null;        // WITIME
  private wiPar: Patch | null = null;         // WIPAR
  private wiSucks: Patch | null = null;       // WISUCKS
  private bg: Patch | null = null;            // WIMAP0/INTERPIC
  private splat: Patch | null = null;         // WISPLAT
  private yah: (Patch | null)[] = [];         // WIURH0, WIURH1
  private lnames: (Patch | null)[] = [];      // level name patches

  // HUD font (STCFN033–STCFN095) — shared approach
  private fontPatches: Map<number, Patch> = new Map();

  // State
  private state: IntState = IntState.StatCount;
  private wbs: WBStartStruct | null = null;
  private accelerate = false;
  private sp_state = 0;
  private cnt_kills = -1;
  private cnt_items = -1;
  private cnt_secret = -1;
  private cnt_time = -1;
  private cnt_par = -1;
  private cnt_pause = 0;
  private bcnt = 0;       // background animation counter
  private finished_flag = false; // true when intermission is done

  // Callback when intermission ends
  private onFinished: (() => void) | null = null;

  constructor(wad: WAD, palData: PaletteData, texData: TextureData) {
    this.wad = wad;
    this.palData = palData;
    this.texData = texData;
    this.loadGraphics();
  }

  private loadPatch(name: string): Patch | null {
    const idx = this.wad.checkNumForName(name);
    if (idx === -1) return null;
    return this.texData.parsePatchLump(idx);
  }

  private loadGraphics(): void {
    // Numbers 0-9
    for (let i = 0; i < 10; i++) {
      this.nums.push(this.loadPatch(`WINUM${i}`));
    }
    this.percent = this.loadPatch('WIPCNT');
    this.colon = this.loadPatch('WICOLON');
    this.wiminus = this.loadPatch('WIMINUS');
    this.finished = this.loadPatch('WIF');
    this.entering = this.loadPatch('WIENTER');
    this.wiKills = this.loadPatch('WIOSTK');
    this.wiItems = this.loadPatch('WIOSTI');
    this.wiSecret = this.loadPatch('WISCRT2');
    this.wiTime = this.loadPatch('WITIME');
    this.wiPar = this.loadPatch('WIPAR');
    this.wiSucks = this.loadPatch('WISUCKS');
    this.splat = this.loadPatch('WISPLAT');
    this.yah.push(this.loadPatch('WIURH0'));
    this.yah.push(this.loadPatch('WIURH1'));

    // HUD font
    for (let i = 33; i <= 95; i++) {
      const name = `STCFN${i.toString().padStart(3, '0')}`;
      const p = this.loadPatch(name);
      if (p) this.fontPatches.set(i, p);
    }
  }

  /** Load background and level name patches for current episode */
  private loadBackground(): void {
    if (!this.wbs) return;

    // Background
    if (this.wbs.isCommercial) {
      this.bg = this.loadPatch('INTERPIC');
    } else {
      this.bg = this.loadPatch(`WIMAP${this.wbs.epsd}`);
      // Episode 4 (Ultimate DOOM) uses INTERPIC
      if (!this.bg) this.bg = this.loadPatch('INTERPIC');
    }

    // Level names
    this.lnames = [];
    if (this.wbs.isCommercial) {
      for (let i = 0; i < 32; i++) {
        this.lnames.push(this.loadPatch(`CWILV${i.toString().padStart(2, '0')}`));
      }
    } else {
      for (let i = 0; i < 9; i++) {
        this.lnames.push(this.loadPatch(`WILV${this.wbs.epsd}${i}`));
      }
    }
  }

  // ============================================================
  // WI_Start — begin intermission
  // ============================================================

  start(wbs: WBStartStruct, onFinished: () => void): void {
    this.wbs = wbs;
    this.onFinished = onFinished;
    this.accelerate = false;
    this.bcnt = 0;
    this.finished_flag = false;

    // Auto-populate par time from internal tables if not set
    if (!wbs.partime || wbs.partime <= 0) {
      if (wbs.isCommercial) {
        wbs.partime = getDoom2ParTime(wbs.last + 1); // last is 0-based, getDoom2ParTime expects 1-based
      } else {
        wbs.partime = getParTime(wbs.epsd, wbs.last + 1); // PAR_TIMES[epsd][map], map is 1-based in table
      }
    }

    this.loadBackground();
    this.initStats();
  }

  private initStats(): void {
    this.state = IntState.StatCount;
    this.accelerate = false;
    this.sp_state = 1;
    this.cnt_kills = this.cnt_items = this.cnt_secret = -1;
    this.cnt_time = this.cnt_par = -1;
    this.cnt_pause = TICRATE;
  }

  // ============================================================
  // WI_Ticker — update each tick
  // ============================================================

  tick(): void {
    this.bcnt++;

    // Start intermission music on first tick
    if (this.bcnt === 1) {
      if (this.wbs?.isCommercial) {
        FX_Music(Music.dm2int, true);
      } else {
        FX_Music(Music.inter, true);
      }
    }

    switch (this.state) {
      case IntState.StatCount:
        this.updateStats();
        break;
      case IntState.ShowNextLoc:
        this.updateShowNextLoc();
        break;
      case IntState.NoState:
        this.updateNoState();
        break;
    }
  }

  private updateStats(): void {
    if (!this.wbs) return;

    // Accelerate — skip counting animation
    if (this.accelerate && this.sp_state !== 10) {
      this.accelerate = false;
      const maxk = this.wbs.maxkills || 1;
      const maxi = this.wbs.maxitems || 1;
      const maxs = this.wbs.maxsecret || 1;
      this.cnt_kills = Math.floor((this.wbs.skills * 100) / maxk);
      this.cnt_items = Math.floor((this.wbs.sitems * 100) / maxi);
      this.cnt_secret = Math.floor((this.wbs.ssecret * 100) / maxs);
      this.cnt_time = Math.floor(this.wbs.stime / TICRATE);
      this.cnt_par = Math.floor(this.wbs.partime / TICRATE);
      FX_Sound(null, Sfx.barexp);
      this.sp_state = 10;
    }

    if (this.sp_state === 2) {
      // Counting kills
      this.cnt_kills += 2;
      if (!(this.bcnt & 3)) FX_Sound(null, Sfx.pistol);

      const target = Math.floor((this.wbs.skills * 100) / (this.wbs.maxkills || 1));
      if (this.cnt_kills >= target) {
        this.cnt_kills = target;
        FX_Sound(null, Sfx.barexp);
        this.sp_state++;
      }
    } else if (this.sp_state === 4) {
      // Counting items
      this.cnt_items += 2;
      if (!(this.bcnt & 3)) FX_Sound(null, Sfx.pistol);

      const target = Math.floor((this.wbs.sitems * 100) / (this.wbs.maxitems || 1));
      if (this.cnt_items >= target) {
        this.cnt_items = target;
        FX_Sound(null, Sfx.barexp);
        this.sp_state++;
      }
    } else if (this.sp_state === 6) {
      // Counting secrets
      this.cnt_secret += 2;
      if (!(this.bcnt & 3)) FX_Sound(null, Sfx.pistol);

      const target = Math.floor((this.wbs.ssecret * 100) / (this.wbs.maxsecret || 1));
      if (this.cnt_secret >= target) {
        this.cnt_secret = target;
        FX_Sound(null, Sfx.barexp);
        this.sp_state++;
      }
    } else if (this.sp_state === 8) {
      // Counting time
      if (!(this.bcnt & 3)) FX_Sound(null, Sfx.pistol);

      this.cnt_time += 3;
      const targetTime = Math.floor(this.wbs.stime / TICRATE);
      if (this.cnt_time >= targetTime) this.cnt_time = targetTime;

      this.cnt_par += 3;
      const targetPar = Math.floor(this.wbs.partime / TICRATE);
      if (this.cnt_par >= targetPar) {
        this.cnt_par = targetPar;
        if (this.cnt_time >= targetTime) {
          FX_Sound(null, Sfx.barexp);
          this.sp_state++;
        }
      }
    } else if (this.sp_state === 10) {
      // Waiting for player to continue
      if (this.accelerate) {
        FX_Sound(null, Sfx.sgcock);
        if (this.wbs.isCommercial) {
          this.initNoState();
        } else {
          this.initShowNextLoc();
        }
      }
    } else if (this.sp_state & 1) {
      // Pause between phases
      if (--this.cnt_pause <= 0) {
        this.sp_state++;
        this.cnt_pause = TICRATE;
      }
    }
  }

  private initShowNextLoc(): void {
    this.state = IntState.ShowNextLoc;
    this.accelerate = false;
    this.cnt_pause = SHOWNEXTLOCDELAY * TICRATE;
  }

  private updateShowNextLoc(): void {
    if (--this.cnt_pause <= 0 || this.accelerate) {
      this.initNoState();
    }
  }

  private initNoState(): void {
    this.state = IntState.NoState;
    this.accelerate = false;
    this.cnt_pause = 10;
  }

  private updateNoState(): void {
    if (--this.cnt_pause <= 0) {
      this.finished_flag = true;
      if (this.onFinished) this.onFinished();
    }
  }

  /** Called from input handler */
  pressAccelerate(): void {
    this.accelerate = true;
  }

  /** Is the intermission finished? */
  isFinished(): boolean {
    return this.finished_flag;
  }

  // ============================================================
  // WI_Drawer — draw the intermission screen
  // ============================================================

  draw(): void {
    const pal = this.palData.rgbaLookup;
    const scale = getUIWidth() / 320;

    // Draw background
    this.drawBackground(pal, scale);

    switch (this.state) {
      case IntState.StatCount:
        this.drawStats(pal, scale);
        break;
      case IntState.ShowNextLoc:
        this.drawShowNextLoc(pal, scale);
        break;
      case IntState.NoState:
        this.drawNoState(pal, scale);
        break;
    }
  }

  private drawBackground(pal: Uint32Array, scale: number): void {
    // Clear full screen (widescreen side bars)
    rgbaBuffer.fill(0xFF000000);
    if (this.bg) {
      this.drawPatch(this.bg, 0, 0, pal, scale, false);
    }
  }

  // ---- Single Player Stats ----

  private drawStats(pal: Uint32Array, scale: number): void {
    if (!this.wbs) return;

    const numH = this.nums[0] ? this.nums[0].height : 12;
    const lh = Math.floor((3 * numH) / 2);

    // Draw "<LevelName> Finished!"
    this.drawLF(pal, scale);

    // "Kills:"
    if (this.wiKills) {
      this.drawPatch(this.wiKills,
        Math.round(SP_STATSX * scale),
        Math.round(SP_STATSY * scale),
        pal, scale, false);
    }
    this.drawPercent(
      Math.round((320 - SP_STATSX) * scale),
      Math.round(SP_STATSY * scale),
      this.cnt_kills, pal, scale);

    // "Items:"
    if (this.wiItems) {
      this.drawPatch(this.wiItems,
        Math.round(SP_STATSX * scale),
        Math.round((SP_STATSY + lh) * scale),
        pal, scale, false);
    }
    this.drawPercent(
      Math.round((320 - SP_STATSX) * scale),
      Math.round((SP_STATSY + lh) * scale),
      this.cnt_items, pal, scale);

    // "Secret:"
    if (this.wiSecret) {
      this.drawPatch(this.wiSecret,
        Math.round(SP_STATSX * scale),
        Math.round((SP_STATSY + 2 * lh) * scale),
        pal, scale, false);
    }
    this.drawPercent(
      Math.round((320 - SP_STATSX) * scale),
      Math.round((SP_STATSY + 2 * lh) * scale),
      this.cnt_secret, pal, scale);

    // "Time:" / "Par:"
    if (this.wiTime) {
      this.drawPatch(this.wiTime,
        Math.round(SP_TIMEX * scale),
        Math.round(SP_TIMEY * scale),
        pal, scale, false);
    }
    this.drawTime(
      Math.round((160 - SP_TIMEX) * scale),
      Math.round(SP_TIMEY * scale),
      this.cnt_time, pal, scale);

    // Show par time for Doom I (episodes 0-2) and Doom II (all maps)
    if (this.wbs && (this.wbs.isCommercial || this.wbs.epsd < 3)) {
      if (this.wiPar) {
        this.drawPatch(this.wiPar,
          Math.round((160 + SP_TIMEX) * scale),
          Math.round(SP_TIMEY * scale),
          pal, scale, false);
      }
      this.drawTime(
        Math.round((320 - SP_TIMEX) * scale),
        Math.round(SP_TIMEY * scale),
        this.cnt_par, pal, scale);
    }
  }

  private drawShowNextLoc(pal: Uint32Array, scale: number): void {
    if (!this.wbs) return;

    // Draw splats on completed levels (Doom I only)
    if (!this.wbs.isCommercial && this.wbs.epsd < 3) {
      for (let i = 0; i <= this.wbs.last; i++) {
        if (this.splat && i < LNODES[this.wbs.epsd].length) {
          const loc = LNODES[this.wbs.epsd][i];
          this.drawPatch(this.splat,
            Math.round(loc.x * scale),
            Math.round(loc.y * scale),
            pal, scale, true);
        }
      }

      // Draw "You Are Here" blinking
      if (this.wbs.next < LNODES[this.wbs.epsd].length) {
        const loc = LNODES[this.wbs.epsd][this.wbs.next];
        const yahIdx = (this.bcnt >> 5) & 1; // blink every 32 tics
        const yahPatch = this.yah[yahIdx];
        if (yahPatch) {
          this.drawPatch(yahPatch,
            Math.round(loc.x * scale),
            Math.round(loc.y * scale),
            pal, scale, true);
        }
      }
    }

    // Draw "Entering <LevelName>"
    this.drawEL(pal, scale);
  }

  private drawNoState(pal: Uint32Array, scale: number): void {
    this.drawShowNextLoc(pal, scale);
  }

  // ---- Text drawing helpers ----

  /** Draw "<LevelName> Finished!" */
  private drawLF(pal: Uint32Array, scale: number): void {
    if (!this.wbs) return;

    let y = Math.round(WI_TITLEY * scale);

    // Draw last level name
    const lname = this.lnames[this.wbs.last];
    if (lname) {
      const lx = Math.round((getUIWidth() - lname.width * scale) / 2);
      this.drawPatch(lname, lx, y, pal, scale, false);
      y += Math.round((5 * lname.height * scale) / 4);
    } else {
      // Fallback: draw level name as text
      this.drawText(this.wbs.lastMapName, getUIWidth() / 2, y, pal, scale, true);
      y += Math.round(20 * scale);
    }

    // Draw "Finished!"
    if (this.finished) {
      const fx = Math.round((getUIWidth() - this.finished.width * scale) / 2);
      this.drawPatch(this.finished, fx, y, pal, scale, false);
    }
  }

  /** Draw "Entering <LevelName>" */
  private drawEL(pal: Uint32Array, scale: number): void {
    if (!this.wbs) return;

    let y = Math.round(WI_TITLEY * scale);

    // Draw "Entering"
    if (this.entering) {
      const ex = Math.round((getUIWidth() - this.entering.width * scale) / 2);
      this.drawPatch(this.entering, ex, y, pal, scale, false);
      y += Math.round((5 * (this.entering.height) * scale) / 4);
    }

    // Draw next level name
    const lname = this.lnames[this.wbs.next];
    if (lname) {
      const lx = Math.round((getUIWidth() - lname.width * scale) / 2);
      this.drawPatch(lname, lx, y, pal, scale, false);
    } else {
      this.drawText(this.wbs.nextMapName, getUIWidth() / 2, y, pal, scale, true);
    }
  }

  // ---- Number/Percent/Time drawing ----

  /** Draw a percentage value (right-aligned at x) */
  private drawPercent(x: number, y: number, val: number, pal: Uint32Array, scale: number): void {
    if (val < 0) return; // not yet counting
    if (this.percent) {
      this.drawPatch(this.percent, x, y, pal, scale, false);
    }
    this.drawNum(x, y, val, -1, pal, scale);
  }

  /** Draw time as MM:SS (right-aligned at x) */
  private drawTime(x: number, y: number, t: number, pal: Uint32Array, scale: number): void {
    if (t < 0) return;

    // If time > 61 minutes, show "Sucks" 
    if (t / 60 >= 61) {
      if (this.wiSucks) {
        this.drawPatch(this.wiSucks, x - Math.round(this.wiSucks.width * scale), y, pal, scale, false);
      }
      return;
    }

    const digitW = this.nums[0] ? Math.round(this.nums[0].width * scale) : Math.round(14 * scale);

    // Seconds
    const secs = t % 60;
    this.drawNum(x, y, secs, 2, pal, scale);
    x -= digitW * 2;

    // Colon
    if (this.colon) {
      const cw = Math.round(this.colon.width * scale);
      x -= cw;
      this.drawPatch(this.colon, x, y, pal, scale, false);
    }

    // Minutes
    const mins = Math.floor(t / 60);
    if (mins > 0) {
      this.drawNum(x, y, mins, -1, pal, scale);
    }
  }

  /** Draw a number right-aligned at x. If maxDigits > 0, pad with spaces. */
  private drawNum(x: number, y: number, n: number, maxDigits: number, pal: Uint32Array, scale: number): void {
    if (this.nums[0] === null) return;

    const digitW = Math.round(this.nums[0]!.width * scale);
    const neg = n < 0;
    n = Math.abs(n);

    const str = n.toString();
    let dx = x - digitW;

    // Draw digits right-to-left
    for (let i = str.length - 1; i >= 0; i--) {
      const d = parseInt(str[i]);
      const patch = this.nums[d];
      if (patch) this.drawPatch(patch, dx, y, pal, scale, false);
      dx -= digitW;
    }

    // Pad with leading zeros if needed
    if (maxDigits > 0) {
      for (let i = str.length; i < maxDigits; i++) {
        const patch = this.nums[0];
        if (patch) this.drawPatch(patch, dx, y, pal, scale, false);
        dx -= digitW;
      }
    }

    // Minus sign
    if (neg && this.wiminus) {
      this.drawPatch(this.wiminus, dx, y, pal, scale, false);
    }
  }

  // ---- Text drawing (fallback using HUD font) ----
  private drawText(text: string, centerX: number, y: number, pal: Uint32Array, scale: number, centered: boolean): void {
    const upper = text.toUpperCase();
    const charW = Math.round(8 * scale);
    let totalW = upper.length * charW;
    let cx = centered ? centerX - totalW / 2 : centerX;

    for (let i = 0; i < upper.length; i++) {
      const code = upper.charCodeAt(i);
      if (code === 32) { cx += Math.round(4 * scale); continue; }
      const patch = this.fontPatches.get(code);
      if (patch) {
        this.drawPatch(patch, Math.round(cx), y, pal, scale, false);
        cx += Math.round(patch.width * scale);
      } else {
        cx += Math.round(4 * scale);
      }
    }
  }

  // ---- Patch rendering ----

  private drawPatch(patch: Patch, x: number, y: number, pal: Uint32Array, scale: number, applyOffset: boolean): void {
    x += getUIOffsetX();
    if (applyOffset) {
      x -= Math.round(patch.leftOffset * scale);
      y -= Math.round(patch.topOffset * scale);
    }

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
