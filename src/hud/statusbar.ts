// ============================================================
// Status Bar HUD
// Reference: st_stuff.c — status bar rendering
// ============================================================

import { SCREENWIDTH, SCREENHEIGHT, rgbaBuffer, getUIWidth, getUIOffsetX } from '../render/software/draw';
import { PaletteData } from '../palette';
import { TextureData, Patch } from '../textures';
import { WAD } from '../wad';
import { Player } from '../../game/player';
import { AmmoType, WeaponType, weaponinfo } from '../../game/weapons';
import { CF_GODMODE } from '../../game/cheats';

const STBAR_HEIGHT_ORIG = 32;
/** UI-aware scale: uses 8:5 UI width, not full widescreen width */
function getScale(): number { return getUIWidth() / 320; }

// ===========================================================
// DOOM status bar positions (in 320-pixel coordinate space)
// ABSOLUTE screen Y coords as in DOOM's st_stuff.c, where
// stbar top = 168 (200 - 32)
// We store them as RELATIVE to stbar top for easier math.
// Original → relative = original - 168
// ===========================================================
const ST_Y = 168; // stbar top in 200-high screen

// Ammo (current weapon)
const ST_AMMOX = 44;
const ST_AMMOY = 171 - ST_Y;  // 3

// Health
const ST_HEALTHX = 90;
const ST_HEALTHY = 171 - ST_Y; // 3

// Arms area
const ST_ARMSX = 111;
const ST_ARMSY = 172 - ST_Y;   // 4
const ST_ARMSXSPACE = 12;
const ST_ARMSYSPACE = 10;
const ST_ARMSBGX = 104;
const ST_ARMSBGY = 168 - ST_Y; // 0

// Face (absolute = 143, 168; V_DrawPatch subtracts leftOffset/topOffset)
const ST_FACESX = 143;
const ST_FACESY = 168 - ST_Y;  // 0

// Armor
const ST_ARMORX = 221;
const ST_ARMORY = 171 - ST_Y;  // 3

// Keys
const ST_KEY0X = 239;
const ST_KEY0Y = 171 - ST_Y;   // 3
const ST_KEY1X = 239;
const ST_KEY1Y = 181 - ST_Y;   // 13
const ST_KEY2X = 239;
const ST_KEY2Y = 191 - ST_Y;   // 23

// Ammo tallies (small yellow numbers, right side)
const ST_AMMO0X = 288;
const ST_AMMO0Y = 173 - ST_Y;  // 5
const ST_AMMO1Y = 179 - ST_Y;  // 11
const ST_AMMO2Y = 191 - ST_Y;  // 23
const ST_AMMO3Y = 185 - ST_Y;  // 17
const ST_MAXAMMO0X = 314;
const ST_MAXAMMO0Y = 173 - ST_Y;
const ST_MAXAMMO1Y = 179 - ST_Y;
const ST_MAXAMMO2Y = 191 - ST_Y;
const ST_MAXAMMO3Y = 185 - ST_Y;

// ===========================================================
// Face animation constants (from st_stuff.c)
// ===========================================================
const ST_NUMPAINFACES     = 5;
const ST_NUMSTRAIGHTFACES = 3;
const ST_NUMTURNFACES     = 2;
const ST_NUMSPECIALFACES  = 3;  // ouch, evil, kill
const ST_NUMEXTRAFACES    = 2;  // god, dead

const ST_FACESTRIDE = ST_NUMSTRAIGHTFACES + ST_NUMTURNFACES + ST_NUMSPECIALFACES; // 8

// Offsets within a health tier
const ST_TURNOFFSET   = ST_NUMSTRAIGHTFACES;     // 3
const ST_OUCHOFFSET   = ST_TURNOFFSET + ST_NUMTURNFACES; // 5
const ST_EVILGRINOFFSET = ST_OUCHOFFSET + 1;     // 6
const ST_RAMPAGEOFFSET  = ST_EVILGRINOFFSET + 1; // 7

