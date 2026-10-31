/**
 * DES-6c 13.33: the crease spoke of a corner star, as check_blends reads it. A synthetic topology: the sharp edge 0 of the part (faces 0, 1: planes), a chord 1 and the crease spoke 2
 * between two sub-patches (faces 2, 3, named blend(v:...)#k) that starts at the end of the sharp edge.
 */

import { describe, expect, it } from 'vitest';
import type { ShapeEdge, ShapeFace, ShapeTopology } from '@core/geometry/kernel';
import type { FaceGraph } from '@core/geometry/kernelPorts';
import type { ContactSample } from '@core/geometry/blend/continuity';
import { creaseSpoke, judgeCrease } from '@core/commands/brep/checkCornerCrease';

const sample = (g1: number, g0 = 0): ContactSample => ({ t: 0, g0, g1, normalCurvature: [0, 0] });
const edge = (index: number, start: [number, number, number], end: [number, number, number]): ShapeEdge => ({
  index,
  curve: 'line',
  seam: false,
  degenerate: false,
  length: 1,
  start,
  end,
  mid: start,
});
const face = (index: number, name: string): ShapeFace => ({ index, name, surface: index < 2 ? 'plane' : 'bspline', area: 1 });

function fixture(options: { sharpFaces?: number[]; patchNames?: [string, string] } = {}): { topology: ShapeTopology; graph: FaceGraph } {
  const topology = {
    solids: 1,
    faces: [
      face(0, 'box:x0'),
      face(1, 'box:y0'),
      face(2, options.patchNames?.[0] ?? 'blend(v:e(a|b),e(c|d))#1'),
      face(3, options.patchNames?.[1] ?? 'blend(v:e(a|b),e(c|d))#2'),
    ],
    edges: [edge(0, [0, 0, 2], [0, 0, 10]), edge(1, [0, 0, 2], [2, 0, 1]), edge(2, [0, 0, 2], [0.7, 0.7, 0.4])],
    vertices: 0,
    volume: 1,
  } as ShapeTopology;
  const graph = { faces: [], edgeFaces: [options.sharpFaces ?? [0, 1], [1, 2], [2, 3]], edgeConvexity: [] } as unknown as FaceGraph;
  return { topology, graph };
}

// 90 degrees at the sharp edge, fading to the pole
const fading = Array.from({ length: 11 }, (_, at) => sample((Math.PI / 2) * (1 - at / 10) ** 2));
const sharp = [sample(Math.PI / 2), sample(Math.PI / 2), sample(Math.PI / 2)];
const tolerances = { g0: 1e-6, g1AngleRad: 0.01, g2Rel: 0.1 };
const at = { entityId: 'mesh-1', face: 2, edge: 2, name: 'e(x|y)', unit: 'mm' };

describe('creaseSpoke', () => {
  it('recognises an edge between two sub-patches that leaves the end of a sharp edge of the part', () => {
    const { topology, graph } = fixture();
    const found = creaseSpoke(topology, graph, 2, fading, () => sharp);
    expect(found).toMatchObject({ sharpEdge: 0, fades: true });
    expect(found?.entryRad).toBeCloseTo(Math.PI / 2, 12);
    expect(found?.dihedralRad).toBeCloseTo(Math.PI / 2, 12);
    expect(found?.poleRad).toBe(0);
  });

  it('reads the spoke from either end: reversed samples give the same entry and pole', () => {
    const { topology, graph } = fixture();
    const reversedEdge = { ...topology.edges[2], start: [0.7, 0.7, 0.4], end: [0, 0, 2] } as ShapeEdge;
    const reversed = { ...topology, edges: [topology.edges[0], topology.edges[1], reversedEdge] } as ShapeTopology;
    const found = creaseSpoke(reversed, graph, 2, [...fading].reverse(), () => [...sharp].reverse());
    expect(found?.entryRad).toBeCloseTo(Math.PI / 2, 12);
    expect(found?.fades).toBe(true);
  });

  it('is not a crease spoke when it is an ordinary tangent spoke, when a face is not a corner patch, when nothing sharp is at its end or the kernel cannot read it', () => {
    const { topology, graph } = fixture();
    expect(
      creaseSpoke(
        topology,
        graph,
        2,
        fading.map(() => sample(0.004)),
        () => sharp,
      ),
    ).toBeNull();
    expect(creaseSpoke(topology, graph, 1, fading, () => sharp)).toBeNull();
    const named = fixture({ patchNames: ['blend(e(a|b))', 'blend(v:e(a|b))#2'] });
    expect(creaseSpoke(named.topology, named.graph, 2, fading, () => sharp)).toBeNull();
    // the edge at the entry point has a blend face: not a sharp edge of the part
    const blended = fixture({ sharpFaces: [0, 2] });
    expect(creaseSpoke(blended.topology, blended.graph, 2, fading, () => sharp)).toBeNull();
    expect(creaseSpoke(topology, graph, 2, fading, () => null)).toBeNull();
    expect(creaseSpoke(topology, graph, 2, fading, () => [])).toBeNull();
    expect(creaseSpoke(topology, graph, 9, fading, () => sharp)).toBeNull();
  });

  it('reports a spoke whose angle rises along it as not fading', () => {
    const { topology, graph } = fixture();
    const bump = fading.map((one, index) => (index === 6 ? sample(1.2) : one));
    expect(creaseSpoke(topology, graph, 2, bump, () => sharp)?.fades).toBe(false);
  });
});

describe('judgeCrease', () => {
  const spoke = (overrides: Partial<NonNullable<ReturnType<typeof creaseSpoke>>> = {}): NonNullable<ReturnType<typeof creaseSpoke>> => ({
    sharpEdge: 0,
    entryRad: Math.PI / 2,
    dihedralRad: Math.PI / 2,
    poleRad: 0.004,
    fades: true,
    ...overrides,
  });

  it('passes a spoke that leaves at the dihedral angle of the sharp edge, fades, and is closed at the pole: a crease row with the pole reading', () => {
    const row = judgeCrease(spoke(), fading, at, tolerances);
    expect(row.findings).toEqual([]);
    expect(row.contact).toMatchObject({ edge: 2, name: 'e(x|y)', order: 'crease', g1AngleRad: 0.004, g0Gap: 0 });
    expect(row.contact.creaseRad).toBeCloseTo(Math.PI / 2, 8);
  });

  it('fails an entry angle that is not the dihedral of the sharp edge, a spoke that does not fade, and a G0 gap; warns on a pole that is not closed', () => {
    const codes = (found: ReturnType<typeof judgeCrease>): string[] =>
      found.findings.map((finding) => `${finding.code}:${finding.severity}`);
    expect(codes(judgeCrease(spoke({ entryRad: 1.2 }), fading, at, tolerances))).toEqual(['BLD_CHECK_G1_ANGLE:fail']);
    expect(codes(judgeCrease(spoke({ fades: false }), fading, at, tolerances))).toEqual(['BLD_CHECK_G1_ANGLE:fail']);
    expect(codes(judgeCrease(spoke({ poleRad: 0.02 }), fading, at, tolerances))).toEqual(['BLD_CHECK_G1_ANGLE:warn']);
    expect(codes(judgeCrease(spoke(), [sample(1, 1e-3), ...fading], at, tolerances))).toEqual(['BLD_CHECK_G0_GAP:fail']);
    const unnamed = judgeCrease(spoke(), fading, { ...at, name: undefined }, tolerances);
    expect('name' in unnamed.contact).toBe(false);
  });
});
