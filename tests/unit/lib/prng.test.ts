/** VC-GDT-33: Philox4x32-10 known answers (Random123 kat_vectors), determinism, uniformity; polynomial cos(2πu) and Box–Muller. */

import { describe, expect, it } from 'vitest';
import { boxMuller, cosTwoPi, philox4x32, philoxKey, unitUniform } from '@lib/prng';

const hex = (words: Uint32Array): string[] => [...words].map((w) => w.toString(16).padStart(8, '0'));

describe('philox4x32 (Salmon et al. SC11, Random123 kat_vectors "philox4x32 10")', () => {
  it.each([
    [
      [0, 0, 0, 0, 0, 0],
      ['6627e8d5', 'e169c58d', 'bc57ac4c', '9b00dbd8'],
    ],
    [
      [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff],
      ['408f276d', '41c83b0e', 'a20bc7c6', '6d5451fd'],
    ],
    [
      [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0],
      ['d16cfe09', '94fdcceb', '5001e420', '24126ea1'],
    ],
  ])('counter + key %j -> %j', (input, expected) => {
    const out = new Uint32Array(4);
    const [c0, c1, c2, c3, k0, k1] = input as [number, number, number, number, number, number];
    philox4x32(c0, c1, c2, c3, k0, k1, out);
    expect(hex(out)).toEqual(expected);
  });

  it('is a pure function of (counter, key) and splits a 53-bit seed into two key words', () => {
    const a = new Uint32Array(4);
    const b = new Uint32Array(4);
    philox4x32(7, 0, 1, 0, 42, 0, a);
    philox4x32(8, 0, 1, 0, 42, 0, b);
    philox4x32(7, 0, 1, 0, 42, 0, b);
    expect([...b]).toEqual([...a]);
    expect(philoxKey(42)).toEqual([42, 0]);
    expect(philoxKey(2 ** 40 + 5)).toEqual([5, 256]);
  });

  it('uniform words: χ² over 64 bins on 1e5 draws is not significant (p > 1e-3)', () => {
    const bins = new Array<number>(64).fill(0);
    const out = new Uint32Array(4);
    const draws = 100_000;
    for (let i = 0; i < draws / 4; i += 1) {
      philox4x32(i, 0, 0, 0, 20261015, 0, out);
      for (const w of out) bins[Math.floor(unitUniform(w) * 64)] = (bins[Math.floor(unitUniform(w) * 64)] ?? 0) + 1;
    }
    const expected = draws / 64;
    const chi2 = bins.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    // χ²(63) upper 0.1 % point is 103.4 (any statistics table).
    expect(chi2).toBeLessThan(103.4);
    expect(unitUniform(0)).toBeGreaterThan(0);
    expect(unitUniform(0xffffffff)).toBeLessThan(1);
  });
});

describe('cosTwoPi and Box–Muller', () => {
  it('cos(2πu) within 1e-15 of Math.cos on a dense grid', () => {
    let worst = 0;
    for (let i = 0; i <= 20_000; i += 1) {
      const u = i / 20_001;
      worst = Math.max(worst, Math.abs(cosTwoPi(u) - Math.cos(2 * Math.PI * u)));
    }
    expect(worst).toBeLessThan(1e-15);
    expect(cosTwoPi(0)).toBe(1);
    expect(cosTwoPi(0.5)).toBe(-1);
  });

  it('normals have mean 0 and variance 1 within 5σ statistical bounds on 2e5 draws', () => {
    const out = new Uint32Array(4);
    const n = 200_000;
    let sum = 0;
    let squares = 0;
    for (let i = 0; i < n / 2; i += 1) {
      philox4x32(i, 0, 0, 0, 3, 0, out);
      for (const z of [boxMuller(out[0] as number, out[1] as number), boxMuller(out[2] as number, out[3] as number)]) {
        sum += z;
        squares += z * z;
      }
    }
    const mean = sum / n;
    expect(Math.abs(mean)).toBeLessThan(5 / Math.sqrt(n));
    expect(Math.abs(squares / n - mean * mean - 1)).toBeLessThan(5 * Math.sqrt(2 / n));
  });
});
