/**
 * BLD M1: the radius readback of check_blends (`radius { min, max, at }`, BLD_CHECK_RADIUS_LAW) and the pure helpers under it, over a scripted
 * kernel that sections the blend face (native values: server/tests/nativeBlendLaws.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import type { BlendSection, FaceGraph } from '@core/geometry/kernelPorts';
import {
  blendFaceContacts,
  exactParameters,
  filletNodes,
  isolatedEdge,
  lawsOfNode,
  radiusAtT,
  radiusSamples,
  sameDirection,
} from '@core/geometry/blend/blendInfo';
import { checkRadius, type LawRecord } from '@core/commands/brep/checkBlendRadius';
import type { ShapeHandle } from '@core/geometry/kernelTypes';
import type { EdgeRadius } from '@core/model/types';
import { scriptedKernel, edgeOf } from '../helpers/blendKernel';
import { expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

const S = 'box-1.1';
const SOURCE_EDGE = `e(${S}:y+|${S}:z+)`;
const line = (index: number, name: string, y: number): ShapeTopology['edges'][number] =>
  edgeOf(index, { name, start: [-10, y, 2.5], end: [10, y, 2.5], mid: [0, y, 2.5] });
const TOPOLOGY: ShapeTopology = {
  solids: 1,
  faces: [
    { index: 0, name: `${S}:z+`, surface: 'plane', area: 160, normal: [0, 0, 1] },
    { index: 1, name: `${S}:y+`, surface: 'plane', area: 60, normal: [0, 1, 0] },
    { index: 2, name: `blend(${SOURCE_EDGE})`, surface: 'bspline', area: 40 },
    { index: 3, name: `${S}:x-`, surface: 'plane', area: 20, normal: [-1, 0, 0] },
  ],
  // contact edges (blend | z+ at y = 4) and (blend | y+ at y = 5, z = 1.5), the source edge at (5, 2.5), nothing else
  edges: [
    line(0, `e(blend|${S}:z+)`, 4),
    edgeOf(1, { name: `e(blend|${S}:y+)`, start: [-10, 5, 1.5], end: [10, 5, 1.5], mid: [0, 5, 1.5] }),
    line(2, 'end', 40),
    line(3, SOURCE_EDGE, 5),
  ],
  vertices: 8,
  volume: 1000,
};
const GRAPH = {
  faces: [],
  edgeFaces: [
    [2, 0],
    [2, 1],
    [2, 3],
    [0, 1],
  ],
  edgeConvexity: [],
} as unknown as FaceGraph;

/** Sections along x from -10 to 10 (or back), radius `radius(t)`; `reverse` runs the contact edge the other way. */
const sectionsOf =
  (radius: (t: number) => number | null, reverse = false) =>
  (_face: number, count: number): BlendSection[] =>
    Array.from({ length: count }, (_, k) => {
      const t = k / (count - 1);
      const x = reverse ? 10 - 20 * t : -10 + 20 * t;
      const r = radius(t);
      return { t, a: [x, 4, 2.5], mid: [x, 4.3, 2.2], b: [x, 5, 1.5], radius: r, centre: r === null ? null : [x, 4, 1.5] };
    });

type Sections = ((face: number, count: number) => readonly BlendSection[] | null) | null | undefined;

function kernelWith(
  sections: Sections,
  options: { reverse?: boolean; extraEdges?: ShapeTopology['edges'] } = {},
): ReturnType<typeof scriptedKernel> {
  return scriptedKernel({
    topology: { ...TOPOLOGY, edges: [...TOPOLOGY.edges, ...(options.extraEdges ?? [])] },
    graph: GRAPH,
    g1: () => 0,
    sections,
    edgePoint: (_edge, t) => [options.reverse === true ? 10 - 20 * t : -10 + 20 * t, 5, 2.5],
  });
}

const context = (kernel: GeometryKernel): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel });
const filleted = (kernel: GeometryKernel, edgeLaw: Record<string, unknown>): { doc: CadDocument; id: string } => {
  const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  const result = execute(made.document, 'fillet_edge', { id: made.affected[0], edges: [{ index: 3, ...edgeLaw }] }, context(kernel));
  return { doc: result.document, id: result.affected[0] as string };
};
interface Row {
  radius?: { min: number; max: number; at: Array<{ t: number; value: number }> };
  lawChecked?: boolean;
}
const check = (
  kernel: GeometryKernel,
  doc: CadDocument,
  params: Record<string, unknown> = {},
): { rows: Row[]; findings: Array<{ code: string; severity: string; value?: number; limit?: number }>; status: string } => {
  const result = execute(doc, 'check_blends', params, context(kernel));
  const data = result.data as {
    blends: Row[];
    findings: Array<{ code: string; severity: string; value?: number; limit?: number }>;
    status: string;
  };
  return { rows: data.blends, findings: data.findings, status: data.status };
};