// Special face indices (at the end of the faces array)
const ST_NUMFACES = ST_FACESTRIDE * ST_NUMPAINFACES + ST_NUMEXTRAFACES; // 42
const ST_GODFACE  = ST_NUMPAINFACES * ST_FACESTRIDE;     // 40
const ST_DEADFACE = ST_GODFACE + 1;                      // 41

// Timing & thresholds
const ST_STRAIGHTFACECOUNT = 17;  // tics between random face changes (about 0.5s)
const ST_TURNCOUNT         = 35;  // tics to show damage direction turn
const ST_EVILGRINCOUNT     = 63;  // ~2 sec evil grin
const ST_RAMPAGEDELAY      = 2;   // counter delay before rampage
const ST_MUCHPAIN          = 20;  // health loss threshold for ouch face
const ST_FACEPROBABILITY   = 96;  // N/256 probability to change face

// HUD message constants (from hu_stuff.h)
const TICRATE = 35;
const HU_MSGTIMEOUT = 4 * TICRATE;  // 140 tics ≈ 4 seconds

export class StatusBar {
  private wad: WAD;
  private palData: PaletteData;
  private texData: TextureData;

  // Graphics
  private stbarPatch: Patch | null = null;
  private armsBg: Patch | null = null;
  private faceBg: Patch | null = null;      // STFB0 face background
  private bigRedNums: Patch[] = [];          // STTNUM0-9
  private yellowNums: Patch[] = [];          // STYSNUM0-9
  private greyNums: Patch[] = [];            // STGNUM2-7 (arms indicators)
  private percentPatch: Patch | null = null;
  private minusPatch: Patch | null = null;
  private keyPatches: (Patch | null)[] = [];  // STKEYS0-5
  private faces: (Patch | null)[] = [];       // all face sprites (ST_NUMFACES)

  // HUD font (STCFN033–STCFN095) for pickup messages
  private fontPatches: Map<number, Patch> = new Map();
  // Message state
  private messageText: string | null = null;
  private messageCounter = 0;

  // Face animation state (mirroring DOOM's static vars)
  private st_faceindex = 0;
  private st_facecount = ST_STRAIGHTFACECOUNT;
  private st_oldhealth = -1;
  private priority = 0;
  private lastattackdown = -1;
  private st_randomnumber = 0;
  private oldweaponsowned: boolean[] = [];

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
    // STBAR background
    this.stbarPatch = this.loadPatch('STBAR');

    // Arms background
    this.armsBg = this.loadPatch('STARMS');

    // Face background (player color)
    this.faceBg = this.loadPatch('STFB0');

    // Big red numbers (STTNUM0-9)
    for (let i = 0; i < 10; i++) {
      const p = this.loadPatch(`STTNUM${i}`);
      if (p) this.bigRedNums.push(p);
    }

    // Small yellow numbers (STYSNUM0-9)
    for (let i = 0; i < 10; i++) {
      const p = this.loadPatch(`STYSNUM${i}`);
      if (p) this.yellowNums.push(p);
    }

    // Grey numbers for arms (STGNUM2-7)
    for (let i = 2; i <= 7; i++) {
      const p = this.loadPatch(`STGNUM${i}`);
      if (p) this.greyNums.push(p);
    }

    // Percent sign
    this.percentPatch = this.loadPatch('STTPRCNT');

    // Minus sign
    this.minusPatch = this.loadPatch('STTMINUS');

    // Key indicators (STKEYS0-5)
    for (let i = 0; i < 6; i++) {
      this.keyPatches.push(this.loadPatch(`STKEYS${i}`));
    }

