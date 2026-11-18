import { describe, it, expect } from 'vitest';
import { radialSegmentsForDiag, sphereDiag, cylinderDiag, torusDiag } from '../../src/ui/viewport/3d/lodSegments';

describe('radialSegmentsForDiag', () => {
  it('never goes below the floor a round part needs to read as round', () => {
    for (const diag of [0, 1e-10, 0.01, 1]) expect(radialSegmentsForDiag(diag)).toBe(48);
  });
  it('adds 8 segments per doubling of the size', () => {
    expect(radialSegmentsForDiag(2)).toBe(56);
    expect(radialSegmentsForDiag(4)).toBe(64);
    expect(radialSegmentsForDiag(16)).toBe(80);
    expect(radialSegmentsForDiag(64)).toBe(96);
  });
  it('caps at 128 segments for a very large diagonal', () => {
    expect(radialSegmentsForDiag(1e9)).toBe(128);
  });
  it('is always an integer in [48, 128]', () => {
    for (const diag of [0.001, 0.1, 0.5, 1, 2.7, 5, 10, 50, 100, 1000]) {
      const seg = radialSegmentsForDiag(diag);
      expect(Number.isInteger(seg)).toBe(true);
      expect(seg).toBeGreaterThanOrEqual(48);
      expect(seg).toBeLessThanOrEqual(128);
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
