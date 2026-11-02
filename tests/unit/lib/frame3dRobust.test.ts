/**
 * @lib/frame3d robustness: typed failures (never a throw), determinism, purity, ordering, skyline Cholesky, and the 2 000-node budget
 * of the PST spec section 8 (equilibrium residual <= 1e-9).
 */

import { describe, expect, it } from 'vitest';
import { reverseCuthillMcKee } from '@lib/frame3d/rcm';
import { pipeProperties } from '@lib/frame3d/section';
import { Skyline } from '@lib/frame3d/skyline';
import { analyzeFrame } from '@lib/frame3d/solve';
import type { FrameAnalysis, FrameCaseResult, FrameLoadCase, FrameModel, FramePoint, FrameRestraint } from '@lib/frame3d/types';

const ALL = [0, 1, 2, 3, 4, 5];
const anchor = (node: number): FrameRestraint[] => ALL.map((dof) => ({ node, dof }));
const PIPE = pipeProperties(168.3, 7.11, 200000, 0.3);
const LOAD: FrameLoadCase = { name: 'W', nodal: [{ node: 1, force: [0, 0, -1000] }] };
const beam: FrameModel = {
  nodes: [
    [0, 0, 0],
    [2000, 0, 0],
  ],
  elements: [{ a: 0, b: 1, properties: PIPE }],
  restraints: anchor(0),
};

const failure = (result: FrameAnalysis): { code: string; message: string; dofs: ReadonlyArray<{ node: number; dof: number }> } => {
  if (result.ok) throw new Error('expected a failure');
  return result;
};

describe('typed failures, never a throw', () => {
  it('a baseline beam solves', () => {
    expect(analyzeFrame(beam, [LOAD]).ok).toBe(true);
  });

  it('unrestrained model: FRAME_UNSTABLE naming a node and DOF', () => {
    const result = failure(analyzeFrame({ ...beam, restraints: [] }, [LOAD]));
    expect(result.code).toBe('FRAME_UNSTABLE');
    expect(result.dofs).toHaveLength(1);
    expect(result.dofs[0]?.node).toBeGreaterThanOrEqual(0);
  });

  it('pinned at one end only (rotation about the axis free): FRAME_UNSTABLE', () => {
    const pinned = [0, 1, 2].map((dof) => ({ node: 0, dof }));
    expect(failure(analyzeFrame({ ...beam, restraints: pinned }, [LOAD])).code).toBe('FRAME_UNSTABLE');
  });

  it('an orphan node without elements is a mechanism and is reported', () => {
    const model: FrameModel = { ...beam, nodes: [...beam.nodes, [0, 5000, 0]] };
    const result = failure(analyzeFrame(model, [LOAD]));
    expect(result.code).toBe('FRAME_UNSTABLE');
    expect(result.dofs[0]?.node).toBe(2);
  });

  it.each([
    ['no elements', { ...beam, elements: [] }],
    ['element end out of range', { ...beam, elements: [{ a: 0, b: 7, properties: PIPE }] }],
    ['element to itself', { ...beam, elements: [{ a: 0, b: 0, properties: PIPE }] }],
    [
      'zero length',
      {
        ...beam,
        nodes: [
          [0, 0, 0],
          [0, 0, 0],
        ] as FramePoint[],
      },
    ],
    [
      'NaN coordinate',
      {
        ...beam,
        nodes: [
          [0, 0, 0],
          [Number.NaN, 0, 0],
        ] as FramePoint[],
      },
    ],
    ['zero area', { ...beam, elements: [{ a: 0, b: 1, properties: { ...PIPE, area: 0 } }] }],
    ['negative shear area', { ...beam, elements: [{ a: 0, b: 1, properties: { ...PIPE, shearArea: -1 } }] }],
    ['flexibility factor 0', { ...beam, elements: [{ a: 0, b: 1, properties: PIPE, flexibility: 0 }] }],
    ['non-finite up', { ...beam, elements: [{ a: 0, b: 1, properties: PIPE, up: [Number.NaN, 0, 1] as FramePoint }] }],
    ['restraint dof 6', { ...beam, restraints: [{ node: 0, dof: 6 }] }],
    ['restraint on a missing node', { ...beam, restraints: [{ node: 9, dof: 0 }] }],
    ['spring with zero stiffness', { ...beam, restraints: [...anchor(0), { node: 1, dof: 0, stiffness: 0 }] }],
    ['non-finite prescribed value', { ...beam, restraints: [...anchor(0), { node: 1, dof: 0, value: Number.POSITIVE_INFINITY }] }],
    ['duplicate restraint', { ...beam, restraints: [...anchor(0), { node: 0, dof: 2 }] }],
  ] satisfies Array<[string, FrameModel]>)('invalid model (%s): FRAME_INVALID_MODEL', (_label, model) => {
    expect(failure(analyzeFrame(model, [LOAD])).code).toBe('FRAME_INVALID_MODEL');
  });

  it.each([
    ['nodal load on a missing node', { name: 'x', nodal: [{ node: 5, force: [1, 0, 0] as FramePoint }] }],
    ['non-finite nodal force', { name: 'x', nodal: [{ node: 1, force: [Number.NaN, 0, 0] as FramePoint }] }],
    ['element load on a missing element', { name: 'x', elemental: [{ element: 3, freeStrain: 0.001 }] }],
    ['non-finite free strain', { name: 'x', elemental: [{ element: 0, freeStrain: Number.NaN }] }],
  ] satisfies Array<[string, FrameLoadCase]>)('invalid load (%s): FRAME_INVALID_LOAD', (_label, loadCase) => {
    expect(failure(analyzeFrame(beam, [loadCase])).code).toBe('FRAME_INVALID_LOAD');
  });
});

