// ============================================================
// WAD Resource Extractor
// Извлекает текстуры, флаты, спрайты, патчи, графику и звуки
// из WAD файлов (IWAD/PWAD) в формате PNG/WAV
//
// Использование: npx tsx tools/wad-extract.ts <wad-file> [output-dir]
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { WAD } from '../src/wad';
import { TextureData, type Patch, type PatchColumn, type Post } from '../src/textures';
import { PaletteData } from '../src/palette';

// ============================================================
// Minimal PNG Encoder (без внешних зависимостей, использует node:zlib)
// ============================================================

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function encodePNG(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const rowSize = 1 + width * 4;
  const raw = new Uint8Array(height * rowSize);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0; // filter: None
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * rowSize + 1);
  }
  const compressed = deflateSync(Buffer.from(raw));

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = pngChunk('IHDR', ihdr);
  const idatChunk = pngChunk('IDAT', new Uint8Array(compressed));
  const iendChunk = pngChunk('IEND', new Uint8Array(0));

  const result = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  );
  let off = 0;
  result.set(signature, off); off += signature.length;
  result.set(ihdrChunk, off); off += ihdrChunk.length;
  result.set(idatChunk, off); off += idatChunk.length;
  result.set(iendChunk, off);
  return result;
}

// ============================================================
// WAV Encoder (unsigned 8-bit PCM mono)
// ============================================================

function encodeWAV(sampleRate: number, samples: Uint8Array): Uint8Array {
  const dataSize = samples.length;
  const wav = new Uint8Array(44 + dataSize);
  const view = new DataView(wav.buffer);

  wav.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  wav.set([0x66, 0x6D, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true);            // subchunk size
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);    // byte rate
  view.setUint16(32, 1, true);             // block align
  view.setUint16(34, 8, true);             // bits per sample
  wav.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataSize, true);
  wav.set(samples, 44);
  return wav;
}

// ============================================================
// Render helpers
// ============================================================

interface RGB { r: number; g: number; b: number }

function getBasePalette(palData: PaletteData): RGB[] {
  const pal = palData.palettes[0];
  const result: RGB[] = [];
  for (let i = 0; i < 256; i++) {
    const rgba = pal[i];
    result.push({
      r: rgba & 0xFF,
      g: (rgba >> 8) & 0xFF,
      b: (rgba >> 16) & 0xFF,
    });
  }
  return result;
}

function renderPatchToRGBA(patch: Patch, palette: RGB[]): Uint8Array {
  const rgba = new Uint8Array(patch.width * patch.height * 4);
  for (let x = 0; x < patch.width; x++) {
    const col = patch.columns[x];
    for (const post of col) {
      for (let dy = 0; dy < post.length; dy++) {
        const y = post.topDelta + dy;
        if (y >= 0 && y < patch.height) {
          const idx = (y * patch.width + x) * 4;
          const c = palette[post.data[dy]];
          rgba[idx] = c.r;
          rgba[idx + 1] = c.g;
          rgba[idx + 2] = c.b;
          rgba[idx + 3] = 255;
        }
      }
    }
  }
  return rgba;
}

function renderTextureToRGBA(
  tex: { width: number; height: number; columns: Uint8Array[]; columnMask: Uint8Array[] },
  palette: RGB[],
): Uint8Array {
  const rgba = new Uint8Array(tex.width * tex.height * 4);
  for (let x = 0; x < tex.width; x++) {
    const col = tex.columns[x];
    const mask = tex.columnMask[x];
    for (let y = 0; y < tex.height; y++) {
      if (mask[y]) {
        const idx = (y * tex.width + x) * 4;
        const c = palette[col[y]];
        rgba[idx] = c.r;
        rgba[idx + 1] = c.g;
        rgba[idx + 2] = c.b;
        rgba[idx + 3] = 255;
      }
    }
  }
  return rgba;
}