describe('check_blends radius readback', () => {
  it('a constant radius: min = max = r, a sample at every requested t, the law compared and met', () => {
    const kernel = kernelWith(sectionsOf(() => 1));
    const { doc } = filleted(kernel, { size: 1 });
    const { rows, findings, status } = check(kernel, doc, { samples: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.radius).toMatchObject({ min: 1, max: 1 });
    expect(rows[0]?.radius?.at.map((sample) => sample.t)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(rows[0]?.lawChecked).toBe(true);
    expect(findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_RADIUS_LAW');
    expect(status).toBe('pass');
    expectPure(doc, () => execute(doc, 'check_blends', {}, context(kernel)));
  });

  it('BLD_CHECK_RADIUS_LAW (fail) when the realised radius is off the law, with the deviation and the limit', () => {
    const kernel = kernelWith(sectionsOf(() => 1.2));
    const { doc } = filleted(kernel, { size: 1 });
    const { findings, status } = check(kernel, doc);
    const found = findings.filter((finding) => finding.code === 'BLD_CHECK_RADIUS_LAW');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toMatchObject({ severity: 'fail', limit: 1e-4 });
    expect(found[0]?.value).toBeCloseTo(0.2, 9);
    expect(status).toBe('fail');
  });

  it('a straight-piece law is compared everywhere, in the direction the edge runs (reversed sections still match)', () => {
    const law = { size: 1, sizeEnd: 2, interpolation: 'linear' as const };
    const forward = kernelWith(sectionsOf((t) => 1 + t));
    expect(check(forward, filleted(forward, law).doc).findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_RADIUS_LAW');
    const reversed = kernelWith(sectionsOf((t) => 2 - t, true));
    expect(check(reversed, filleted(reversed, law).doc).findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_RADIUS_LAW');
    const wrong = kernelWith(sectionsOf((t) => 1 + t, true));
    const found = check(wrong, filleted(wrong, law).doc).findings.filter((finding) => finding.code === 'BLD_CHECK_RADIUS_LAW');
    expect(found.length).toBeGreaterThan(5);
  });

  it('a smooth law with a control point is compared at the control point and the ends; the control t is read back', () => {
    const kernel = kernelWith(sectionsOf((t) => 1 + 4 * t * (1 - t)));
    const { doc } = filleted(kernel, { size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }] });
    const { rows, findings } = check(kernel, doc, { samples: 3 });
    expect(rows[0]?.lawChecked).toBe(true);
    expect(rows[0]?.radius?.at.find((sample) => sample.t === 0.5)?.value).toBeCloseTo(2, 6);
    expect(rows[0]?.radius?.max).toBeCloseTo(2, 6);
    expect(findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_RADIUS_LAW');
    const off = kernelWith(sectionsOf((t) => 1 + 2 * t * (1 - t)));
    expect(
      check(off, filleted(off, { size: 1, sizeEnd: 1, sizes: [{ t: 0.5, size: 2 }] }).doc).findings.map((finding) => finding.code),
    ).toContain('BLD_CHECK_RADIUS_LAW');
  });

  it('a varying law on an edge that continues tangentially into another is read back but not compared', () => {
    const continuing = edgeOf(4, { name: 'next', start: [10, 5, 2.5], end: [30, 5, 2.5], mid: [20, 5, 2.5] });
    const kernel = kernelWith(
      sectionsOf((t) => 5 + t),
      { extraEdges: [continuing] },
    );
    const { doc } = filleted(kernel, { size: 1, sizeEnd: 2, interpolation: 'linear' });
    const { rows, findings } = check(kernel, doc);
    expect(rows[0]?.lawChecked).toBe(false);
    expect(rows[0]?.radius?.min).toBeCloseTo(5, 9);
    expect(findings.map((finding) => finding.code)).not.toContain('BLD_CHECK_RADIUS_LAW');
  });

  it('a conic or curvature section names its profile and reads no radius (a circle through its points would mean nothing)', () => {
    const kernel = kernelWith(sectionsOf(() => 1));
    const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const done = execute(
      made.document,
      'fillet_edge',
      { id: made.affected[0], edges: [{ index: 3, size: 1 }], profile: { type: 'conic', rho: 0.5 } },
      context(kernel),
    );
    const { rows } = check(kernel, done.document);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ profile: 'conic', sourceEdges: [SOURCE_EDGE] });
    expect(rows[0]).not.toHaveProperty('radius');
    const circular = filleted(kernel, { size: 1 });
    expect(check(kernel, circular.doc).rows[0]).toMatchObject({ profile: 'circular', lawChecked: true });
  });

  it('no radius is reported when the kernel cannot section the face, or a section is flat', () => {
    for (const sections of [undefined, null, () => null, sectionsOf(() => null)]) {
      const kernel = kernelWith(sections);
      const { doc } = filleted(kernel, { size: 1 });
      const { rows } = check(kernel, doc);
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('radius');
    }
  });
});

describe('radius law over a setback blend (checkRadius)', () => {
  // an edge from x = -10 to 10 whose blend covers x = -8 .. 8 (setbacks of 2 at both ends): sections along it, mid points on the edge line
  const covered =
    (radius: (t: number) => number, reverse = false) =>
    (_face: number, count: number): BlendSection[] =>
      Array.from({ length: count }, (_, k) => {
        const t = k / (count - 1);
        const x = reverse ? 8 - 16 * t : -8 + 16 * t;
        return { t, a: [x, 4, 2.5], mid: [x, 5, 2.5], b: [x, 5, 1.5], radius: radius(t), centre: [x, 4, 1.5] };
      });
  const run = (law: EdgeRadius, setback: boolean, sections: ReturnType<typeof covered>): ReturnType<typeof checkRadius> => {
    const kernel = kernelWith(sections);
    const shape = {} as ShapeHandle;
    const record: LawRecord = { node: 0, law, shape, topology: TOPOLOGY, edge: 3, chain: new Set(), setback };
    return checkRadius(kernel, shape, { face: 2, name: 'b', sourceEdge: SOURCE_EDGE, contacts: [0, 1] }, record, 5);
  };
  const linear: EdgeRadius = { size: 1, sizeEnd: 2, interpolation: 'linear' };

  it('a linear law is read over the span the blend covers: 1.1 at its first section, 1.9 at its last, in either direction', () => {
    const met = run(
      linear,
      true,
      covered((t) => 1.1 + 0.8 * t),
    );
    expect(met).toMatchObject({ lawChecked: true, deviations: [] });
    expect(met.radius?.at[0]?.value).toBeCloseTo(1.1, 9);
    const backwards = run(
      linear,
      true,
      covered((t) => 1.9 - 0.8 * t, true),
    );
    expect(backwards).toMatchObject({ lawChecked: true, deviations: [] });
  });

  it('a reversed taper, a taper read over the whole edge and a wrong constant are deviations', () => {
    expect(
      run(
        linear,
        true,
        covered((t) => 1.9 - 0.8 * t),
      ).deviations.length,
    ).toBeGreaterThan(5);
    expect(
      run(
        linear,
        true,
        covered((t) => 1 + t),
      ).deviations.length,
    ).toBeGreaterThan(5);
    const constant: EdgeRadius = { size: 1.5 };
    expect(
      run(
        constant,
        true,
        covered(() => 1.5),
      ),
    ).toMatchObject({ lawChecked: true, deviations: [] });
    expect(
      run(
        constant,
        true,
        covered(() => 1.4),
      ).deviations.length,
    ).toBeGreaterThan(5);
  });

  it('without a setback the same sections are compared with the whole edge (the previous behaviour)', () => {
    expect(
      run(
        linear,
        false,
        covered((t) => 1 + t),
      ).deviations,
    ).toHaveLength(0);
  });
});

describe('blendInfo helpers', () => {
  it('blendFaceContacts: the blend face with its two contact edges; faces without both contacts are skipped', () => {
    const found = blendFaceContacts(TOPOLOGY, GRAPH);
    expect(found).toEqual([{ face: 2, name: `blend(${SOURCE_EDGE})`, sourceEdge: SOURCE_EDGE, contacts: [1, 0] }]);
    const lonely = {
      ...GRAPH,
      edgeFaces: [
        [2, 0],
        [0, 1],
        [2, 3],
        [0, 1],
      ],
    } as unknown as FaceGraph;
    expect(blendFaceContacts(TOPOLOGY, lonely)).toEqual([]);
  });

  it('radiusSamples and radiusAtT: interpolation between samples, clamped outside', () => {
    const sections = sectionsOf((t) => 1 + t)(2, 3);
    const samples = radiusSamples(sections) ?? [];
    expect(samples.map((sample) => sample.radius)).toEqual([1, 1.5, 2]);
    expect(radiusAtT(samples, 0)).toBe(1);
    expect(radiusAtT(samples, 0.25)).toBeCloseTo(1.25, 12);
    expect(radiusAtT(samples, 0.5)).toBe(1.5);
    expect(radiusAtT(samples, 1)).toBe(2);
    expect(radiusAtT(samples, 1.5)).toBe(2);
    expect(radiusAtT([], 0.5)).toBeNaN();
    expect(radiusSamples(sectionsOf(() => null)(2, 3))).toBeNull();
  });

  it('sameDirection: forward, reversed, undecidable (a closed symmetric edge, missing data)', () => {
    const sections = sectionsOf((t) => 1 + t)(2, 5);
    const along = (t: number): [number, number, number] => [-10 + 20 * t, 4.3, 2.2];
    expect(sameDirection(sections, along)).toBe(true);
    expect(sameDirection(sections, (t) => along(1 - t))).toBe(false);
    expect(sameDirection(sections, () => [0, 0, 0])).toBeNull();
    expect(sameDirection(sections, () => null)).toBeNull();
    expect(sameDirection([], along)).toBeNull();
  });

  it('filletNodes walks sources, booleans, blends and chamfers; lawsOfNode and exactParameters read the laws', () => {
    const leaf: ShapeRecipe = { op: 'solid', entity: { id: 'b', kind: 'box' } as never };
    const inner: ShapeRecipe = { op: 'fillet', source: leaf, edges: [1], size: 1 };
    const outer: ShapeRecipe = { op: 'fillet', source: inner, edges: [0, 2], size: 0, radii: [{ size: 1 }, { size: 2, sizeEnd: 3 }] };
    expect(filletNodes(outer)).toHaveLength(2);
    expect(filletNodes({ op: 'chamfer', source: inner, edges: [0], size: 1 })).toHaveLength(1);
    expect(filletNodes({ op: 'boolean', boolean: 'union', a: inner, b: outer })).toHaveLength(3);
    expect(filletNodes({ op: 'blend', sources: [inner, leaf], radius: 1 })).toHaveLength(1);
    expect(filletNodes({ op: 'place', source: inner, position: [0, 0, 0], rotation: [0, 0, 0] })).toHaveLength(1);
    expect(filletNodes({ op: 'brep', blob: 'x', format: 'occt-brep-v1' })).toEqual([]);
    expect(lawsOfNode(inner)).toEqual([{ size: 1 }]);
    expect(lawsOfNode({ ...inner, sizeEnd: 2 })).toEqual([{ size: 1, sizeEnd: 2 }]);
    expect(lawsOfNode(outer)).toEqual([{ size: 1 }, { size: 2, sizeEnd: 3 }]);
    expect(exactParameters({ size: 1 })).toBe('all');
    expect(exactParameters({ size: 1, sizeEnd: 2, interpolation: 'linear' })).toBe('all');
    expect(exactParameters({ size: 1, sizeEnd: 2 })).toEqual([0, 1]);
    expect(exactParameters({ size: 1, sizes: [{ t: 0.4, size: 2 }] })).toEqual([0, 0.4, 1]);
  });

  it('isolatedEdge: false when another edge continues it at either end, true for a corner, false for an unknown edge or degenerate tangents', () => {
    const own = edgeOf(0, { start: [0, 0, 0], end: [10, 0, 0], mid: [5, 0, 0] });
    const topology = (...others: ShapeTopology['edges']): ShapeTopology => ({ ...TOPOLOGY, edges: [own, ...others] });
    const continuing = edgeOf(1, { start: [10, 0, 0], end: [20, 0, 0], mid: [15, 0, 0] });
    const folded = edgeOf(2, { start: [0, 0, 0], end: [-10, 0, 0], mid: [-5, 0, 0] });
    const corner = edgeOf(3, { start: [10, 0, 0], end: [10, 10, 0], mid: [10, 5, 0] });
    expect(isolatedEdge(topology(), 0)).toBe(true);
    expect(isolatedEdge(topology(corner), 0)).toBe(true);
    expect(isolatedEdge(topology(continuing), 0)).toBe(false);
    expect(isolatedEdge(topology(folded), 0)).toBe(false);
    expect(isolatedEdge(topology(), 9)).toBe(false);
    const withSamples = edgeOf(4, {
      start: [10, 0, 0],
      end: [20, 0, 0],
      mid: [15, 0, 0],
      samples: [
        [10, 0, 0],
        [15, 0, 0],
        [20, 0, 0],
      ],
    });
    const curved: ShapeTopology['edges'][number] = {
      ...own,
      samples: [
        [0, 0, 0],
        [5, 0.0001, 0],
        [10, 0, 0],
      ],
    };
    expect(isolatedEdge({ ...TOPOLOGY, edges: [curved, withSamples] }, 0)).toBe(false);
    const stub = edgeOf(5, { start: [10, 0, 0], end: [10, 0, 0], mid: [10, 0, 0] });
    expect(isolatedEdge(topology(stub), 0)).toBe(false);
    const skipped = edgeOf(6, { start: [10, 0, 0], end: [20, 0, 0], seam: true });
    expect(isolatedEdge(topology(skipped), 0)).toBe(true);
  });
});

describe('check_blends over a blend_union (the radius of each joint is verified)', () => {
  const report =
    (radius: number, source = 'default'): NonNullable<GeometryKernel['blendReport']> =>
    () => ({
      stage: 'blend',
      contours: [],
      vertices: [],
      partial: false,
      unsupportedVertices: [],
      done: true,
      valid: true,
      notes: { builder: 'union', picks: [], contours: [{ radius, source, edges: [SOURCE_EDGE] }] },
    });
  const unioned = (kernel: GeometryKernel): { doc: CadDocument; id: string } => {
    const first = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const second = execute(first.document, 'add_box', { size: [4, 4, 4], position: [0, 0, 5] });
    const result = execute(second.document, 'blend_union', { ids: [first.affected[0], second.affected[0]], radius: 1 }, context(kernel));
    return { doc: result.document, id: result.affected[0] as string };
  };

  it('the realised radius of the joint equals the one the union gave it: pass, the law compared', () => {
    const kernel = { ...kernelWith(sectionsOf(() => 1)), blendReport: report(1) };
    const { doc } = unioned(kernel);
    const { rows, findings, status } = check(kernel, doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lawChecked: true, radius: { min: 1, max: 1 }, source: 'default' });
    expect(findings.filter((finding) => finding.code === 'BLD_CHECK_RADIUS_LAW')).toEqual([]);
    expect(status).toBe('pass');
  });

  it('each joint row says where its radius came from: the pick (joints[i]) or the default, so a mis-pick is visible', () => {
    const kernel = { ...kernelWith(sectionsOf(() => 1)), blendReport: report(1, 'joints[2]') };
    const { doc } = unioned(kernel);
    expect(check(kernel, doc).rows[0]).toMatchObject({ source: 'joints[2]' });
  });

  it('BLD_CHECK_RADIUS_LAW (fail) when the joint is rounded with another radius than the union gave it', () => {
    const kernel = { ...kernelWith(sectionsOf(() => 1.5)), blendReport: report(1) };
    const { doc } = unioned(kernel);
    const { findings, status } = check(kernel, doc);
    const found = findings.filter((finding) => finding.code === 'BLD_CHECK_RADIUS_LAW');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toMatchObject({ severity: 'fail', limit: 1e-4 });
    expect(found[0]?.value).toBeCloseTo(0.5, 9);
    expect(status).toBe('fail');
  });

  it('a kernel that reports no contours verifies nothing and still reads the radius back', () => {
    const kernel = kernelWith(sectionsOf(() => 1.5));
    const { doc } = unioned(kernel);
    const { rows, status } = check(kernel, doc);
    expect(rows[0]).toMatchObject({ radius: { min: 1.5, max: 1.5 } });
    expect(rows[0]).not.toHaveProperty('lawChecked', true);
    expect(rows[0]).not.toHaveProperty('source');
    expect(status).toBe('pass');
  });
});
