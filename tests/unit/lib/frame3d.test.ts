/**
 * @lib/frame3d (07 PST M2): Timoshenko pipe-frame solver. Oracles: closed-form beam theory (cantilever, fixed-fixed, torsion, arc),
 * the validation pack's L-bend (VC-PST-12, lbend_guided_cantilever.json) and the PSI fixtures (VC-PST-07, 08, 10, 11, psi_benchmarks.json).
 * Units: N, mm, MPa unless a test says in / lbf / psi (PSI).
 */

import { describe, expect, it } from 'vitest';
import { bendChords, bendSubdivisions } from '@lib/frame3d/bend';
import { pipeProperties } from '@lib/frame3d/section';
import { analyzeFrame } from '@lib/frame3d/solve';
import type { FrameCaseResult, FrameElement, FrameLoadCase, FrameModel, FramePoint, FrameRestraint } from '@lib/frame3d/types';
import { expectRel, referenceData } from '../plant/stress/stressFixtures';

const ALL = [0, 1, 2, 3, 4, 5];
const anchor = (node: number): FrameRestraint[] => ALL.map((dof) => ({ node, dof }));

const NPS6 = pipeProperties(168.3, 7.11, 200000, 0.3);
const EB6 = pipeProperties(168.3, 7.11, 200000, 0.3, false);

function solved(model: FrameModel, ...cases: FrameLoadCase[]): { cases: readonly FrameCaseResult[] } {
  const result = analyzeFrame(model, cases);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return { cases: result.cases };
}

const at = (values: Float64Array, node: number, dof: number): number => values[node * 6 + dof] as number;

function chain(points: FramePoint[], properties = NPS6, extra: Partial<FrameElement> = {}): FrameElement[] {
  return points.slice(1).map((_, i) => ({ a: i, b: i + 1, properties, ...extra }));
}