describe('determinism and purity', () => {
  const lattice = gridModel(6, 5);

  it('same input gives bit-identical output', () => {
    const run = (): FrameCaseResult[] => {
      const result = analyzeFrame(lattice.model, [lattice.weight]);
      return result.ok ? [...result.cases] : [];
    };
    const [a, b] = [run(), run()];
    expect(a).toHaveLength(1);
    expect(
      Buffer.from((a[0] as FrameCaseResult).displacements.buffer).equals(Buffer.from((b[0] as FrameCaseResult).displacements.buffer)),
    ).toBe(true);
    expect(
      Buffer.from((a[0] as FrameCaseResult).elementForces.buffer).equals(Buffer.from((b[0] as FrameCaseResult).elementForces.buffer)),
    ).toBe(true);
  });

  it('does not mutate a deeply frozen model and load case (is pure)', () => {
    const freeze = <T>(value: T): T => {
      if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
      return value;
    };
    const before = JSON.stringify([lattice.model, lattice.weight]);
    const result = analyzeFrame(freeze(structuredClone(lattice.model)), [freeze(structuredClone(lattice.weight))]);
    expect(result.ok).toBe(true);
    expect(JSON.stringify([lattice.model, lattice.weight])).toBe(before);
  });

  it('node numbering of the input does not change the physics (1e-9)', () => {
    const permuted = permute(lattice.model, lattice.weight);
    const a = analyzeFrame(lattice.model, [lattice.weight]);
    const b = analyzeFrame(permuted.model, [permuted.load]);
    if (!a.ok || !b.ok) throw new Error('solve failed');
    const ua = (a.cases[0] as FrameCaseResult).displacements;
    const ub = (b.cases[0] as FrameCaseResult).displacements;
    const scale = Math.max(...ua.map(Math.abs));
    permuted.map.forEach((newIndex, oldIndex) => {
      for (let d = 0; d < 6; d++)
        expect(Math.abs((ub[newIndex * 6 + d] as number) - (ua[oldIndex * 6 + d] as number))).toBeLessThan(1e-9 * scale);
    });
  });

  it('several load cases share one factorisation and equal separate solves', () => {
    const thermal: FrameLoadCase = { name: 'T', elemental: [{ element: 0, freeStrain: 0.001 }] };
    const both = analyzeFrame(lattice.model, [lattice.weight, thermal]);
    const only = analyzeFrame(lattice.model, [thermal]);
    if (!both.ok || !only.ok) throw new Error('solve failed');
    expect(both.cases.map((c) => c.name)).toEqual(['W', 'T']);
    expect(Array.from((both.cases[1] as FrameCaseResult).displacements)).toEqual(
      Array.from((only.cases[0] as FrameCaseResult).displacements),
    );
  });

  it('the local reference direction (up) does not change a round pipe result, even when parallel to the axis', () => {
    const base = analyzeFrame(beam, [LOAD]);
    const rolled = analyzeFrame({ ...beam, elements: [{ a: 0, b: 1, properties: PIPE, up: [0, 1, 0] }] }, [LOAD]);
    const parallel = analyzeFrame({ ...beam, elements: [{ a: 0, b: 1, properties: PIPE, up: [1, 0, 0] }] }, [LOAD]);
    if (!base.ok || !rolled.ok || !parallel.ok) throw new Error('solve failed');
    const tip = (r: typeof base): number => (r.cases[0] as FrameCaseResult).displacements[8] as number;
    expect(Math.abs(tip(rolled) / tip(base) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(tip(parallel) / tip(base) - 1)).toBeLessThan(1e-12);
  });

  it('a vertical pipe (axis parallel to the default up) solves with the same stiffness as a horizontal one', () => {
    const vertical: FrameModel = {
      ...beam,
      nodes: [
        [0, 0, 0],
        [0, 0, 2000],
      ],
    };
    const base = analyzeFrame(beam, [{ name: 'F', nodal: [{ node: 1, force: [0, 500, 0] }] }]);
    const rotated = analyzeFrame(vertical, [{ name: 'F', nodal: [{ node: 1, force: [0, 500, 0] }] }]);
    if (!base.ok || !rotated.ok) throw new Error('solve failed');
    expect(
      Math.abs(
        ((rotated.cases[0] as FrameCaseResult).displacements[7] as number) /
          ((base.cases[0] as FrameCaseResult).displacements[7] as number) -
          1,
      ),
    ).toBeLessThan(1e-12);
  });
});

describe('reverse Cuthill-McKee', () => {
  it('returns a permutation, deterministic, with self edges and several components', () => {
    const order = reverseCuthillMcKee(7, [
      [0, 1],
      [1, 2],
      [2, 2],
      [4, 5],
      [5, 6],
    ]);
    expect([...order].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      reverseCuthillMcKee(7, [
        [0, 1],
        [1, 2],
        [2, 2],
        [4, 5],
        [5, 6],
      ]),
    ).toEqual(order);
  });

  it('turns a shuffled chain into a tri-diagonal band (half bandwidth 1)', () => {
    const shuffled = [5, 0, 7, 2, 9, 4, 1, 8, 3, 6];
    const edges = shuffled.slice(1).map((n, i) => [shuffled[i] as number, n] as const);
    const order = reverseCuthillMcKee(10, edges);
    const position = new Map(order.map((node, index) => [node, index]));
    for (const [a, b] of edges) expect(Math.abs((position.get(a) as number) - (position.get(b) as number))).toBe(1);
  });
});

describe('skyline Cholesky', () => {
  /** Tri-diagonal SPD with one wide row so the envelope is genuinely variable. */
  const build = (): { sky: Skyline; dense: number[][] } => {
    const n = 8;
    const first = Int32Array.from({ length: n }, (_, i) => (i === 6 ? 2 : Math.max(0, i - 1)));
    const sky = new Skyline(first);
    const dense = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const put = (i: number, j: number, v: number): void => {
      sky.add(i, j, v);
      dense[i]![j] = v;
      dense[j]![i] = v;
    };
    for (let i = 0; i < n; i++) put(i, i, 10 + i);
    for (let i = 1; i < n; i++) put(i, i - 1, -2);
    put(6, 2, 1.5);
    return { sky, dense };
  };

  it('solves A x = b to rounding and reports the envelope', () => {
    const { sky, dense } = build();
    expect(sky.bandwidth).toBe(4);
    expect(sky.factorize(1e-10)).toBe(-1);
    const b = Float64Array.from({ length: 8 }, (_, i) => i + 1);
    const x = sky.solve(b);
    for (let i = 0; i < 8; i++) {
      const row = dense[i]!.reduce((s, a, j) => s + a * (x[j] as number), 0);
      expect(Math.abs(row - (b[i] as number))).toBeLessThan(1e-12);
    }
  });

  it('flags a singular matrix at the first dependent row', () => {
    const sky = new Skyline(Int32Array.from([0, 0]));
    sky.add(0, 0, 1);
    sky.add(1, 0, 1);
    sky.add(1, 1, 1);
    expect(sky.factorize(1e-10)).toBe(1);
  });
});

describe('budgets (PST spec section 8)', () => {
  it('2 000-node lattice (12 000 DOF): equilibrium residual <= 1e-9, bandwidth within the 300 budget', () => {
    const { model, weight } = gridModel(40, 50);
    const started = performance.now();
    const result = analyzeFrame(model, [
      weight,
      { name: 'T', elemental: model.elements.map((_, element) => ({ element, freeStrain: 0.001 })) },
    ]);
    const elapsed = performance.now() - started;
    if (!result.ok) throw new Error(result.message);
    expect(result.stats.nodes).toBe(2000);
    expect(result.stats.freeDofs).toBeGreaterThan(11_000);
    expect(result.stats.bandwidth).toBeLessThanOrEqual(300);
    for (const c of result.cases) expect(c.residual).toBeLessThan(1e-9);
    expect(elapsed).toBeLessThan(30_000);
  });
});

/** columns x rows lattice of pipes in the XY plane (Z up), spacing 1 m, corners anchored, every rim node on a vertical support, uniform weight on every element. */
function gridModel(columns: number, rows: number): { model: FrameModel; weight: FrameLoadCase } {
  const nodes: FramePoint[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) nodes.push([i * 1000, j * 1000, 0]);
  const index = (i: number, j: number): number => j * columns + i;
  const elements = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      if (i + 1 < columns) elements.push({ a: index(i, j), b: index(i + 1, j), properties: PIPE });
      if (j + 1 < rows) elements.push({ a: index(i, j), b: index(i, j + 1), properties: PIPE });
    }
  }
  const corners = [index(0, 0), index(columns - 1, 0), index(0, rows - 1), index(columns - 1, rows - 1)];
  const rim = nodes.flatMap((_, n) =>
    n % columns === 0 || n % columns === columns - 1 || n < columns || n >= columns * (rows - 1) ? [n] : [],
  );
  const supports = rim.filter((n) => !corners.includes(n)).map((node) => ({ node, dof: 2 }));
  const model: FrameModel = { nodes, elements, restraints: [...corners.flatMap(anchor), ...supports] };
  const weight: FrameLoadCase = { name: 'W', elemental: elements.map((_, element) => ({ element, uniform: [0, 0, -0.3] })) };
  return { model, weight };
}

