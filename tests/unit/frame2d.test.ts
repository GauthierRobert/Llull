import { describe, expect, it } from 'vitest';
import { solveFrame, type FrameNode } from '@lib/frame2d';

const E = 210000;
const pinned: FrameNode['restraint'] = [true, true, false];
const fixed: FrameNode['restraint'] = [true, true, true];
const free: FrameNode['restraint'] = [false, false, false];

describe('solveFrame', () => {
  it('reproduces a simply supported beam under uniform load (qL²/8, qL⁴ deflection)', () => {
    const [L, q, I] = [6000, -10, 8.356e7];
    const result = solveFrame(
      [
        { x: 0, y: 0, restraint: pinned },
        { x: L / 2, y: 0, restraint: free },
        { x: L, y: 0, restraint: [false, true, false] },
      ],
      [
        { a: 0, b: 1, E, A: 5380, I, load: { qx: 0, qy: q } },
        { a: 1, b: 2, E, A: 5380, I, load: { qx: 0, qy: q } },
      ],
    )!;
    expect(result.members[0]!.moment[1]).toBeCloseTo((-q * L * L) / 8, 3);
    expect(result.displacements[1]![1]).toBeCloseTo((5 * q * L ** 4) / (384 * E * I), 6);
    expect(result.members[0]!.maxMoment).toBeCloseTo((-q * L * L) / 8, 3);
  });

  it('reproduces a fixed-fixed beam (end moments −qL²/12)', () => {
    const [L, q] = [8000, -5];
    const result = solveFrame(
      [
        { x: 0, y: 0, restraint: fixed },
        { x: L, y: 0, restraint: fixed },
      ],
      [{ a: 0, b: 1, E, A: 1e4, I: 1e8, load: { qx: 0, qy: q } }],
    )!;
    const [Ma, Mb] = result.members[0]!.moment;
    expect(Ma).toBeCloseTo((q * L * L) / 12, 3);
    expect(Mb).toBeCloseTo((q * L * L) / 12, 3);
    expect(result.members[0]!.maxMoment).toBeCloseTo((-q * L * L) / 12, 3);
  });

  it('matches the closed-form pinned-base portal frame (flat roof) moment', () => {
    // Pinned-base rectangular portal, column height h, span L, uniform load q on the beam:
    // M_corner = q L² / (4 (2k + 3)) with k = (Ib h) / (Ic L)  (Kleinlogel).
    const [h, L, q, Ic, Ib] = [6000, 12000, -8, 2e8, 4e8];
    const result = solveFrame(
      [
        { x: 0, y: 0, restraint: pinned },
        { x: 0, y: h, restraint: free },
        { x: L, y: h, restraint: free },
        { x: L, y: 0, restraint: pinned },
      ],
      [
        { a: 0, b: 1, E, A: 1e6, I: Ic },
        { a: 1, b: 2, E, A: 1e6, I: Ib, load: { qx: 0, qy: q } },
        { a: 2, b: 3, E, A: 1e6, I: Ic },
      ],
    )!;
    const k = (Ib * h) / (Ic * L);
    const corner = (-q * L * L) / (4 * (2 * k + 3));
    // Within 0.01 % (the solver also includes axial shortening).
    expect(Math.abs(Math.abs(result.members[1]!.moment[0]) / corner - 1)).toBeLessThan(1e-4);
    // Columns carry the vertical reaction qL/2 in compression.
    expect(result.members[0]!.axial[0]).toBeCloseTo((q * L) / 2, 3);
  });

  it('returns null for a mechanism or a degenerate member', () => {
    expect(
      solveFrame(
        [
          { x: 0, y: 0, restraint: pinned },
          { x: 1000, y: 0, restraint: free },
        ],
        [{ a: 0, b: 1, E, A: 1, I: 1 }],
      ),
    ).toBeNull();
    expect(
      solveFrame(
        [
          { x: 0, y: 0, restraint: fixed },
          { x: 0, y: 0, restraint: free },
        ],
        [{ a: 0, b: 1, E, A: 1, I: 1 }],
      ),
    ).toBeNull();
  });
});