describe('straight Timoshenko element: beam theory', () => {
  const L = 3000;
  const { youngs: E, shear: G, area: A, inertia: I, torsion: J, shearArea: As } = NPS6;

  it('cantilever tip load: P L^3 / 3EI + P L / G As and P L^2 / 2EI (exact for one element)', () => {
    const P = 1000;
    const model: FrameModel = {
      nodes: [
        [0, 0, 0],
        [L, 0, 0],
      ],
      elements: chain([
        [0, 0, 0],
        [L, 0, 0],
      ]),
      restraints: anchor(0),
    };
    const { cases } = solved(model, { name: 'tip', nodal: [{ node: 1, force: [0, 0, -P] }] });
    const c = cases[0] as FrameCaseResult;
    expectRel(at(c.displacements, 1, 2), -((P * L ** 3) / (3 * E * I) + (P * L) / (G * As)), 1e-12, 'tip deflection');
    expectRel(at(c.displacements, 1, 4), (P * L ** 2) / (2 * E * I), 1e-12, 'tip rotation');
    expectRel(at(c.reactions, 0, 2), P, 1e-12, 'reaction force');
    expectRel(at(c.reactions, 0, 4), -P * L, 1e-12, 'reaction moment');
    expect(c.residual).toBeLessThan(1e-12);
  });

  it('shear deformation is what separates Timoshenko from Euler-Bernoulli', () => {
    const P = 1000;
    const model = (properties: typeof NPS6): FrameModel => ({
      nodes: [
        [0, 0, 0],
        [600, 0, 0],
      ],
      elements: chain(
        [
          [0, 0, 0],
          [600, 0, 0],
        ],
        properties,
      ),
      restraints: anchor(0),
    });
    const load: FrameLoadCase = { name: 'tip', nodal: [{ node: 1, force: [0, P, 0] }] };
    const timo = at(solved(model(NPS6), load).cases[0]!.displacements, 1, 1);
    const euler = at(solved(model(EB6), load).cases[0]!.displacements, 1, 1);
    expectRel(euler, (P * 600 ** 3) / (3 * E * I), 1e-12, 'Euler-Bernoulli');
    expectRel(timo - euler, (P * 600) / (G * As), 1e-9, 'shear part');
  });

  it('axial and torsion stiffness: P L / EA and T L / GJ', () => {
    const model: FrameModel = {
      nodes: [
        [0, 0, 0],
        [L, 0, 0],
      ],
      elements: chain([
        [0, 0, 0],
        [L, 0, 0],
      ]),
      restraints: anchor(0),
    };
    const { cases } = solved(
      model,
      { name: 'axial', nodal: [{ node: 1, force: [5000, 0, 0] }] },
      { name: 'twist', nodal: [{ node: 1, moment: [2e6, 0, 0] }] },
    );
    expectRel(at((cases[0] as FrameCaseResult).displacements, 1, 0), (5000 * L) / (E * A), 1e-12, 'axial');
    expectRel(at((cases[1] as FrameCaseResult).displacements, 1, 3), (2e6 * L) / (G * J), 1e-12, 'twist');
  });

  it('result does not depend on the pipe direction or on how the run is split', () => {
    const P = 800;
    const dir: FramePoint = [1 / 3, 2 / 3, 2 / 3];
    const perp: FramePoint = [2 / 3, 1 / 3, -2 / 3];
    const tip = (parts: number): number => {
      const points: FramePoint[] = Array.from({ length: parts + 1 }, (_, i) => [
        (dir[0] * L * i) / parts,
        (dir[1] * L * i) / parts,
        (dir[2] * L * i) / parts,
      ]);
      const model: FrameModel = { nodes: points, elements: chain(points), restraints: anchor(0) };
      const c = solved(model, { name: 'p', nodal: [{ node: parts, force: [perp[0] * P, perp[1] * P, perp[2] * P] }] })
        .cases[0] as FrameCaseResult;
      const d: FramePoint = [at(c.displacements, parts, 0), at(c.displacements, parts, 1), at(c.displacements, parts, 2)];
      expect(Math.abs(d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2])).toBeLessThan(1e-9);
      return d[0] * perp[0] + d[1] * perp[1] + d[2] * perp[2];
    };
    const expected = (P * L ** 3) / (3 * E * I) + (P * L) / (G * As);
    expectRel(tip(1), expected, 1e-9);
    expectRel(tip(7), expected, 1e-9);
  });

  it('fixed-fixed thermal: reaction E A eps, no displacement, element force is compressive', () => {
    const eps = 0.00225;
    const model: FrameModel = {
      nodes: [
        [0, 0, 0],
        [L, 0, 0],
      ],
      elements: chain([
        [0, 0, 0],
        [L, 0, 0],
      ]),
      restraints: [...anchor(0), ...anchor(1)],
    };
    const c = solved(model, { name: 'T', elemental: [{ element: 0, freeStrain: eps }] }).cases[0] as FrameCaseResult;
    expectRel(at(c.reactions, 1, 0), -E * A * eps, 1e-12, 'reaction at b (pushes back toward a)');
    expectRel(at(c.reactions, 0, 0), E * A * eps, 1e-12, 'reaction at a');
    expect(Math.abs(at(c.displacements, 1, 0))).toBe(0);
    expectRel(c.elementForces[0] as number, E * A * eps, 1e-12, 'N at a is compressive on the element');
  });

  it('free thermal expansion: eps L with zero stress', () => {
    const eps = 0.001;
    const model: FrameModel = {
      nodes: [
        [0, 0, 0],
        [L, 0, 0],
      ],
      elements: chain([
        [0, 0, 0],
        [L, 0, 0],
      ]),
      restraints: anchor(0),
    };
    const c = solved(model, { name: 'T', elemental: [{ element: 0, freeStrain: eps }] }).cases[0] as FrameCaseResult;
    expectRel(at(c.displacements, 1, 0), eps * L, 1e-12);
    expect(Math.abs(c.elementForces[0] as number)).toBeLessThan(1e-6);
  });

  it('uniform load: fixed-fixed R = wL/2, M = wL^2/12; cantilever tip w L^4 / 8EI + w L^2 / 2 G As', () => {
    const w = 2;
    const nodes: FramePoint[] = [
      [0, 0, 0],
      [L, 0, 0],
    ];
    const both = solved(
      { nodes, elements: chain(nodes), restraints: [...anchor(0), ...anchor(1)] },
      { name: 'w', elemental: [{ element: 0, uniform: [0, 0, -w] }] },
    );
    const c = both.cases[0] as FrameCaseResult;
    expectRel(at(c.reactions, 0, 2), (w * L) / 2, 1e-12, 'shear');
    expectRel(Math.abs(at(c.reactions, 0, 4)), (w * L * L) / 12, 1e-12, 'fixed-end moment');
    const cant = solved(
      { nodes, elements: chain(nodes), restraints: anchor(0) },
      { name: 'w', elemental: [{ element: 0, uniform: [0, 0, -w] }] },
    );
    expectRel(
      at((cant.cases[0] as FrameCaseResult).displacements, 1, 2),
      -((w * L ** 4) / (8 * E * I) + (w * L * L) / (2 * G * As)),
      1e-12,
      'tip',
    );
  });

  it('prescribed displacement and a ground spring (stiffness-weighted share)', () => {
    const nodes: FramePoint[] = [
      [0, 0, 0],
      [L, 0, 0],
    ];
    const settle = solved({ nodes, elements: chain(nodes), restraints: [...anchor(0), { node: 1, dof: 0, value: 2 }] }, { name: 'D' })
      .cases[0] as FrameCaseResult;
    expectRel(at(settle.displacements, 1, 0), 2, 1e-15);
    expectRel(at(settle.reactions, 1, 0), (E * A * 2) / L, 1e-12, 'D drives an axial force');
    const settledTip = solved(
      { nodes, elements: chain(nodes, EB6), restraints: [...anchor(0), { node: 1, dof: 1, value: 5 }] },
      { name: 'D' },
    ).cases[0] as FrameCaseResult;
    expectRel(at(settledTip.reactions, 1, 1), (3 * E * I * 5) / L ** 3, 1e-9, 'imposed tip deflection gives 3EI d / L^3');
    expectRel(at(settledTip.displacements, 1, 5), (3 * 5) / (2 * L), 1e-9, 'free tip rotation 3 d / 2L');
    const kSpring = 1000;
    const sprung = solved(
      { nodes, elements: chain(nodes), restraints: [...anchor(0), { node: 1, dof: 0, stiffness: kSpring }] },
      { name: 'F', nodal: [{ node: 1, force: [100, 0, 0] }] },
    ).cases[0] as FrameCaseResult;
    const pipeK = (E * A) / L;
    expectRel(at(sprung.displacements, 1, 0), 100 / (pipeK + kSpring), 1e-12);
    expectRel(at(sprung.reactions, 1, 0), (-100 * kSpring) / (pipeK + kSpring), 1e-12, 'spring force on the pipe');
    expect(sprung.residual).toBeLessThan(1e-12);
  });
});

