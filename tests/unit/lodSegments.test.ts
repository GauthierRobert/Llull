/**
 * Unit tests for lodSegments.ts — pure LOD segment-count helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  radialSegmentsForDiag,
  sphereDiag,
  cylinderDiag,
  torusDiag,
} from '../../src/ui/viewport/3d/lodSegments';

describe('radialSegmentsForDiag', () => {
  it('returns minimum 8 segments for a very small diagonal', () => {
    expect(radialSegmentsForDiag(0.01)).toBe(8);
    expect(radialSegmentsForDiag(1e-10)).toBe(8);
    expect(radialSegmentsForDiag(0)).toBe(8);
  });

  it('returns 8 segments for diag = 1', () => {
    // log2(1) = 0 → 8 + 0 = 8
    expect(radialSegmentsForDiag(1)).toBe(8);
  });

  it('returns 16 segments for diag = 4', () => {
    // log2(4) = 2 → 8 + floor(2*4) = 8 + 8 = 16
    expect(radialSegmentsForDiag(4)).toBe(16);
  });

  it('returns 24 segments for diag = 16', () => {
    // log2(16) = 4 → 8 + floor(4*4) = 8 + 16 = 24
    expect(radialSegmentsForDiag(16)).toBe(24);
  });

  it('returns 32 segments for diag = 64', () => {
    // log2(64) = 6 → 8 + floor(6*4) = 8 + 24 = 32
    expect(radialSegmentsForDiag(64)).toBe(32);
  });

  it('caps at 64 segments for a very large diagonal', () => {
    expect(radialSegmentsForDiag(1e9)).toBe(64);
  });

  it('result is always an integer', () => {
    for (const diag of [0.5, 2.7, 10, 50, 100]) {
      const seg = radialSegmentsForDiag(diag);
      expect(Number.isInteger(seg)).toBe(true);
    }
  });

  it('result is always in [8, 64]', () => {
    for (const diag of [0.001, 0.1, 1, 5, 10, 100, 1000]) {
      const seg = radialSegmentsForDiag(diag);
      expect(seg).toBeGreaterThanOrEqual(8);
      expect(seg).toBeLessThanOrEqual(64);
    }
  });

  it('is monotonically non-decreasing with diag', () => {
    const diags = [0.5, 1, 2, 4, 8, 16, 32, 64, 128];
    let prev = radialSegmentsForDiag(diags[0]!);
    for (let i = 1; i < diags.length; i++) {
      const cur = radialSegmentsForDiag(diags[i]!);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('sphereDiag', () => {
  it('returns 2 * radius', () => {
    expect(sphereDiag(1)).toBeCloseTo(2);
    expect(sphereDiag(5)).toBeCloseTo(10);
    expect(sphereDiag(0.5)).toBeCloseTo(1);
  });
});

describe('cylinderDiag', () => {
  it('returns sqrt((2r)^2 + h^2)', () => {
    // r=3, h=4 → d=6, sqrt(36+16)=sqrt(52)≈7.21
    expect(cylinderDiag(3, 4)).toBeCloseTo(Math.sqrt(52));
  });

  it('matches diameter when height is 0', () => {
    expect(cylinderDiag(5, 0)).toBeCloseTo(10);
  });

  it('matches height when radius is 0', () => {
    expect(cylinderDiag(0, 10)).toBeCloseTo(10);
  });
});

describe('torusDiag', () => {
  it('returns 2*(ringRadius + tubeRadius)', () => {
    expect(torusDiag(4, 1)).toBeCloseTo(10);
    expect(torusDiag(2, 0.5)).toBeCloseTo(5);
  });
});