function renderFlatToRGBA(data: Uint8Array, palette: RGB[]): Uint8Array {
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 4096; i++) {
    const c = palette[data[i]];
    rgba[i * 4] = c.r;
    rgba[i * 4 + 1] = c.g;
    rgba[i * 4 + 2] = c.b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

// ============================================================
// Patch detection (для standalone графики вне маркеров)
// ============================================================

function tryParsePatch(data: Uint8Array): Patch | null {
  if (data.length < 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const width = view.getInt16(0, true);
  const height = view.getInt16(2, true);
  if (width <= 0 || width > 2048 || height <= 0 || height > 2048) return null;

  const headerSize = 8 + width * 4;
  if (data.length < headerSize) return null;

  // Все смещения колонок должны быть в пределах данных
  for (let x = 0; x < width; x++) {
    const colOff = view.getUint32(8 + x * 4, true);
    if (colOff < headerSize || colOff >= data.length) return null;
  }

  try {
    const leftOffset = view.getInt16(4, true);
    const topOffset = view.getInt16(6, true);
    const columns: PatchColumn[] = [];

    for (let x = 0; x < width; x++) {
      const colOff = view.getUint32(8 + x * 4, true);
      const posts: Post[] = [];
      let ptr = colOff;
      let safety = 0;

      while (safety++ < 256) {
        if (ptr >= data.length) return null;
        const topDelta = data[ptr++];
        if (topDelta === 0xFF) break;
        if (ptr >= data.length) return null;
        const length = data[ptr++];
        ptr++; // padding
        if (ptr + length > data.length) return null;
        posts.push({ topDelta, length, data: data.slice(ptr, ptr + length) });
        ptr += length;
        ptr++; // padding
      }
      columns.push(posts);
    }

    return { width, height, leftOffset, topOffset, columns };
  } catch {
    return null;
  }
}

// ============================================================
// Lumps to skip
// ============================================================

const MAP_LUMPS = new Set([
  'THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS',
  'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP',
  'BEHAVIOR', 'SCRIPTS', 'GL_VERT', 'GL_SEGS', 'GL_SSECT', 'GL_NODES',
]);

const SKIP_LUMPS = new Set([
  'PLAYPAL', 'COLORMAP', 'TEXTURE1', 'TEXTURE2', 'PNAMES',
  'GENMIDI', 'DMXGUS', 'ENDOOM', 'DEHACKED',
]);

// ============================================================
// Main
// ============================================================

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('WAD Resource Extractor');
    console.log('');
    console.log('Usage: npx tsx tools/wad-extract.ts <wad-file> [output-dir]');
    console.log('');
    console.log('  wad-file    Path to WAD file (IWAD or PWAD)');
    console.log('  output-dir  Output directory (default: ./wad-output)');
    console.log('');
    console.log('Flags:');
    console.log('  --raw       Also extract raw lump data to raw/');
    console.log('  --no-tex    Skip composite texture extraction');
    console.log('  --list      Only list lump directory, do not extract');
    console.log('');
    console.log('Output structure:');
    console.log('  textures/   Composite wall textures (TEXTURE1/TEXTURE2)');
    console.log('  flats/      Floor/ceiling textures (64x64)');
    console.log('  sprites/    Sprite frames (S_START..S_END)');
    console.log('  patches/    Texture patches (P_START..P_END)');
    console.log('  graphics/   UI graphics, title screens, etc.');
    console.log('  sounds/     Sound effects as WAV');
    process.exit(0);
  }

  const positional = args.filter(a => !a.startsWith('--'));
  const wadPath = positional[0];
  const outputDir = positional[1] || './wad-output';
  const extractRaw = args.includes('--raw');
  const skipTextures = args.includes('--no-tex');
  const listOnly = args.includes('--list');

  if (!wadPath) {
    console.error('Error: path to WAD file is required');
    process.exit(1);
  }
  if (!fs.existsSync(wadPath)) {
    console.error(`Error: file not found: ${wadPath}`);
    process.exit(1);
  }

  // --- Read WAD ---
  console.log(`Reading: ${wadPath}`);
  const fileBuffer = fs.readFileSync(wadPath);
  const arrayBuffer = fileBuffer.buffer.slice(
    fileBuffer.byteOffset,
    fileBuffer.byteOffset + fileBuffer.byteLength,
  );
  const wad = new WAD(arrayBuffer);

  // --- List mode ---
  if (listOnly) {
    console.log('');
    console.log('  #   NAME       SIZE     OFFSET');
    console.log('  --- -------- -------- --------');
    for (let i = 0; i < wad.lumps.length; i++) {
      const l = wad.lumps[i];
      const idx = String(i).padStart(3);
      const name = l.name.padEnd(8);
      const size = String(l.size).padStart(8);
      const off = String(l.offset).padStart(8);
      console.log(`  ${idx} ${name} ${size} ${off}`);
    }
    console.log(`\n  Total: ${wad.lumps.length} lumps`);
    process.exit(0);
  }

  // --- Load palette and texture data ---
  const palData = new PaletteData(wad);
  const palette = getBasePalette(palData);
  const texData = new TextureData(wad);

  // --- Create output directories ---
  const dirs = {
    textures: path.join(outputDir, 'textures'),
    flats: path.join(outputDir, 'flats'),
    sprites: path.join(outputDir, 'sprites'),
    patches: path.join(outputDir, 'patches'),
    graphics: path.join(outputDir, 'graphics'),
    sounds: path.join(outputDir, 'sounds'),
    raw: path.join(outputDir, 'raw'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  const stats = { textures: 0, flats: 0, sprites: 0, patches: 0, graphics: 0, sounds: 0, raw: 0 };

  // --- 1. Composite textures (TEXTURE1 / TEXTURE2) ---
  if (!skipTextures) {
    console.log('Extracting textures...');
    for (const tex of texData.textures) {
      try {
        const rgba = renderTextureToRGBA(tex, palette);
        const png = encodePNG(tex.width, tex.height, rgba);
        fs.writeFileSync(path.join(dirs.textures, `${tex.name}.png`), png);
        stats.textures++;
      } catch (e) {
        console.warn(`  [!] texture ${tex.name}: ${e}`);
      }
    }
    console.log(`  -> ${stats.textures} textures`);
  }

  // --- 2. Flats (F_START..F_END) ---
  console.log('Extracting flats...');
  for (const flat of texData.flatList) {
    try {
      const rgba = renderFlatToRGBA(flat.data, palette);
      const png = encodePNG(64, 64, rgba);
      fs.writeFileSync(path.join(dirs.flats, `${flat.name}.png`), png);
      stats.flats++;
    } catch (e) {
      console.warn(`  [!] flat ${flat.name}: ${e}`);
    }
  }
  console.log(`  -> ${stats.flats} flats`);

  // --- Find marker ranges ---
  const findRange = (starts: string[], ends: string[]): [number, number] => {
    let s = -1, e = -1;
    for (const n of starts) { s = wad.checkNumForName(n); if (s !== -1) break; }
    for (const n of ends) { e = wad.checkNumForName(n); if (e !== -1) break; }
    return [s, e];
  };

  const [sStart, sEnd] = findRange(['S_START', 'SS_START'], ['S_END', 'SS_END']);
  const [pStart, pEnd] = findRange(['P_START', 'PP_START'], ['P_END', 'PP_END']);
  const [fStart, fEnd] = findRange(['F_START', 'FF_START'], ['F_END', 'FF_END']);

  const inRange = new Set<number>();
  const markRange = (s: number, e: number) => {
    if (s !== -1 && e !== -1) for (let i = s; i <= e; i++) inRange.add(i);
  };
  markRange(sStart, sEnd);
  markRange(pStart, pEnd);
  markRange(fStart, fEnd);

  // --- 3. Sprites (S_START..S_END) ---
  console.log('Extracting sprites...');
  if (sStart !== -1 && sEnd !== -1) {
    for (let i = sStart + 1; i < sEnd; i++) {
      const lump = wad.lumps[i];
      if (lump.size === 0) continue;
      try {
        const patch = texData.parsePatchLump(i);
        const rgba = renderPatchToRGBA(patch, palette);
        const png = encodePNG(patch.width, patch.height, rgba);
        fs.writeFileSync(path.join(dirs.sprites, `${lump.name}.png`), png);
        stats.sprites++;
      } catch { /* skip invalid */ }
    }
  }
  console.log(`  -> ${stats.sprites} sprites`);

  // --- 4. Patches (P_START..P_END) ---
  console.log('Extracting patches...');
  if (pStart !== -1 && pEnd !== -1) {
    for (let i = pStart + 1; i < pEnd; i++) {
      const lump = wad.lumps[i];
      if (lump.size === 0) continue;
      if (lump.name.includes('_START') || lump.name.includes('_END')) continue;
      try {
        const patch = texData.parsePatchLump(i);
        const rgba = renderPatchToRGBA(patch, palette);
        const png = encodePNG(patch.width, patch.height, rgba);
        fs.writeFileSync(path.join(dirs.patches, `${lump.name}.png`), png);
        stats.patches++;
      } catch { /* skip invalid */ }
    }
  }
  console.log(`  -> ${stats.patches} patches`);

  // --- 5. Graphics & Sounds (остальные lumps) ---
  console.log('Extracting graphics & sounds...');
  let inMapRange = false;

  for (let i = 0; i < wad.lumps.length; i++) {
    const lump = wad.lumps[i];

    // Пропуск map-маркеров и их sub-lumps
    if (/^MAP\d{2}$/.test(lump.name) || /^E\dM\d$/.test(lump.name)) {
      inMapRange = true;
      continue;
    }
    if (inMapRange) {
      if (MAP_LUMPS.has(lump.name)) continue;
      inMapRange = false;
    }

    if (inRange.has(i)) continue;
    if (lump.size === 0) continue;
    if (SKIP_LUMPS.has(lump.name)) continue;

    // Звуки (DS* prefix) -> WAV
    if (lump.name.startsWith('DS')) {
      try {
        const data = wad.getLumpData(i);
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const format = dv.getUint16(0, true);
        if (format === 3 && data.length >= 8) {
          const sampleRate = dv.getUint16(2, true);
          const numSamples = dv.getUint32(4, true);
          const samples = data.slice(8, 8 + Math.min(numSamples, data.length - 8));
          const wav = encodeWAV(sampleRate, samples);
          fs.writeFileSync(path.join(dirs.sounds, `${lump.name}.wav`), wav);
          stats.sounds++;
        }
      } catch { /* skip */ }
      continue;
    }

    // Музыка (D_*) -> raw
    if (lump.name.startsWith('D_')) {
      if (extractRaw) {
        fs.writeFileSync(path.join(dirs.raw, `${lump.name}.mus`), wad.getLumpData(i));
        stats.raw++;
      }
      continue;
    }

    // Попытка распарсить как графический patch
    try {
      const data = wad.getLumpData(i);
      const patch = tryParsePatch(data);
      if (patch) {
        const rgba = renderPatchToRGBA(patch, palette);
        const png = encodePNG(patch.width, patch.height, rgba);
        fs.writeFileSync(path.join(dirs.graphics, `${lump.name}.png`), png);
        stats.graphics++;
        continue;
      }
    } catch { /* not a patch */ }

    // Raw dump
    if (extractRaw) {
      fs.writeFileSync(path.join(dirs.raw, `${lump.name}.lmp`), wad.getLumpData(i));
      stats.raw++;
    }
  }

  console.log(`  -> ${stats.graphics} graphics`);
  console.log(`  -> ${stats.sounds} sounds`);
  if (extractRaw) console.log(`  -> ${stats.raw} raw lumps`);

  // --- Summary ---
  console.log('');
  console.log('=== Extraction complete ===');
  console.log(`Output: ${path.resolve(outputDir)}`);
  console.log(`  Textures:  ${stats.textures}`);
  console.log(`  Flats:     ${stats.flats}`);
  console.log(`  Sprites:   ${stats.sprites}`);
  console.log(`  Patches:   ${stats.patches}`);
  console.log(`  Graphics:  ${stats.graphics}`);
  console.log(`  Sounds:    ${stats.sounds}`);
  if (extractRaw) console.log(`  Raw:       ${stats.raw}`);
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  console.log(`  Total:     ${total} files`);
}

main();