describe('bends: arc chords with flexibility factor k', () => {
  const R = 300;
  const { youngs: E, shear: G, area: A, inertia: I, shearArea: As } = NPS6;

  /** Quarter circle fixed at (0,R), free end (R,0) loaded in y. Castigliano: bending k R^3 (3pi/4 - 2) / EI, axial R pi/4 / EA, shear R pi/4 / G As. */
  const archTip = (k: number, subdivisions?: number): number => {
    const bend = bendChords([R, R, 0], [0, 1, 0], [-1, 0, 0], R, subdivisions);
    if (!bend) throw new Error('no bend');
    const points = [...bend.points].reverse();
    const model: FrameModel = { nodes: points, elements: chain([...points], NPS6, { flexibility: k }), restraints: anchor(0) };
    const free = points.length - 1;
    const c = solved(model, { name: 'tip', nodal: [{ node: free, force: [0, 1, 0] }] }).cases[0] as FrameCaseResult;
    return at(c.displacements, free, 1);
  };
  const castigliano = (k: number): number =>
    (k * R ** 3 * ((3 * Math.PI) / 4 - 2)) / (E * I) + ((R * Math.PI) / 4) * (1 / (E * A) + 1 / (G * As));

  it('geometry: tangent length R tan(theta/2), end points on the legs, 6 sub-elements for 90 degrees', () => {
    const bend = bendChords([R, R, 0], [0, 1, 0], [-1, 0, 0], R);
    expect(bendSubdivisions(Math.PI / 2)).toBe(12);
    expect(bend?.points).toHaveLength(13);
    expectRel(bend?.tangentLength ?? 0, R, 1e-12);
    expect(bend?.points[0]?.map(Math.round)).toEqual([R, 0, 0]);
    expect(bend?.points[12]?.map(Math.round)).toEqual([0, R, 0]);
    for (const p of bend?.points ?? []) expectRel(Math.hypot(p[0], p[1], p[2]), R, 1e-12, 'on the arc');
  });

  it('refuses a straight continuation, a reversal, a zero radius and non-finite input', () => {
    expect(bendChords([0, 0, 0], [1, 0, 0], [1, 0, 0], 100)).toBeNull();
    expect(bendChords([0, 0, 0], [1, 0, 0], [-1, 0, 0], 100)).toBeNull();
    expect(bendChords([0, 0, 0], [1, 0, 0], [0, 1, 0], 0)).toBeNull();
    expect(bendChords([Number.NaN, 0, 0], [1, 0, 0], [0, 1, 0], 100)).toBeNull();
  });

  it('90 degree bend at the default 7.5 degree sub-division (12 chords) matches the curved-beam flexibility within 1e-3 (k = 1 and k = 3.2)', () => {
    expectRel(archTip(1), castigliano(1), 1e-3, 'k=1');
    expectRel(archTip(3.2), castigliano(3.2), 1e-3, 'k=3.2');
  });

  it('flexibility factor scales bending flexibility only: 2x compliance difference equals the bending part', () => {
    const bending = (R ** 3 * ((3 * Math.PI) / 4 - 2)) / (E * I);
    expectRel(archTip(2) - archTip(1), bending, 2e-3);
  });

  it('refining the arc converges to the curved-beam value', () => {
    const coarse = Math.abs(archTip(1, 2) - castigliano(1));
    const fine = Math.abs(archTip(1, 12) - castigliano(1));
    expect(fine).toBeLessThan(coarse / 4);
  });
});

