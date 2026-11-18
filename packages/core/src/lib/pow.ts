/**
 * `pow(x, y)`: x to the power y, bit for bit the same on every JavaScript engine.
 *
 * The built-in `x ** y` / `Math.pow` is "implementation-approximated" in ECMAScript and its last bit differs between V8 versions (Node 22 vs
 * Node 24, the Electron renderer), so documents, state hashes and golden snapshots computed with it depend on the runtime. This is the fdlibm
 * 5.3 `e_pow.c` algorithm as V8 shipped it in `src/base/ieee754.cc` (the function Node 22 runs), transliterated from the project's Rust twin
 * `solver/crates/llull-jsmath` (`pow`): it uses only IEEE-754 additions, multiplications, divisions, `Math.sqrt` and bit operations, which
 * are exact everywhere. Small integer powers use `powInt` (plain products); `x ** 2` is exact and may stay.
 *
 * fdlibm notice (kept as its licence requires): Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
 * Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice is preserved.
 */

const F64 = new Float64Array(1);
const I32 = new Int32Array(F64.buffer);
const U32 = new Uint32Array(F64.buffer);
// index of the high / low 32-bit word of a double in this machine's byte order
F64[0] = 1;
const HI = I32[1] === 0x3ff00000 ? 1 : 0;
const LO = 1 - HI;

function high(x: number): number {
  F64[0] = x;
  return I32[HI] as number;
}

function low(x: number): number {
  F64[0] = x;
  return U32[LO] as number;
}

function lowSigned(x: number): number {
  F64[0] = x;
  return I32[LO] as number;
}

function withHigh(x: number, hi: number): number {
  F64[0] = x;
  I32[HI] = hi;
  return F64[0] as number;
}

function withLow(x: number, lo: number): number {
  F64[0] = x;
  U32[LO] = lo;
  return F64[0] as number;
}

const BP = [1.0, 1.5];
const DP_H = [0.0, 5.84962487220764160156e-1];
const DP_L = [0.0, 1.35003920212974897128e-8];
const TWO53 = 9007199254740992.0;
const HUGE = 1.0e300;
const TINY = 1.0e-300;
const L1 = 5.99999999999994648725e-1;
const L2 = 4.28571428578550184252e-1;
const L3 = 3.33333329818377432918e-1;
const L4 = 2.72728123808534006489e-1;
const L5 = 2.30660745775561754067e-1;
const L6 = 2.06975017800338417784e-1;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.6533902205465251539e-6;
const P5 = 4.13813679705723846039e-8;
const LG2 = 6.93147180559945286227e-1;
const LG2_H = 6.93147182464599609375e-1;
const LG2_L = -1.90465429995776804525e-9;
const OVT = 8.008566259537294e-17;
const CP = 9.61796693925975554329e-1;
const CP_H = 9.61796700954437255859e-1;
const CP_L = -7.02846165095275826516e-9;
const IVLN2 = 1.442695040888963387;
const IVLN2_H = 1.44269502162933349609;
const IVLN2_L = 1.92596299112661746887e-8;

/** `x * 2^n` (musl `scalbn`), for subnormal results only. */
function scalbn(value: number, exponent: number): number {
  const p1023 = withHigh(0, 0x7fe00000);
  const pm1022 = withHigh(0, 0x00100000);
  const p53 = withHigh(0, 0x43400000);
  let x = value;
  let n = exponent;
  if (n > 1023) {
    x *= p1023;
    n -= 1023;
    if (n > 1023) {
      x *= p1023;
      n -= 1023;
      n = Math.min(n, 1023);
    }
  } else if (n < -1022) {
    x *= pm1022 * p53;
    n += 1022 - 53;
    if (n < -1022) {
      x *= pm1022 * p53;
      n += 1022 - 53;
      n = Math.max(n, -1022);
    }
  }
  return x * withHigh(0, (0x3ff + n) << 20);
}

/** 0: y is not an integer, 1: y is an odd integer, 2: y is an even integer (only asked for a negative x). */
function integerClass(iy: number, ly: number): number {
  if (iy >= 0x43400000) return 2;
  if (iy < 0x3ff00000) return 0;
  const k = (iy >> 20) - 0x3ff;
  if (k > 20) {
    const j = ly >>> (52 - k);
    return (j << (52 - k)) >>> 0 === ly ? 2 - (j & 1) : 0;
  }
  if (ly !== 0) return 0;
  const j = iy >> (20 - k);
  return j << (20 - k) === iy ? 2 - (j & 1) : 0;
}

/** The result for y = ±inf, ±1, 2 and 0.5 (the low word of y is zero), or null when y is none of them. */
function specialExponent(x: number, y: number, hx: number, lx: number, ix: number, hy: number, iy: number): number | null {
  if (iy === 0x7ff00000) {
    if (((ix - 0x3ff00000) | lx) === 0) return y - y;
    if (ix >= 0x3ff00000) return hy >= 0 ? y : 0.0;
    return hy < 0 ? -y : 0.0;
  }
  if (iy === 0x3ff00000) return hy < 0 ? 1.0 / x : x;
  if (hy === 0x40000000) return x * x;
  if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x);
  return null;
}

/** The result for x = ±0, ±inf, ±1. */
function specialBase(ax: number, hx: number, ix: number, hy: number, yisint: number): number {
  let z = ax;
  if (hy < 0) z = 1.0 / z;
  if (hx < 0) {
    if (((ix - 0x3ff00000) | yisint) === 0) z = Number.NaN;
    else if (yisint === 1) z = -z;
  }
  return z;
}