    // Face sprites — in exact DOOM order (st_stuff.c ST_loadGraphics)
    // 5 pain tiers × 8 faces per tier, then god, then dead
    let facenum = 0;
    for (let i = 0; i < ST_NUMPAINFACES; i++) {
      // Straight ahead (3 frames)
      for (let j = 0; j < ST_NUMSTRAIGHTFACES; j++) {
        this.faces[facenum++] = this.loadPatch(`STFST${i}${j}`);
      }
      // Turn right
      this.faces[facenum++] = this.loadPatch(`STFTR${i}0`);
      // Turn left
      this.faces[facenum++] = this.loadPatch(`STFTL${i}0`);
      // Ouch
      this.faces[facenum++] = this.loadPatch(`STFOUCH${i}`);
      // Evil grin
      this.faces[facenum++] = this.loadPatch(`STFEVL${i}`);
      // Kill/rampage
      this.faces[facenum++] = this.loadPatch(`STFKILL${i}`);
    }
    // God mode
    this.faces[facenum++] = this.loadPatch('STFGOD0');
    // Dead
    this.faces[facenum++] = this.loadPatch('STFDEAD0');

    // HUD font (STCFN033–STCFN095, ASCII 33 '!' through 95 '_')
    for (let i = 33; i <= 95; i++) {
      const name = `STCFN${i.toString().padStart(3, '0')}`;
      const p = this.loadPatch(name);
      if (p) this.fontPatches.set(i, p);
    }
  }

  /**
   * Initialize face state for a new level/player.
   * Called once when level starts.
   */
  initFace(player: Player): void {
    this.st_faceindex = 0;
    this.st_facecount = ST_STRAIGHTFACECOUNT;
    this.st_oldhealth = -1;
    this.priority = 0;
    this.lastattackdown = -1;
    this.oldweaponsowned = [...player.weaponowned];
  }

  // ===========================================================
  // ST_calcPainOffset — identical to DOOM's function
  // Returns the base face index for the current health tier
  // ===========================================================
  private calcPainOffset(health: number): number {
    const h = health > 100 ? 100 : health;
    return ST_FACESTRIDE * (Math.floor(((100 - h) * ST_NUMPAINFACES) / 101));
  }

  // ===========================================================
  // ST_updateFaceWidget — direct port from DOOM's st_stuff.c
  // Precedence: dead > evil grin > damage turn > self-damage >
  //             rapid fire > god mode > idle random
  // ===========================================================
  private updateFaceWidget(player: Player): void {
    // Generate a random number each tick (0-255)
    this.st_randomnumber = Math.floor(Math.random() * 256);

    // Priority 10: Dead
    if (this.priority < 10) {
      if (player.health <= 0) {
        this.priority = 9;
        this.st_faceindex = ST_DEADFACE;
        this.st_facecount = 1;
      }
    }

    // Priority 9: Evil grin (picked up a weapon)
    if (this.priority < 9) {
      if (player.bonuscount) {
        let doevilgrin = false;
        for (let i = 0; i < player.weaponowned.length; i++) {
          if (this.oldweaponsowned[i] !== player.weaponowned[i]) {
            doevilgrin = true;
            this.oldweaponsowned[i] = player.weaponowned[i];
          }
        }
        if (doevilgrin) {
          this.priority = 8;
          this.st_facecount = ST_EVILGRINCOUNT;
          this.st_faceindex = this.calcPainOffset(player.health) + ST_EVILGRINOFFSET;
        }
      }
    }

    // Priority 8: Being attacked by someone else
    if (this.priority < 8) {
      if (player.damagecount) {
        // No attacker tracking yet, so treat all damage as self-inflicted
        // (falls through to priority 7 below)
      }
    }

    // Priority 7: Self-damage (own stupidity)
    if (this.priority < 7) {
      if (player.damagecount) {
        if (this.st_oldhealth - player.health > ST_MUCHPAIN) {
          this.priority = 7;
          this.st_facecount = ST_TURNCOUNT;
          this.st_faceindex = this.calcPainOffset(player.health) + ST_OUCHOFFSET;
        } else {
          this.priority = 6;
          this.st_facecount = ST_TURNCOUNT;
          this.st_faceindex = this.calcPainOffset(player.health) + ST_RAMPAGEOFFSET;
        }
      }
    }

    // Priority 6: Rapid firing (rampage)
    if (this.priority < 6) {
      if (player.attackdown) {
        if (this.lastattackdown === -1) {
          this.lastattackdown = ST_RAMPAGEDELAY;
        } else if (--this.lastattackdown === 0) {
          this.priority = 5;
          this.st_faceindex = this.calcPainOffset(player.health) + ST_RAMPAGEOFFSET;
          this.st_facecount = 1;
          this.lastattackdown = 1;
        }
      } else {
        this.lastattackdown = -1;
      }
    }

    // Priority 5: God mode / invulnerability
    if (this.priority < 5) {
      if (player.cheats & CF_GODMODE) {
        this.priority = 4;
        this.st_faceindex = ST_GODFACE;
        this.st_facecount = 1;
      }
    }

    // Default: random idle face when facecount expires
    if (this.st_facecount <= 0) {
      this.st_faceindex = this.calcPainOffset(player.health) + (this.st_randomnumber % 3);
      this.st_facecount = ST_STRAIGHTFACECOUNT;
      this.priority = 0;
    }

    this.st_facecount--;

    // Update old state for next tick's comparison
    this.st_oldhealth = player.health;
  }

  // ===========================================================
  // HUD message (HU_Ticker from hu_stuff.c)
  // ===========================================================
  tickMessage(player: Player): void {
    // Tick down message counter
    if (this.messageCounter > 0) {
      this.messageCounter--;
      if (this.messageCounter === 0) {
        this.messageText = null;
      }
    }

    // Check for new message from player
    if (player.message) {
      this.messageText = player.message;
      player.message = null;
      this.messageCounter = HU_MSGTIMEOUT;
    }
  }

  // ===========================================================
  // Draw — main entry point, called every frame
  // ===========================================================
  draw(player: Player): void {
    const pal = this.palData.rgbaLookup;
    const scale = getScale();
    const stbarHeight = Math.round(STBAR_HEIGHT_ORIG * scale);
    const baseY = SCREENHEIGHT - stbarHeight;

    // Initialize old weapons tracking if needed
    if (this.oldweaponsowned.length === 0 && player.weaponowned.length > 0) {
      this.oldweaponsowned = [...player.weaponowned];
    }

    // Update face animation state
    this.updateFaceWidget(player);

    // --- STBAR background (centered via drawPatchScaled offset) ---
    if (this.stbarPatch) {
      this.drawPatchScaled(this.stbarPatch, 0, baseY, pal, scale, false);
    } else {
      // Fallback: grey bar in UI area only
      const ox = getUIOffsetX();
      const uw = getUIWidth();
      for (let fy = baseY; fy < SCREENHEIGHT; fy++) {
        for (let fx = ox; fx < ox + uw; fx++) {
          rgbaBuffer[fy * SCREENWIDTH + fx] = 0xFF333333;
        }
      }
    }

    // --- Arms background (overlays part of STBAR) ---
    if (this.armsBg) {
      this.drawPatchScaled(this.armsBg, Math.round(ST_ARMSBGX * scale), baseY + Math.round(ST_ARMSBGY * scale), pal, scale, false);
    }

    // --- Face sprite ---
    this.drawFace(baseY, pal, scale);

    // --- Current Ammo (big red number) ---
    if (this.bigRedNums.length === 10) {
      const ammoType = weaponinfo[player.readyweapon]?.ammo;
      if (ammoType !== undefined && ammoType !== AmmoType.noammo && ammoType >= 0) {
        this.drawBigNumber(
          player.ammo[ammoType],
          Math.round(ST_AMMOX * scale),
          baseY + Math.round(ST_AMMOY * scale),
          pal, scale, 3
        );
      }
    }

    // --- Health ---
    if (this.bigRedNums.length === 10) {
      this.drawBigNumber(
        player.health,
        Math.round(ST_HEALTHX * scale),
        baseY + Math.round(ST_HEALTHY * scale),
        pal, scale, 3
      );
      if (this.percentPatch) {
        this.drawPatchScaled(this.percentPatch, Math.round(ST_HEALTHX * scale), baseY + Math.round(ST_HEALTHY * scale), pal, scale, false);
      }
    }

    // --- Arms panel (weapons 2-7) ---
    this.drawArms(player, baseY, pal, scale);

    // --- Armor ---
    if (this.bigRedNums.length === 10) {
      this.drawBigNumber(
        player.armor,
        Math.round(ST_ARMORX * scale),
        baseY + Math.round(ST_ARMORY * scale),
        pal, scale, 3
      );
      if (this.percentPatch) {
        this.drawPatchScaled(this.percentPatch, Math.round(ST_ARMORX * scale), baseY + Math.round(ST_ARMORY * scale), pal, scale, false);
      }
    }

    // --- Keys ---
    this.drawKeys(player, baseY, pal, scale);

    // --- Ammo tallies (right side, small yellow numbers) ---
    this.drawAmmoTallies(player, baseY, pal, scale);

    // --- HUD message (top-left, above 3D view) ---
    this.drawMessage(pal, scale);
  }

  // ===========================================================
  // Arms Panel
  // ===========================================================
  private drawArms(player: Player, baseY: number, pal: Uint32Array, scale: number): void {
    for (let i = 0; i < 6; i++) {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const weaponIdx = i + 1;

      const owned = weaponIdx < player.weaponowned.length && player.weaponowned[weaponIdx];

      const ax = Math.round((ST_ARMSX + col * ST_ARMSXSPACE) * scale);
      const ay = baseY + Math.round((ST_ARMSY + row * ST_ARMSYSPACE) * scale);

      if (owned && this.yellowNums.length === 10) {
        // Yellow number (owned) — digit is i+2 (keys 2-7)
        const digit = i + 2;
        if (digit < 10) {
          this.drawPatchScaled(this.yellowNums[digit], ax, ay, pal, scale, false);
        }
      } else if (i < this.greyNums.length) {
        // Grey number (not owned)
        this.drawPatchScaled(this.greyNums[i], ax, ay, pal, scale, false);
      }
    }
  }

  // ===========================================================
  // Face Widget
  // ===========================================================
  private drawFace(baseY: number, pal: Uint32Array, scale: number): void {
    const facePatch = this.st_faceindex >= 0 && this.st_faceindex < this.faces.length
      ? this.faces[this.st_faceindex]
      : null;

    if (facePatch) {
      this.drawPatchScaled(
        facePatch,
        Math.round(ST_FACESX * scale),
        baseY + Math.round(ST_FACESY * scale),
        pal, scale, true, baseY
      );
    }
  }

  // ===========================================================
  // Key Indicators
  // ===========================================================
  private drawKeys(player: Player, baseY: number, pal: Uint32Array, scale: number): void {
    const keyPositions = [
      { x: ST_KEY0X, y: ST_KEY0Y, card: 0, skull: 3 },
      { x: ST_KEY1X, y: ST_KEY1Y, card: 1, skull: 4 },
      { x: ST_KEY2X, y: ST_KEY2Y, card: 2, skull: 5 },
    ];

    for (const kp of keyPositions) {
      const kx = Math.round(kp.x * scale);
      const ky = baseY + Math.round(kp.y * scale);

      if (player.keys[kp.skull] && this.keyPatches[kp.skull]) {
        this.drawPatchScaled(this.keyPatches[kp.skull]!, kx, ky, pal, scale, false);
      } else if (player.keys[kp.card] && this.keyPatches[kp.card]) {
        this.drawPatchScaled(this.keyPatches[kp.card]!, kx, ky, pal, scale, false);
      }
    }
  }

  // ===========================================================
  // Ammo Tallies (small yellow numbers, right side)
  // ===========================================================
  private drawAmmoTallies(player: Player, baseY: number, pal: Uint32Array, scale: number): void {
    if (this.yellowNums.length < 10) return;

    const ammoRows = [
      { type: AmmoType.clip, y: ST_AMMO0Y, my: ST_MAXAMMO0Y },
      { type: AmmoType.shell, y: ST_AMMO1Y, my: ST_MAXAMMO1Y },
      { type: AmmoType.cell, y: ST_AMMO2Y, my: ST_MAXAMMO2Y },
      { type: AmmoType.misl, y: ST_AMMO3Y, my: ST_MAXAMMO3Y },
    ];

    for (const row of ammoRows) {
      this.drawSmallNumber(
        player.ammo[row.type] ?? 0,
        Math.round(ST_AMMO0X * scale),
        baseY + Math.round(row.y * scale),
        pal, scale, 3
      );
      this.drawSmallNumber(
        player.maxammo[row.type] ?? 0,
        Math.round(ST_MAXAMMO0X * scale),
        baseY + Math.round(row.my * scale),
        pal, scale, 3
      );
    }
  }

  // ===========================================================
  // Number Drawing
  // ===========================================================

  private drawBigNumber(value: number, x: number, y: number, pal: Uint32Array, scale: number, maxDigits: number): void {
    if (this.bigRedNums.length < 10) return;
    this.drawNumberImpl(value, x, y, this.bigRedNums, pal, scale, maxDigits);
  }

  private drawSmallNumber(value: number, x: number, y: number, pal: Uint32Array, scale: number, maxDigits: number): void {
    if (this.yellowNums.length < 10) return;
    this.drawNumberImpl(value, x, y, this.yellowNums, pal, scale, maxDigits);
  }

  private drawNumberImpl(
    value: number, x: number, y: number,
    nums: Patch[], pal: Uint32Array, scale: number, _maxDigits: number
  ): void {
    const str = Math.abs(Math.floor(value)).toString();
    const digitWidth = Math.round(nums[0].width * scale);

    // Right-aligned: x is the right edge of the number area
    let dx = x - digitWidth;

    for (let i = str.length - 1; i >= 0; i--) {
      const digit = parseInt(str[i]);
      if (digit >= 0 && digit <= 9) {
        this.drawPatchScaled(nums[digit], dx, y, pal, scale, false);
      }
      dx -= digitWidth;
    }

    if (value < 0 && this.minusPatch) {
      this.drawPatchScaled(this.minusPatch, dx, y, pal, scale, false);
    }
  }

  // ===========================================================
  // Patch Rendering
  // ===========================================================

  /**
   * Draw a patch with nearest-neighbor scaling.
   * @param applyOffset If true, subtracts leftOffset/topOffset (V_DrawPatch style)
   * @param clipMinY Optional minimum Y; pixels above this are clipped (for face area)
   */
  private drawPatchScaled(
    patch: Patch, x: number, y: number,
    pal: Uint32Array, scale: number,
    applyOffset: boolean,
    clipMinY: number = 0
  ): void {
    x += getUIOffsetX(); // Center within UI area for widescreen

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
            if (screenY < clipMinY || screenY >= SCREENHEIGHT) continue;

            const pixel = post.data[dy];
            rgbaBuffer[screenY * SCREENWIDTH + screenX] = pal[pixel];
          }
        }
      }
    }
  }

  // ===========================================================
  // HUD Message Drawing
  // ===========================================================
  private drawMessage(pal: Uint32Array, scale: number): void {
    if (!this.messageText) return;

    let cx = 0; // HU_MSGX = 0
    const y = 0; // HU_MSGY = 0
    const text = this.messageText.toUpperCase();

    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);

      if (charCode === 32) {
        cx += Math.round(4 * scale);
        continue;
      }

      const patch = this.fontPatches.get(charCode);
      if (!patch) {
        cx += Math.round(4 * scale);
        continue;
      }

      // Draw without offset subtraction (raw position, not V_DrawPatch)
      this.drawPatchScaled(patch, cx, y, pal, scale, false);
      cx += Math.round(patch.width * scale);
    }
  }
}
