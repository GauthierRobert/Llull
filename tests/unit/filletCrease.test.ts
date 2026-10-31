/**
 * DES-6c 13.33: the crease a setback corner keeps at its unrounded third edge, as fillet_edge reports it (data.corners[].crease), over a scripted kernel
 * (native values: server/tests/nativeBlendSharpThird.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { GeometryKernel, ShapeEdge, ShapeHandle, ShapeTopology } from '@core/geometry/kernel';
import type { CommandResult } from '@core/commands/types';
import { creaseOfCorners, withCreases } from '@core/commands/brep/filletCrease';

const edge = (index: number, start: [number, number, number], end: [number, number, number]): ShapeEdge => ({
  index,
  curve: 'line',
  seam: false,
  degenerate: false,
  length: 10,
  start,
  end,
  mid: start,
});
// the vertex (0, 0, 0): edges 0 (x) and 1 (y) rounded, edge 2 (z) sharp; edge 3 is far away
const topology = {
  solids: 1,
  faces: [],
  edges: [edge(0, [0, 0, 0], [10, 0, 0]), edge(1, [0, 0, 0], [0, 10, 0]), edge(2, [0, 0, 10], [0, 0, 0]), edge(3, [5, 5, 5], [6, 5, 5])],
  vertices: 8,
  volume: 1,
} as unknown as ShapeTopology;
const shape = { key: 'k' } as unknown as ShapeHandle;
const kernelOf = (samples: unknown): GeometryKernel => ({ faceQuery: { edgeContinuity: () => samples } }) as unknown as GeometryKernel;
const corner = { vertex: [0, 0, 0] as [number, number, number], type: 'setback' as const, distances: [] };
const sample = (g1: number, g1Signed?: number): unknown => ({
  t: 0,
  point: [0, 0, 0],
  g0: 0,
  g1,
  normalCurvature: [0, 0],
  ...(g1Signed === undefined ? {} : { g1Signed }),
});

describe('creaseOfCorners', () => {
  it('names the sharp edge of a three-edge corner and its signed dihedral at the vertex end of that edge', () => {
    // edge 2 ends at the vertex: the LAST sample is the entry
    const found = creaseOfCorners(kernelOf([sample(0.1), sample(Math.PI / 2, Math.PI / 2)]), shape, topology, [corner], [0, 1]);
    expect(found).toEqual([{ vertex: [0, 0, 0], crease: { sharpEdge: 2, entryRad: 1.570796 } }]);
    expect(withCreases({ document: {}, summary: '', affected: [] } as unknown as CommandResult, found).summary).toContain(
      'Sharp edge kept at 1 corner(s): edge 2 (entry 1.570796 rad)',
    );
    // a concave fold reads negative; without a signed reading the unsigned angle stands
    expect(creaseOfCorners(kernelOf([sample(0.1), sample(1, -1)]), shape, topology, [corner], [0, 1])[0]?.crease.entryRad).toBe(-1);
    expect(creaseOfCorners(kernelOf([sample(0.1), sample(1)]), shape, topology, [corner], [0, 1])[0]?.crease.entryRad).toBe(1);
  });

  it('reads the first sample when the sharp edge starts at the vertex', () => {
    const flipped = { ...topology, edges: [topology.edges[0], topology.edges[1], edge(2, [0, 0, 0], [0, 0, 10])] } as ShapeTopology;
    expect(creaseOfCorners(kernelOf([sample(0.5, 0.5), sample(0.1)]), shape, flipped, [corner], [0, 1])[0]?.crease.entryRad).toBe(0.5);
  });

  it('reports nothing when no edge is left sharp, two are, the vertex has other than three edges, the topology or the kernel reading is missing', () => {
    const kernel = kernelOf([sample(1), sample(1)]);
    expect(creaseOfCorners(kernel, shape, topology, [corner], [0, 1, 2])).toEqual([]);
    expect(creaseOfCorners(kernel, shape, topology, [corner], [0])).toEqual([]);
    expect(creaseOfCorners(kernel, shape, topology, [{ ...corner, vertex: [5, 5, 5] }], [])).toEqual([]);
    expect(creaseOfCorners(kernel, shape, null, [corner], [0, 1])).toEqual([]);
    expect(creaseOfCorners(kernelOf(null), shape, topology, [corner], [0, 1])).toEqual([]);
    expect(creaseOfCorners({} as GeometryKernel, shape, topology, [corner], [0, 1])).toEqual([]);
    expect(creaseOfCorners(kernelOf([]), shape, topology, [corner], [0, 1])).toEqual([]);
  });
});

describe('withCreases', () => {
  const crease = { vertex: [0, 0, 0] as [number, number, number], crease: { sharpEdge: 2, entryRad: 1.5 } };
  const result = {
    document: {},
    summary: 'done.',
    affected: ['a'],
    data: { profile: { builder: 'corners' }, nonTangent: { edge: 1 } },
  } as unknown as CommandResult;

  it('adds data.corners and the summary sentence and keeps profile and nonTangent next to them', () => {
    const merged = withCreases(result, [crease]);
    expect(merged.data).toEqual({ profile: { builder: 'corners' }, nonTangent: { edge: 1 }, corners: [crease] });
    expect(merged.summary).toContain('Sharp edge kept at 1 corner(s)');
    expect(withCreases({ ...result, data: undefined } as CommandResult, [crease]).data).toEqual({ corners: [crease] });
  });

  it('returns the result as it is without creases', () => {
    expect(withCreases(result, [])).toBe(result);
  });
});