/** The same model with nodes renumbered by a fixed pseudo-random permutation; `map[old] = new`. */
function permute(model: FrameModel, load: FrameLoadCase): { model: FrameModel; load: FrameLoadCase; map: number[] } {
  const n = model.nodes.length;
  const map = Array.from({ length: n }, (_, i) => (i * 7 + 3) % n);
  const nodes: FramePoint[] = new Array(n);
  model.nodes.forEach((p, old) => {
    nodes[map[old] as number] = p;
  });
  return {
    map,
    model: {
      nodes,
      elements: model.elements.map((e) => ({ ...e, a: map[e.a] as number, b: map[e.b] as number })),
      restraints: model.restraints.map((r) => ({ ...r, node: map[r.node] as number })),
    },
    load,
  };
}

describe('review round 1: size cap, scaling, residual, bend guard, up threshold', () => {
  it('FRAME_TOO_LARGE above the profile cap, before allocating; profileSize is a plain number past 2^31', () => {
    const lattice = gridModel(6, 5);
    expect(failure(analyzeFrame(lattice.model, [lattice.weight], { maxProfile: 1000 })).code).toBe('FRAME_TOO_LARGE');
    expect(analyzeFrame(lattice.model, [lattice.weight], { maxProfile: 1e7 }).ok).toBe(true);
    expect(Skyline.profileSize(new Int32Array(70_000))).toBeGreaterThan(2 ** 31);
  });

  it.each([true, false])(
    'a stiff rigid link next to a soft span solves (ratio 1e10, link at the root: %s), and the tip matches the soft cantilever',
    (linkAtRoot) => {
      const stiff = { ...PIPE, youngs: PIPE.youngs * 1e10 };
      const model: FrameModel = {
        nodes: [
          [0, 0, 0],
          [linkAtRoot ? 100 : 2000, 0, 0],
          [2100, 0, 0],
        ],
        elements: [
          { a: 0, b: 1, properties: linkAtRoot ? stiff : PIPE },
          { a: 1, b: 2, properties: linkAtRoot ? PIPE : stiff },
        ],
        restraints: anchor(0),
      };
      const result = analyzeFrame(model, [{ name: 'F', nodal: [{ node: 2, force: [0, 0, -1000] }] }]);
      if (!result.ok) throw new Error(result.message);
      const tip = (result.cases[0] as FrameCaseResult).displacements[2 * 6 + 2] as number;
      const { youngs: E, inertia: I } = PIPE;
      const P = 1000;
      const L = 2000;
      const shear = (P * 2100) / (PIPE.shear * PIPE.shearArea);
      // link at the tip carries the end moment P x 100 into the soft span and rotates rigidly: tip = d1 + 100 theta1
      const rooted = (P * L ** 3) / (3 * E * I);
      const tipped = rooted + (P * 100 * L ** 2) / (2 * E * I) + 100 * ((P * L ** 2) / (2 * E * I) + (P * 100 * L) / (E * I));
      const expected = -((linkAtRoot ? rooted : tipped) + shear);
      expect(Math.abs(tip / expected - 1)).toBeLessThan(1e-4);
    },
  );

  it('a true mechanism behind a stiff link is still FRAME_UNSTABLE', () => {
    const stiff = { ...PIPE, youngs: PIPE.youngs * 1e10 };
    const model: FrameModel = {
      nodes: [
        [0, 0, 0],
        [100, 0, 0],
        [2100, 0, 0],
      ],
      elements: [
        { a: 0, b: 1, properties: stiff },
        { a: 1, b: 2, properties: PIPE },
      ],
      restraints: [0, 1, 2].map((dof) => ({ node: 0, dof })),
    };
    expect(failure(analyzeFrame(model, [])).code).toBe('FRAME_UNSTABLE');
  });

  it('residual is 0, not a floor artefact, for a case with no load', () => {
    const result = analyzeFrame(beam, [{ name: 'none' }]);
    if (!result.ok) throw new Error(result.message);
    expect((result.cases[0] as FrameCaseResult).residual).toBe(0);
  });

  it('up within 0.08 degrees of the axis is ignored; just outside it is used', () => {
    const tip = (up: FramePoint): number => {
      const r = analyzeFrame({ ...beam, elements: [{ a: 0, b: 1, properties: PIPE, up }] }, [LOAD]);
      if (!r.ok) throw new Error(r.message);
      return (r.cases[0] as FrameCaseResult).displacements[8] as number;
    };
    expect(Math.abs(tip([1, 1e-4, 0]) / tip([0, 0, 1]) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(tip([1, 0.01, 0]) / tip([0, 0, 1]) - 1)).toBeLessThan(1e-12);
  });
});
