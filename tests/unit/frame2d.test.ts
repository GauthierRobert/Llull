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

  it('reports the in-span deflection of a single member (5qL⁴/384EI)', () => {
    const [L, q, I] = [6000, -10, 8.356e7];
    const result = solveFrame(
      [
        { x: 0, y: 0, restraint: pinned },
        { x: L, y: 0, restraint: [false, true, false] },
      ],
      [{ a: 0, b: 1, E, A: 5380, I, load: { qx: 0, qy: q } }],
    )!;
    expect(result.members[0]!.maxDisplacement.y).toBeCloseTo(
      Math.abs((5 * q * L ** 4) / (384 * E * I)),
      3,
    );
  });

  it('applies node loads: cantilever tip force (PL³/3EI) and moment (ML²/2EI)', () => {
    const [L, P, M, I] = [3000, -2000, 5e6, 1e7];
    const tip = (load: { fx: number; fy: number; mz: number }): number =>
      solveFrame(
        [
          { x: 0, y: 0, restraint: fixed },
          { x: L, y: 0, restraint: free, load },
        ],
        [{ a: 0, b: 1, E, A: 1e4, I }],
      )!.displacements[1]![1];
    expect(tip({ fx: 0, fy: P, mz: 0 })).toBeCloseTo((P * L ** 3) / (3 * E * I), 6);
    expect(tip({ fx: 0, fy: 0, mz: M })).toBeCloseTo((M * L * L) / (2 * E * I), 6);
    const sway = solveFrame(
      [
        { x: 0, y: 0, restraint: fixed },
        { x: 0, y: L, restraint: free, load: { fx: P, fy: 0, mz: 0 } },
      ],
      [{ a: 0, b: 1, E, A: 1e4, I }],
    )!;
    expect(sway.displacements[1]![0]).toBeCloseTo((P * L ** 3) / (3 * E * I), 6);
    expect(sway.members[0]!.maxDisplacement.x).toBeCloseTo(Math.abs((P * L ** 3) / (3 * E * I)), 6);
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

  describe('moment releases', () => {
    it('makes a propped cantilever: M = qL²/8 at the fixed end, 0 at the hinge, δ per closed form', () => {
      const [L, q, I] = [6000, -10, 8.356e7];
      const result = solveFrame(
        [
          { x: 0, y: 0, restraint: fixed },
          { x: L, y: 0, restraint: [false, true, false] },
        ],
        [{ a: 0, b: 1, E, A: 5380, I, load: { qx: 0, qy: q }, releaseB: true }],
      )!;
      const member = result.members[0]!;
      expect(member.moment[0]).toBeCloseTo((q * L * L) / 8, 3);
      expect(member.moment[1]).toBeCloseTo(0, 6);
      // The hinge rotates: θb = qL³/(48 EI) (propped cantilever), recovered for the in-span deflection.
      expect(member.maxMoment).toBeCloseTo((-q * L * L) / 8, 3);
      expect(member.shear[0]).toBeCloseTo((-5 * q * L) / 8, 3);
    });

    it('simply supports a beam released at both ends without a singular rotation', () => {
      const [L, q, I] = [6000, -10, 8.356e7];
      const result = solveFrame(
        [
          { x: 0, y: 0, restraint: pinned },
          { x: L, y: 0, restraint: [false, true, false] },
        ],
        [{ a: 0, b: 1, E, A: 5380, I, load: { qx: 0, qy: q }, releaseA: true, releaseB: true }],
      )!;
      const member = result.members[0]!;
      expect(member.moment[0]).toBeCloseTo(0, 6);
      expect(member.moment[1]).toBeCloseTo(0, 6);
      expect(member.maxMoment).toBeCloseTo((-q * L * L) / 8, 3);
      // Mid-span deflection 5qL⁴/384EI from the Hermite field with the recovered end rotations.
      expect(member.maxDisplacement.y).toBeCloseTo((5 * Math.abs(q) * L ** 4) / (384 * E * I), 4);
    });

    it('lets a pin-jointed beam tie two fixed-base cantilever columns: base moment H h / 2 each', () => {
      const [h, L, H, I] = [4000, 6000, 20000, 2e8];
      const result = solveFrame(
        [
          { x: 0, y: 0, restraint: fixed },
          { x: 0, y: h, restraint: [false, false, false], load: { fx: H, fy: 0, mz: 0 } },
          { x: L, y: h, restraint: [false, false, false] },
          { x: L, y: 0, restraint: fixed },
        ],
        [
          { a: 0, b: 1, E, A: 1e5, I },
          { a: 1, b: 2, E, A: 1e10, I: 1e9, releaseA: true, releaseB: true },
          { a: 3, b: 2, E, A: 1e5, I },
        ],
      )!;
      expect(Math.abs(result.members[0]!.moment[0])).toBeCloseTo((H * h) / 2, -1);
      expect(Math.abs(result.members[2]!.moment[0])).toBeCloseTo((H * h) / 2, -1);
      expect(result.members[1]!.moment[0]).toBeCloseTo(0, 3);
      expect(result.members[1]!.moment[1]).toBeCloseTo(0, 3);
    });

    it('is a mechanism when a moment is applied where every member end is released', () => {
      const nodes = [
        { x: 0, y: 0, restraint: pinned },
        { x: 3000, y: 0, restraint: [false, true, false] as FrameNode['restraint'] },
      ];
      const member = { a: 0, b: 1, E, A: 1e4, I: 1e8, releaseA: true, releaseB: true };
      expect(solveFrame(nodes, [member])).not.toBeNull();
      const loaded = [{ ...nodes[0]!, load: { fx: 0, fy: 0, mz: 1e6 } }, nodes[1]!];
      expect(solveFrame(loaded, [member])).toBeNull();
    });
  });
});
