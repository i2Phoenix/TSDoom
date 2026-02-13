// ============================================================
// ENDOOM Screen Renderer
// Renders the ENDOOM lump (DOS text mode 80x25) to an RGBA buffer.
// Reference: original DOOM's I_Endoom / d_main.c
// ============================================================

// ── CGA 16-color palette (standard DOS text mode) ───────────
const CGA_PALETTE: number[] = [
  0xFF000000, // 0  Black
  0xFFAA0000, // 1  Blue
  0xFF00AA00, // 2  Green
  0xFFAAAA00, // 3  Cyan
  0xFF0000AA, // 4  Red
  0xFFAA00AA, // 5  Magenta
  0xFF0055AA, // 6  Brown
  0xFFAAAAAA, // 7  Light Gray
  0xFF555555, // 8  Dark Gray
  0xFFFF5555, // 9  Light Blue
  0xFF55FF55, // 10 Light Green
  0xFFFFFF55, // 11 Light Cyan
  0xFF5555FF, // 12 Light Red
  0xFFFF55FF, // 13 Light Magenta
  0xFF55FFFF, // 14 Yellow
  0xFFFFFFFF, // 15 White
];

// ── CP437 → Unicode mapping (0x00–0xFF) ─────────────────────
// Characters 0x20–0x7E map to ASCII directly.
// Characters outside that range use special symbols.
const CP437_MAP: string[] = [
  // 0x00–0x0F
  ' ', '☺', '☻', '♥', '♦', '♣', '♠', '•',
  '◘', '○', '◙', '♂', '♀', '♪', '♫', '☼',
  // 0x10–0x1F
  '►', '◄', '↕', '‼', '¶', '§', '▬', '↨',
  '↑', '↓', '→', '←', '∟', '↔', '▲', '▼',
  // 0x20–0x7E — standard ASCII
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)),
  // 0x7F
  '⌂',
  // 0x80–0x8F
  'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç',
  'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å',
  // 0x90–0x9F
  'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û', 'ù',
  'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ',
  // 0xA0–0xAF
  'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º',
  '¿', '⌐', '¬', '½', '¼', '¡', '«', '»',
  // 0xB0–0xBF — box-drawing light
  '░', '▒', '▓', '│', '┤', '╡', '╢', '╖',
  '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐',
  // 0xC0–0xCF
  '└', '┴', '┬', '├', '─', '┼', '╞', '╟',
  '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧',
  // 0xD0–0xDF
  '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫',
  '╪', '┘', '┌', '█', '▄', '▌', '▐', '▀',
  // 0xE0–0xEF
  'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ',
  'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩',
  // 0xF0–0xFF
  '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈',
  '°', '∙', '·', '√', 'ⁿ', '²', '■', ' ',
];

// ── ENDOOM dimensions ───────────────────────────────────────
const ENDOOM_COLS = 80;
const ENDOOM_ROWS = 25;
const ENDOOM_SIZE = ENDOOM_COLS * ENDOOM_ROWS * 2; // 4000 bytes

// Native pixel resolution of the rendered ENDOOM
const CHAR_W = 8;
const CHAR_H = 16;
const NATIVE_W = ENDOOM_COLS * CHAR_W;  // 640
const NATIVE_H = ENDOOM_ROWS * CHAR_H;  // 400

/**
 * Render an ENDOOM lump to an RGBA pixel buffer at native 640×400 resolution.
 * Uses an offscreen canvas for text rendering with a monospace font.
 *
 * @param data  The raw ENDOOM lump data (4000 bytes)
 * @returns     RGBA pixel buffer (640×400) as Uint32Array, or null on failure
 */
export function renderEndoom(data: Uint8Array): Uint32Array | null {
  if (data.length < ENDOOM_SIZE) {
    console.warn(`[endoom] ENDOOM lump too small: ${data.length} bytes (need ${ENDOOM_SIZE})`);
    return null;
  }

  // Create offscreen canvas at native DOS text-mode resolution
  const canvas = document.createElement('canvas');
  canvas.width = NATIVE_W;
  canvas.height = NATIVE_H;
  const ctx = canvas.getContext('2d')!;

  // Configure text rendering
  ctx.textBaseline = 'top';
  ctx.imageSmoothingEnabled = false;

  // Use a monospace font — try common options
  const fontFamily = '"Courier New", "Lucida Console", "Consolas", monospace';
  const fontSize = CHAR_H; // 16px

  // Render each cell
  for (let row = 0; row < ENDOOM_ROWS; row++) {
    for (let col = 0; col < ENDOOM_COLS; col++) {
      const offset = (row * ENDOOM_COLS + col) * 2;
      const charCode = data[offset];
      const attr = data[offset + 1];

      // Attribute byte: [blink:1][bg:3][fg:4]
      const fgIdx = attr & 0x0F;
      const bgIdx = (attr >> 4) & 0x07; // ignore blink bit

      const x = col * CHAR_W;
      const y = row * CHAR_H;

      // Draw background
      const bgColor = CGA_PALETTE[bgIdx];
      const bgR = (bgColor >> 0) & 0xFF;
      const bgG = (bgColor >> 8) & 0xFF;
      const bgB = (bgColor >> 16) & 0xFF;
      ctx.fillStyle = `rgb(${bgR},${bgG},${bgB})`;
      ctx.fillRect(x, y, CHAR_W, CHAR_H);

      // Draw character
      const ch = CP437_MAP[charCode] || ' ';
      if (ch !== ' ') {
        const fgColor = CGA_PALETTE[fgIdx];
        const fgR = (fgColor >> 0) & 0xFF;
        const fgG = (fgColor >> 8) & 0xFF;
        const fgB = (fgColor >> 16) & 0xFF;
        ctx.fillStyle = `rgb(${fgR},${fgG},${fgB})`;
        ctx.font = `${fontSize}px ${fontFamily}`;
        ctx.fillText(ch, x, y);
      }
    }
  }

  // Read pixel data and convert to Uint32Array (ABGR)
  const imgData = ctx.getImageData(0, 0, NATIVE_W, NATIVE_H);
  const pixels = new Uint32Array(imgData.data.buffer);

  // Convert from RGBA to ABGR (canvas gives RGBA bytes, we need 0xAABBGGRR packed)
  // Actually canvas ImageData is RGBA byte order, and Uint32Array view on
  // little-endian systems gives 0xAABBGGRR which matches our rgbaBuffer format.
  // No conversion needed!

  return pixels;
}

/**
 * Scale-blit the rendered ENDOOM (640×400) into the game's RGBA buffer at
 * arbitrary resolution, using nearest-neighbor scaling.
 */
export function blitEndoomToScreen(
  endoomPixels: Uint32Array,
  destBuffer: Uint32Array,
  destW: number,
  destH: number,
): void {
  for (let dy = 0; dy < destH; dy++) {
    const sy = Math.floor(dy * NATIVE_H / destH);
    const srcRowOff = sy * NATIVE_W;
    const dstRowOff = dy * destW;
    for (let dx = 0; dx < destW; dx++) {
      const sx = Math.floor(dx * NATIVE_W / destW);
      destBuffer[dstRowOff + dx] = endoomPixels[srcRowOff + sx];
    }
  }
}
