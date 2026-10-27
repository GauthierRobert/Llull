/**
 * BLD M2: the profile of a picked edge reaches the blend faces OCCT rounded with it (its tangent chain), and the G2 reading of a plane is not
 * numerical noise at any size.
 */
import { describe, expect, it } from 'vitest';
import { recordsByFace } from '@core/commands/brep/blendChains';
import { CHAIN_CREASE_LIMIT, judgeJunction, junctionsOf, supportCrease } from '@core/commands/brep/blendJunctions';
import { type LawRecord, lawIndex } from '@core/commands/brep/checkBlendRadius';
import type { ShapeRecipe } from '@core/model/types';
import { measureContact } from '@core/geometry/blend/continuity';
import type { GeometryKernel, ShapeTopology } from '@core/geometry/kernel';
import type { FaceGraph } from '@core/geometry/kernelPorts';

const face = (index: number, name: string): ShapeTopology['faces'][number] => ({ index, name, surface: 'plane', area: 1 }) as never;
const topology = {
  solids: 1,
  faces: [face(0, 'blend(e(a|b))'), face(1, 'blend(e(c|d))'), face(2, 'blend(e(e|f))'), face(3, 'a'), face(4, 'blend(e(g|h))')],
  edges: [],
  vertices: 0,
  volume: 1,
} as ShapeTopology;
const always = (): boolean => true;
const record = (chain: string[], profile?: LawRecord['profile']): LawRecord =>
  ({
    law: { size: 1 },
    shape: {},
    topology,
    edge: 0,
    chain: new Set(chain),
    ...(profile === undefined ? {} : { profile }),
  }) as unknown as LawRecord;

describe('recordsByFace', () => {
  it('a profile spreads over the blend faces the kernel built with the picked edge (its chain), not over other blends or planes', () => {
    const conic = record(['blend(e(a|b))', 'blend(e(c|d))', 'blend(e(e|f))'], { type: 'conic', rho: 0.5 });
    const found = recordsByFace(topology, new Map([['e(a|b)', conic]]));
    expect([...found.keys()].sort()).toEqual([0, 1, 2]);
    expect(found.get(2)).toBe(conic);
    expect(found.has(4)).toBe(false);
    expect(found.has(3)).toBe(false);
  });

  it('a face with its own record keeps it, and a circular record does not spread', () => {
    const own = record(['blend(e(c|d))'], { type: 'curvature', shape: 0.5 });
    const conic = record(['blend(e(a|b))', 'blend(e(c|d))', 'blend(e(e|f))'], { type: 'conic', rho: 0.5 });
    const kept = recordsByFace(
      topology,
      new Map([
        ['e(a|b)', conic],
        ['e(c|d)', own],
      ]),
    );
    expect(kept.get(1)).toBe(own);
    expect(kept.get(2)).toBe(conic);
    const circular = recordsByFace(topology, new Map([['e(a|b)', record(['blend(e(a|b))', 'blend(e(c|d))'])]]));
    expect([...circular.keys()]).toEqual([0]);
  });

  it('the chain is the kernel chain, with no angle rule: a blend built by another step keeps no profile even when it touches the profiled face', () => {
    const conic = record(['blend(e(a|b))', 'blend(e(c|d))'], { type: 'conic', rho: 0.5 });
    expect([...recordsByFace(topology, new Map([['e(a|b)', conic]])).keys()].sort()).toEqual([0, 1]);
  });

  it('no records: nothing', () => {
    expect(recordsByFace(topology, new Map()).size).toBe(0);
  });
});

describe('measureContact flat curvature', () => {
  const tolerances = { g0: 1, g1AngleRad: 0.01, g2Rel: 0.1 };
  const samples = [{ t: 0, g0: 0, g1: 0, normalCurvature: [0, 4.7e-12] as const }];
  it('a plane against noise is G1 by the absolute default only when the part is small; relative to the part it is flat', () => {
    expect(measureContact(samples, tolerances)?.order).toBe('G1');
    expect(measureContact(samples, { ...tolerances, flatCurvature: 1e-8 / 20 })?.order).toBe('G2');
    expect(measureContact([{ ...samples[0]!, normalCurvature: [0, 0.2] }], { ...tolerances, flatCurvature: 1e-8 / 20 })?.order).toBe('G1');
  });
});

