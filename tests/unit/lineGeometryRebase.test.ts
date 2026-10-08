import { describe, it, expect } from 'vitest';
import {
  anchoredGeometry,
  positionsGeometry,
  rebaseToAnchor,
} from '../../src/ui/viewport/lineGeometry';

describe('rebaseToAnchor', () => {
  it('keeps full precision for geometry far from the origin', () => {
    const base = 1_000_000;
    const positions = [base + 0.01, 5, 0, base + 0.02, 5.1, 0, base + 0.03, 5.2, 0];
    const { anchor, local } = rebaseToAnchor(positions);
    expect(anchor).toEqual([base + 0.01, 5, 0]);
    // float32 vertex data resolves the 0.01 steps; absolute float32 at 1e6 cannot (about 0.06).
    const stored = Array.from(positionsGeometry(local).getAttribute('position').array);
    expect(stored[3]).toBeCloseTo(0.01, 6);
    expect(stored[6]).toBeCloseTo(0.02, 6);
    const absolute = Array.from(positionsGeometry(positions).getAttribute('position').array);
    expect(Math.abs((absolute[3] as number) - (base + 0.02))).toBeGreaterThan(0.005);
  });

  it('reproduces the original x/y when the anchor is added back, leaving z alone', () => {
    const positions = [10, 20, 3, 14, 26, 4];
    const { anchor, local } = rebaseToAnchor(positions);
    expect(local).toEqual([0, 0, 3, 4, 6, 4]);
    expect(local[3]! + anchor[0]).toBe(14);
    expect(local[4]! + anchor[1]).toBe(26);
  });

  it('anchoredGeometry stores segment vertices relative to the first vertex at the given z', () => {
    const base = 2_000_000;
    const { geometry, anchor } = anchoredGeometry(
      [
        [base + 0.5, 7],
        [base + 0.53, 7.25],
      ],
      0.2,
    );
    expect(anchor).toEqual([base + 0.5, 7, 0]);
    const stored = Array.from(geometry.getAttribute('position').array);
    expect(stored[0]).toBe(0);
    expect(stored[3]).toBeCloseTo(0.03, 6);
    expect(stored[4]).toBeCloseTo(0.25, 6);
    expect(stored[5]).toBeCloseTo(0.2, 6);
  });

  it('handles an empty vertex list', () => {
    expect(rebaseToAnchor([])).toEqual({ anchor: [0, 0, 0], local: [] });
  });
});
