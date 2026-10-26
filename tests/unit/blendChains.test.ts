/**
 * BLD M2: the profile of a picked edge reaches the blend faces OCCT rounded with it (its tangent chain), and the G2 reading of a plane is not
 * numerical noise at any size.
 */
import { describe, expect, it } from 'vitest';
import { recordsByFace } from '@core/commands/brep/blendChains';
import { junctionsOf } from '@core/commands/brep/blendJunctions';
import type { LawRecord } from '@core/commands/brep/checkBlendRadius';
import { measureContact } from '@core/geometry/blend/continuity';
import type { ShapeTopology } from '@core/geometry/kernel';
import type { FaceGraph } from '@core/geometry/kernelPorts';

const face = (index: number, name: string): ShapeTopology['faces'][number] => ({ index, name, surface: 'plane', area: 1 }) as never;
const topology = {
  solids: 1,
  faces: [face(0, 'blend(e(a|b))'), face(1, 'blend(e(c|d))'), face(2, 'blend(e(e|f))'), face(3, 'a'), face(4, 'blend(e(g|h))')],
  edges: [],
  vertices: 0,
  volume: 1,
} as ShapeTopology;
// 0-1 and 1-2 share an edge (a chain), 2-3 a blend against a plane, 3-4 a plane against a separate blend
const edgeFaces = [[0, 1], [1, 2], [2, 3], [3, 4], [0]];
const graph = { faces: [], edgeFaces, edgeConvexity: [] } as unknown as FaceGraph;
const always = (): boolean => true;
const except =
  (...creased: number[]) =>
  (edge: number): boolean =>
    !creased.includes(edge);
const record = (profile?: LawRecord['profile']): LawRecord =>
  ({ law: { size: 1 }, shape: {}, topology, edge: 0, ...(profile === undefined ? {} : { profile }) }) as unknown as LawRecord;

describe('recordsByFace', () => {
  it('a profile spreads over the blend faces that continue the face it was asked for, not over other faces or other blends', () => {
    const conic = record({ type: 'conic', rho: 0.5 });
    const found = recordsByFace(topology, graph, new Map([['e(a|b)', conic]]), always);
    expect([...found.keys()].sort()).toEqual([0, 1, 2]);
    expect(found.get(2)).toBe(conic);
    expect(found.has(4)).toBe(false);
  });

  it('a face with its own record keeps it, and a circular record does not spread', () => {
    const own = record({ type: 'curvature', shape: 0.5 });
    const conic = record({ type: 'conic', rho: 0.5 });
    const kept = recordsByFace(
      topology,
      graph,
      new Map([
        ['e(a|b)', conic],
        ['e(c|d)', own],
      ]),
      always,
    );
    expect(kept.get(1)).toBe(own);
    expect(kept.get(2)).toBe(own);
    const circular = recordsByFace(topology, graph, new Map([['e(a|b)', record()]]), always);
    expect([...circular.keys()]).toEqual([0]);
  });

  it('a profile does not cross a crease: a blend that meets a profiled face at a convex or concave edge keeps no record', () => {
    const conic = record({ type: 'conic', rho: 0.5 });
    // edge 1 (between faces 1 and 2) is a crease: the chain stops there
    const creased = recordsByFace(topology, graph, new Map([['e(a|b)', conic]]), except(1));
    expect([...creased.keys()].sort()).toEqual([0, 1]);
    // the first edge is a crease: nothing spreads at all
    const nothing = recordsByFace(topology, graph, new Map([['e(a|b)', conic]]), except(0));
    expect([...nothing.keys()]).toEqual([0]);
  });

  it('no records: nothing', () => {
    expect(recordsByFace(topology, graph, new Map(), always).size).toBe(0);
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