// log2(ax) as a head and a tail (t1 + t2), written by the two helpers below
let logHead = 0;
let logTail = 0;

/** |y| is huge: over/underflow unless x is near 1; else log2(x) by a short series. Returns the final result, or null with logHead / logTail set. */
function hugeExponent(ax: number, ix: number, hy: number, iy: number, s: number): number | null {
  if (iy > 0x43f00000) {
    if (ix <= 0x3fefffff) return hy < 0 ? HUGE * HUGE : TINY * TINY;
    if (ix >= 0x3ff00000) return hy > 0 ? HUGE * HUGE : TINY * TINY;
  }
  if (ix < 0x3fefffff) return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY;
  if (ix > 0x3ff00000) return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY;
  const t = ax - 1.0;
  const w = t * t * (0.5 - t * (0.3333333333333333 - t * 0.25));
  const u = IVLN2_H * t;
  const v = t * IVLN2_L - w * IVLN2;
  logHead = withLow(u + v, 0);
  logTail = v - (logHead - u);
  return null;
}

/** log2(ax) for an ordinary |y|: sets logHead / logTail. */
function log2Parts(axIn: number, ixIn: number): void {
  let ax = axIn;
  let ix = ixIn;
  let n = 0;
  if (ix < 0x00100000) {
    ax *= TWO53;
    n -= 53;
    ix = high(ax);
  }
  n += (ix >> 20) - 0x3ff;
  const j = ix & 0x000fffff;
  ix = j | 0x3ff00000;
  let k = 0;
  if (j <= 0x3988e) k = 0;
  else if (j < 0xbb67a) k = 1;
  else {
    k = 0;
    n += 1;
    ix -= 0x00100000;
  }
  ax = withHigh(ax, ix);
  const bp = BP[k] as number;

  const u = ax - bp;
  const v = 1.0 / (ax + bp);
  const ss = u * v;
  const sH = withLow(ss, 0);
  const tH = withHigh(0.0, ((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18));
  const tL = ax - (tH - bp);
  const sL = v * (u - sH * tH - sH * tL);
  let s2 = ss * ss;
  let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
  r += sL * (sH + ss);
  s2 = sH * sH;
  const tH2 = withLow(3.0 + s2 + r, 0);
  const tL2 = r - (tH2 - 3.0 - s2);
  const u2 = sH * tH2;
  const v2 = sL * tH2 + tL2 * ss;
  const pH = withLow(u2 + v2, 0);
  const pL = v2 - (pH - u2);
  const zH = CP_H * pH;
  const zL = CP_L * pH + pL * CP + (DP_L[k] as number);
  const t = n;
  const dpH = DP_H[k] as number;
  logHead = withLow(zH + zL + dpH + t, 0);
  logTail = zL - (logHead - t - dpH - zH);
}

/** s * 2^(y * (t1 + t2)), with the overflow and underflow tests. */
function exp2Scaled(s: number, y: number, t1: number, t2: number): number {
  const y1 = withLow(y, 0);
  const pL = (y - y1) * t1 + y * t2;
  let pH = y1 * t1;
  let z = pL + pH;
  const j = high(z);
  const i = lowSigned(z);
  if (j >= 0x40900000) {
    if (((j - 0x40900000) | i) !== 0 || pL + OVT > z - pH) return s * HUGE * HUGE;
  } else if ((j & 0x7fffffff) >= 0x4090cc00 && (((j - (0xc090cc00 | 0)) | 0 | i) !== 0 || pL <= z - pH)) {
    return s * TINY * TINY;
  }

  const ia = j & 0x7fffffff;
  let k = (ia >> 20) - 0x3ff;
  let n = 0;
  if (ia > 0x3fe00000) {
    n = (j + (0x00100000 >> (k + 1))) | 0;
    k = ((n & 0x7fffffff) >> 20) - 0x3ff;
    const t = withHigh(0.0, n & ~(0x000fffff >> k));
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
    if (j < 0) n = -n;
    pH -= t;
  }
  const t = withLow(pL + pH, 0);
  const u = t * LG2_H;
  const v = (pL - (t - pH)) * LG2 + t * LG2_L;
  z = u + v;
  const w = v - (z - u);
  const tt = z * z;
  const t1p = z - tt * (P1 + tt * (P2 + tt * (P3 + tt * (P4 + tt * P5))));
  const r = (z * t1p) / (t1p - 2.0 - (w + z * w));
  z = 1.0 - (r - z);
  const scaled = (high(z) + (n << 20)) | 0;
  z = scaled >> 20 <= 0 ? scalbn(z, n) : withHigh(z, scaled);
  return s * z;
}

export function pow(x: number, y: number): number {
  const hx = high(x);
  const lx = low(x);
  const hy = high(y);
  const ly = low(y);
  const ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;

  if ((iy | ly) === 0) return 1.0;
  if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) || iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) return x + y;

  const yisint = hx < 0 ? integerClass(iy, ly) : 0;
  if (ly === 0) {
    const special = specialExponent(x, y, hx, lx, ix, hy, iy);
    if (special !== null) return special;
  }

  const ax = Math.abs(x);
  if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) return specialBase(ax, hx, ix, hy, yisint);

  const n = (hx >> 31) + 1;
  if ((n | yisint) === 0) return Number.NaN;
  const s = (n | (yisint - 1)) === 0 ? -1.0 : 1.0;

  if (iy > 0x41e00000) {
    const settled = hugeExponent(ax, ix, hy, iy, s);
    if (settled !== null) return settled;
  } else log2Parts(ax, ix);
  return exp2Scaled(s, y, logHead, logTail);
}