describe('VC-PST-12: two-anchor L-bend (lbend_guided_cantilever.json)', () => {
  interface LBend {
    lBendTwoAnchors: {
      expectedWithAxial: { reactionAtC_N: number[]; momentMagnitudesNmm: { C: number; B: number; A: number } };
      expectedBendingOnly: { reactionAtC_N: number[]; momentMagnitudeCNmm: number };
    };
  }
  const ref = referenceData<LBend>('lbend_guided_cantilever.json').lBendTwoAnchors;
  const nodes: FramePoint[] = [
    [0, 0, 0],
    [6000, 0, 0],
    [6000, 3000, 0],
  ];
  const model: FrameModel = { nodes, elements: chain(nodes, EB6), restraints: [...anchor(0), ...anchor(2)] };
  const thermal: FrameLoadCase = {
    name: 'T',
    elemental: [
      { element: 0, freeStrain: 0.00225 },
      { element: 1, freeStrain: 0.00225 },
    ],
  };
  const moment = (c: FrameCaseResult, element: number, end: 0 | 1): number => {
    const o = element * 12 + end * 6;
    return Math.hypot(c.elementForces[o + 4] as number, c.elementForces[o + 5] as number);
  };

  it('reactions and end moments equal the unit-load flexibility solution to 1e-4', () => {
    const c = solved(model, thermal).cases[0] as FrameCaseResult;
    const [rx, ry] = ref.expectedWithAxial.reactionAtC_N as [number, number];
    expectRel(at(c.reactions, 2, 0), rx, 1e-4, 'Rx at C');
    expectRel(at(c.reactions, 2, 1), ry, 1e-4, 'Ry at C');
    expectRel(moment(c, 1, 1), ref.expectedWithAxial.momentMagnitudesNmm.C, 1e-4, 'M at C');
    expectRel(moment(c, 0, 1), ref.expectedWithAxial.momentMagnitudesNmm.B, 1e-4, 'M at B');
    expectRel(moment(c, 0, 0), ref.expectedWithAxial.momentMagnitudesNmm.A, 1e-4, 'M at A');
    expect(c.residual).toBeLessThan(1e-10);
  });

  it('axially rigid legs reproduce the bending-only variant (E A -> infinity), 1e-3', () => {
    const rigid: FrameModel = { ...model, elements: chain(nodes, { ...EB6, area: EB6.area * 1e5 }) };
    const c = solved(rigid, thermal).cases[0] as FrameCaseResult;
    const [rx, ry] = ref.expectedBendingOnly.reactionAtC_N as [number, number];
    expectRel(at(c.reactions, 2, 0), rx, 1e-3, 'Rx at C');
    expectRel(at(c.reactions, 2, 1), ry, 1e-3, 'Ry at C');
    expectRel(moment(c, 1, 1), ref.expectedBendingOnly.momentMagnitudeCNmm, 1e-3, 'M at C');
  });
});