describe('junctionsOf', () => {
  const faces = [
    face(0, 'blend(e(a|b))'),
    face(1, 'blend(e(c|d))'),
    face(2, 'blend(e(blend(e(c|d))|z))'),
    face(3, 'z'),
    face(4, 'blend(e(g|h)#2)'),
  ];
  const named = { solids: 1, faces, edges: [], vertices: 0, volume: 1 } as ShapeTopology;
  const around = (edgeFaces: number[][]): FaceGraph => ({ faces: [], edgeFaces, edgeConvexity: [] }) as unknown as FaceGraph;

  it('lists the edges to the higher-indexed blend faces that are not supports of each other, once', () => {
    // 0-1 junction; 1-2 face 2 has face 1 as a support (a contact, not a junction); 2-3 a plane; 0-4 a junction to a face named with #k; 4-0 seen from 4
    const graph = around([[0, 1], [1, 2], [2, 3], [0, 4], [0], [0, 1, 4]]);
    expect(junctionsOf(named, graph, 0, always)).toEqual([
      { edge: 0, neighbour: 'blend(e(c|d))' },
      { edge: 3, neighbour: 'blend(e(g|h)#2)' },
    ]);
    expect(junctionsOf(named, graph, 1, always)).toEqual([]);
    expect(junctionsOf(named, graph, 4, always)).toEqual([]);
    expect(junctionsOf(named, graph, 3, always)).toEqual([]);
    expect(junctionsOf(named, graph, 9, always)).toEqual([]);
  });
});

describe('the crease of a junction, read from the supports', () => {
  // two blends over a rim: both touch the top face, each its own wall; the walls share a sharp edge (edge 0) that carries the crease
  const faces = [face(0, 'blend(e(top|w1))'), face(1, 'blend(e(top|w2))'), face(2, 'w1'), face(3, 'w2'), face(4, 'top')];
  const named = { solids: 1, faces, edges: [], vertices: 0, volume: 1 } as ShapeTopology;
  const around = (edgeFaces: number[][]): FaceGraph => ({ faces: [], edgeFaces, edgeConvexity: [] }) as unknown as FaceGraph;
  const samples = (...angles: number[]): Array<{ g1: number }> => angles.map((g1) => ({ g1 }));

  it('is the angle between the two walls along their shared edge; 0 for a smooth chain, without such an edge, or with the same supports', () => {
    const graph = around([
      [2, 3],
      [0, 2],
      [0, 4],
    ]);
    expect(supportCrease(named, graph, 0, 1, 0, () => samples(0.098, 0.0981))).toBe(0.0981);
    expect(supportCrease(named, graph, 0, 1, 0, () => samples(1e-6))).toBe(0);
    expect(supportCrease(named, graph, 0, 1, 0, () => null)).toBe(0);
    expect(supportCrease(named, around([[0, 2]]), 0, 1, 0, () => samples(0.098))).toBe(0);
    // the same supports on both sides (a rim of one wall): nothing to measure
    const same = {
      ...named,
      faces: [face(0, 'blend(e(top|w1))'), face(1, 'blend(e(top|w1))'), face(2, 'w1'), face(3, 'w2'), face(4, 'top')],
    } as ShapeTopology;
    expect(supportCrease(same, graph, 0, 1, 0, () => samples(0.098))).toBe(0);
    expect(supportCrease(named, graph, 0, 9, 0, () => samples(0.098))).toBe(0);
    expect(supportCrease(named, graph, 2, 3, 0, () => samples(0.098))).toBe(0);
  });

  it('reads the shared edge that touches the junction, not the first one found; a pair above the cap is skipped before the maximum', () => {
    const at = (index: number, x: number): ShapeTopology['edges'][number] =>
      ({ index, curve: 'line', length: 1, start: [x, 0, 0], end: [x, 1, 0], mid: [x, 0.5, 0], seam: false, degenerate: false }) as never;
    // edge 0 is the junction (at x = 5); the walls also share edge 1 far away (x = 50, a crease of 0.5) and edge 2 at the junction (x = 5, 0.098)
    const placed = { ...named, edges: [at(0, 5), at(1, 50), at(2, 5)] } as ShapeTopology;
    const twice = around([
      [0, 1],
      [2, 3],
      [2, 3],
    ]);
    const by = (edge: number): Array<{ g1: number }> => samples(edge === 1 ? 0.5 : 0.098);
    expect(supportCrease(placed, twice, 0, 1, 0, by)).toBe(0.098);
    // the pair of walls above the cap does not zero the allowance of another pair (top against the second wall) that is a fine crease
    const mixed = around([
      [2, 3],
      [4, 3],
    ]);
    expect(supportCrease(named, mixed, 0, 1, 0, (edge) => samples(edge === 0 ? 0.2 : 0.05))).toBe(0.05);
  });

  it('a support crease above what OCCT chains (a corner of the part) gives no allowance', () => {
    const graph = around([[2, 3]]);
    expect(supportCrease(named, graph, 0, 1, 0, () => samples(CHAIN_CREASE_LIMIT + 0.01))).toBe(0);
    expect(supportCrease(named, graph, 0, 1, 0, () => samples(CHAIN_CREASE_LIMIT - 0.01))).toBeCloseTo(CHAIN_CREASE_LIMIT - 0.01, 12);
  });

  // The verdict check_blends draws: the interior is held to g1AngleRad + the support crease, each end to 0 or the crease within g1AngleRad.
  const fails = (measured: number[], crease: number): boolean => {
    const verdict = judgeJunction(samples(...measured), crease, 0.01);
    return Math.max(...measured) > verdict.limit || verdict.endsOff > 0.01;
  };

  it('a smooth chain keeps the plain rule: ends 0.005 with an interior of 0.012 fails, 0.009 passes', () => {
    expect(fails([0.005, 0.012, 0.005], 0)).toBe(true);
    expect(fails([0.005, 0.009, 0.005], 0)).toBe(false);
  });

  it('across a crease of 0.098 an interior of 0.12 fails, ends of 0 and 0.0982 pass, an end at 0.05 fails', () => {
    expect(fails([0.0982, 0.12, 0], 0.098)).toBe(true);
    expect(fails([0.0982, 0.05, 0], 0.098)).toBe(false);
    expect(fails([0.0982, 0.098, 0.0001], 0.098)).toBe(false);
    expect(fails([0.05, 0.05, 0.05], 0.098)).toBe(true);
    // a blend whose own ends read a crease the supports do not have is not excused by it
    expect(judgeJunction(samples(0.098, 0.098), 0, 0.01).limit).toBe(0.01);
  });
});

