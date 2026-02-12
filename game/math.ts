// ============================================================
// Fixed-Point Math & Lookup Tables
// Reference: m_fixed.c, tables.c, tables.h
// ============================================================

// Fixed-point: 16.16 format
export const FRACBITS = 16;
export const FRACUNIT = 1 << FRACBITS; // 65536

// Angles - BAM (Binary Angle Measurement)
// Full circle = 0x100000000 (2^32) but stored as uint32
export const ANG45  = 0x20000000;
export const ANG90  = 0x40000000;
export const ANG180 = 0x80000000;
export const ANG270 = 0xC0000000;

export const ANGLETOFINESHIFT = 19; // 0x100000000 >> 13 = 8192 fine angles
export const FINEANGLES = 8192;
export const FINEMASK = FINEANGLES - 1;
export const DBITS = 6; // for SlopeDiv

export const SLOPERANGE = 2048;
export const SLOPEBITS = 11;

// Pre-computed tables
export const finesine = new Int32Array(10240); // 5*FINEANGLES/4
export const finetangent = new Int32Array(4096); // FINEANGLES/2
export const tantoangle = new Uint32Array(2049); // SLOPERANGE+1

// finecosine is just a pointer offset into finesine by FINEANGLES/4
// In original DOOM: finecosine = &finesine[FINEANGLES/4]
// finesine has 10240 entries (5*FINEANGLES/4 = 5*8192/4 = 10240)
// So finecosine[i] = finesine[i + 2048], valid for i in [0, 8191]
export function finecosine(idx: number): number {
  return finesine[((idx & FINEMASK) + FINEANGLES / 4)];
}

// Initialize lookup tables
export function initTables(): void {
  // finesine: 5*FINEANGLES/4 = 10240 entries
  for (let i = 0; i < 10240; i++) {
    const a = (i + 0.5) * Math.PI * 2 / FINEANGLES;
    finesine[i] = Math.round(FRACUNIT * Math.sin(a));
  }

  // finetangent: FINEANGLES/2 = 4096 entries
  for (let i = 0; i < FINEANGLES / 2; i++) {
    const a = (i - FINEANGLES / 4 + 0.5) * Math.PI * 2 / FINEANGLES;
    finetangent[i] = Math.round(FRACUNIT * Math.tan(a));
  }

  // tantoangle: SLOPERANGE+1 = 2049 entries
  for (let i = 0; i <= SLOPERANGE; i++) {
    const f = Math.atan(i / SLOPERANGE) / (Math.PI * 2);
    tantoangle[i] = (f * 0x100000000) >>> 0;
  }
}

// Fixed-point multiplication: (a * b) >> 16
// Using Math.imul and decomposition to avoid overflow without BigInt
export function fixedMul(a: number, b: number): number {
  // Coerce undefined/NaN to 0
  a = a || 0;
  b = b || 0;
  // For values that fit in safe integer range, use direct multiplication
  const result = a * (b >> FRACBITS) + a * ((b & 0xFFFF) / FRACUNIT);
  return result | 0;
}

// Fixed-point division: (a << 16) / b
export function fixedDiv(a: number, b: number): number {
  a = a || 0;
  b = b || 0;
  if (b === 0) return a >= 0 ? 0x7FFFFFFF : -0x7FFFFFFF;
  // Check for overflow
  const abs_a = Math.abs(a);
  if ((abs_a >>> 14) >= Math.abs(b)) {
    return (a ^ b) < 0 ? -0x7FFFFFFF : 0x7FFFFFFF;
  }
  return (a / b * FRACUNIT) | 0;
}

// SlopeDiv for angle calculation
export function slopeDiv(num: number, den: number): number {
  if (den < 512) return SLOPERANGE;
  const ans = Math.min((num << 3) / (den >>> 8), SLOPERANGE);
  return ans >>> 0;
}

// R_PointToAngle equivalent
export function pointToAngle(viewx: number, viewy: number, x: number, y: number): number {
  x -= viewx;
  y -= viewy;

  if (x === 0 && y === 0) return 0;

  if (x >= 0) {
    if (y >= 0) {
      if (x > y) return tantoangle[slopeDiv(y, x)];
      else return (ANG90 - 1 - tantoangle[slopeDiv(x, y)]) >>> 0;
    } else {
      y = -y;
      if (x > y) return (-tantoangle[slopeDiv(y, x)]) >>> 0;
      else return (ANG270 + tantoangle[slopeDiv(x, y)]) >>> 0;
    }
  } else {
    x = -x;
    if (y >= 0) {
      if (x > y) return (ANG180 - 1 - tantoangle[slopeDiv(y, x)]) >>> 0;
      else return (ANG90 + tantoangle[slopeDiv(x, y)]) >>> 0;
    } else {
      y = -y;
      if (x > y) return (ANG180 + tantoangle[slopeDiv(y, x)]) >>> 0;
      else return (ANG270 - 1 - tantoangle[slopeDiv(x, y)]) >>> 0;
    }
  }
}

// Clamp to 32-bit signed integer
export function int32(v: number): number {
  return v | 0;
}

// Unsigned 32-bit
export function uint32(v: number): number {
  return v >>> 0;
}
