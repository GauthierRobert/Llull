/**
 * check_blends judges the junction between two blends of a profiled chain against the crease of the SUPPORT faces (TECHNICAL_SPEC 13.16.4), over a
 * scripted kernel with fake face queries: a smooth chain keeps the plain G1 rule, a creased one is allowed its crease and no more.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import type { FaceGraph } from '@core/geometry/kernelPorts';
import { scriptedKernel, edgeOf } from '../helpers/blendKernel';

afterEach(() => setGeometryKernel(null));

const faces: ShapeTopology['faces'] = [
  { index: 0, name: 'T', surface: 'plane', area: 100, normal: [0, 0, 1] },
  { index: 1, name: 'W1', surface: 'plane', area: 10, normal: [1, 0, 0] },
  { index: 2, name: 'W2', surface: 'plane', area: 10, normal: [1, 0, 0] },
  { index: 3, name: 'blend(e(T|W1))', surface: 'bspline', area: 4 },
  { index: 4, name: 'blend(e(T|W2))', surface: 'bspline', area: 4 },
];
const TOPOLOGY: ShapeTopology = {
  solids: 1,
  faces,
  edges: [
    edgeOf(0, { name: 'e(T|W1)' }),
    edgeOf(1, { name: 'e(T|W2)' }),
    edgeOf(2, { name: 'e(blend(e(T|W1))|blend(e(T|W2)))' }),
    edgeOf(3, { name: 'e(W1|W2)' }),
  ],
  vertices: 8,
  volume: 1000,
};
// edge 2 is the junction of the two blends; edge 3 the sharp edge between the walls that carries the crease
const GRAPH = {
  faces: [],
  edgeFaces: [
    [3, 0],
    [4, 0],
    [3, 4],
    [1, 2],
  ],
  edgeConvexity: [],
} as unknown as FaceGraph;

/** Findings of check_blends for a junction whose normals read `junction(t)` and whose walls meet at `crease`. */
function findingsFor(junction: (t: number) => number, crease: number): Array<{ code: string; severity: string }> {
  const kernel: GeometryKernel = scriptedKernel({
    topology: TOPOLOGY,
    graph: GRAPH,
    g1: (edge, t) => (edge === 2 ? junction(t) : edge === 3 ? crease : 0),
  });
  const context = { ...defaultContext(), kernel };
  const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  const done = execute(
    box.document,
    'fillet_edge',
    {
      id: box.affected[0],
      edges: [
        { index: 0, size: 1 },
        { index: 1, size: 1 },
      ],
      profile: { type: 'conic', rho: 0.5 },
    },
    context,
  );
  expect(done.error).toBeUndefined();
  const checked = execute(done.document, 'check_blends', {}, context).data as { findings: Array<{ code: string; severity: string }> };
  return checked.findings.filter((finding) => finding.code === 'BLD_CHECK_G1_ANGLE');
}

const ends =
  (end: number, interior: number) =>
  (t: number): number =>
    t === 0 || t === 1 ? end : interior;

describe('check_blends junctions of a profiled chain', () => {
  it('a smooth chain keeps the plain rule: ends 0.005 with an interior of 0.012 fails BLD_CHECK_G1_ANGLE, an interior of 0.009 does not', () => {
    expect(findingsFor(ends(0.005, 0.012), 0).map((finding) => finding.severity)).toEqual(['fail']);
    expect(findingsFor(ends(0.005, 0.009), 0)).toEqual([]);
  });

  it('across a crease of 0.098 the junction may reach it and no more: an interior of 0.12 fails, ends of 0.0982 and 0 pass', () => {
    expect(findingsFor((t) => (t === 0 ? 0.0982 : t === 1 ? 0 : 0.05), 0.098)).toEqual([]);
    expect(findingsFor((t) => (t === 0 ? 0.0982 : t === 1 ? 0 : 0.12), 0.098)).toHaveLength(1);
  });

  it('an end that reads neither 0 nor the crease of the supports fails although it is below the crease', () => {
    expect(findingsFor(() => 0.05, 0.098).length).toBeGreaterThan(0);
  });

  it('a corner of the part (a support crease above what OCCT chains) gives the junction no allowance', () => {
    expect(findingsFor((t) => (t === 0 ? 0.2 : 0.1), 0.2).length).toBeGreaterThan(0);
  });
});