describe('junctionsOf across fillet steps', () => {
  it('a non-tangent blend-to-blend edge between two steps is no junction: no row, nothing to measure', () => {
    const faces = [face(0, 'blend(e(a|b))'), face(1, 'blend(e(blend(e(a|b))|c))'), face(2, 'blend(e(d|e))')];
    const named = { solids: 1, faces, edges: [], vertices: 0, volume: 1 } as ShapeTopology;
    const graph = {
      faces: [],
      edgeFaces: [
        [0, 2],
        [1, 2],
      ],
      edgeConvexity: [],
    } as unknown as FaceGraph;
    // faces 0 and 2 come from different steps (nodes 0 and 1); 1 and 2 as well
    const node = new Map([
      [0, 1],
      [1, 1],
      [2, 0],
    ]);
    const sameStep = (a: number, b: number): boolean => node.get(a) === node.get(b);
    expect(junctionsOf(named, graph, 0, sameStep)).toEqual([]);
    expect(junctionsOf(named, graph, 1, sameStep)).toEqual([]);
    // the same edges in one step are junctions
    expect(junctionsOf(named, graph, 0, always)).toEqual([{ edge: 0, neighbour: 'blend(e(d|e))' }]);
  });
});

describe('lawIndex chains across fillet steps', () => {
  const edge = (index: number, name: string): ShapeTopology['edges'][number] =>
    ({
      index,
      name,
      curve: 'line',
      length: 1,
      start: [0, 0, 0],
      end: [1, 0, 0],
      mid: [0.5, 0, 0],
      seam: false,
      degenerate: false,
    }) as never;
  const shape = (faces: string[], edges: string[]): ShapeTopology =>
    ({
      solids: 1,
      faces: faces.map((name, index) => face(index, name)),
      edges: edges.map((name, index) => edge(index, name)),
      vertices: 0,
      volume: 1,
    }) as never;
  const solid = { op: 'solid', entity: { id: 'x', kind: 'box' } } as unknown as ShapeRecipe;
  const stepA: ShapeRecipe = { op: 'fillet', source: solid, edges: [0], size: 1, profile: { type: 'curvature', shape: 0.5 } };
  const stepB: ShapeRecipe = { op: 'fillet', source: stepA, edges: [0], size: 1, profile: { type: 'conic', rho: 0.5 } };
  // A rounds e(a|b); B rounds the first edge of A's result, and its result also holds a blend face whose source edge is not an edge of A's result
  const sourceShape = shape(['a', 'b'], ['e(a|b)']);
  const afterA = shape(['a', 'b', 'blend(e(a|b))'], ['e(a|blend(e(a|b)))']);
  const afterB = shape(['a', 'b', 'blend(e(a|b))', 'blend(e(a|blend(e(a|b))))', 'blend(e(stray|other))'], []);
  const topologies = new Map<ShapeRecipe, ShapeTopology>([
    [solid, sourceShape],
    [stepA, afterA],
    [stepB, afterB],
  ]);
  const kernel = {
    evaluate: (recipe: ShapeRecipe) => ({ recipe }),
    topology: (handle: { recipe: ShapeRecipe }) => topologies.get(handle.recipe) ?? null,
  } as unknown as GeometryKernel;

  it('a node owns only the blend faces made from edges of its own source: a later step never claims a face of an earlier one', () => {
    const records = lawIndex(kernel, stepB);
    const second = records.get('e(a|blend(e(a|b)))');
    const first = records.get('e(a|b)');
    expect([...(second?.chain ?? [])]).toEqual(['blend(e(a|blend(e(a|b))))']);
    expect([...(first?.chain ?? [])]).toEqual(['blend(e(a|b))']);
    expect(first?.profile).toEqual({ type: 'curvature', shape: 0.5 });
    const byFace = recordsByFace(afterB, records);
    expect(byFace.get(2)?.profile?.type).toBe('curvature');
    expect(byFace.get(3)?.profile?.type).toBe('conic');
    // the stray face belongs to no record
    expect(byFace.has(4)).toBe(false);
  });
});
