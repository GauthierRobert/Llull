/**
 * BLD M0: OCCT failure report -> stable BLD_* codes (`diagnoseBlend`), the radius bisection, the coded refusal of fillet_edge, probe_fillet
 * and check_blends, over a scripted kernel (the native values are asserted in server/tests/nativeBlends.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel, type ShapeAnalysis, type ShapeTopology } from '@core/geometry/kernel';
import type { BlendReport, FaceGraph } from '@core/geometry/kernelPorts';
import { handleOf } from '@core/geometry/shapeKernel';
import { diagnoseBlend, remediationOf } from '@core/geometry/blend/diagnose';
import { bisectLargestRadius } from '@core/geometry/blend/probe';
import { type ContactSample, blendSource, hasFillet, measureContact, splitEdgeName } from '@core/geometry/blend/continuity';
import { TETRA } from '../helpers/fakeKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

const report = (extra: Partial<BlendReport>): BlendReport => ({
  stage: 'contours',
  contours: [],
  vertices: [],
  partial: false,
  unsupportedVertices: [],
  done: false,
  valid: false,
  ...extra,
});

describe('diagnoseBlend: OCCT report -> BLD_* code', () => {
  const contour = (status: BlendReport['contours'][number]['status']): BlendReport =>
    report({ contours: [{ edges: [3, 4], status }], done: false });

  it('maps every StripeStatus to its code and keeps the contour edges', () => {
    expect(diagnoseBlend(contour('startsol_failure'))).toMatchObject({ code: 'BLD_RADIUS_TOO_LARGE', edges: [3, 4] });
    expect(diagnoseBlend(contour('walking_failure'))?.code).toBe('BLD_WALKING_FAILURE');
    expect(diagnoseBlend(contour('twisted_surface'))?.code).toBe('BLD_TWISTED_SURFACE');
    expect(diagnoseBlend(contour('error'))?.code).toBe('BLD_INVALID_RESULT');
  });

  it('BLD_CORNER_UNSUPPORTED only for a faulty vertex of 4+ edges, BLD_CORNER_FAILED otherwise', () => {
    const faulty = (edges: number[]): BlendReport =>
      report({ stage: 'corners', contours: [{ edges: [0], status: 'ok' }], vertices: [{ point: [1, 2, 3], edges }] });
    expect(diagnoseBlend(faulty([0, 1, 2, 3]))).toMatchObject({ code: 'BLD_CORNER_UNSUPPORTED', vertex: [1, 2, 3], edges: [0, 1, 2, 3] });
    expect(diagnoseBlend(faulty([0, 1, 2]))?.code).toBe('BLD_CORNER_FAILED');
    const unlisted = report({
      stage: 'none',
      done: true,
      valid: true,
      unsupportedVertices: [{ point: [0, 0, 0], edgeCount: 4, selectedEdgeCount: 4 }],
    });
    expect(diagnoseBlend(unlisted)).toBeNull();
  });

  it('a build that threw before any contour existed is BLD_INVALID_RESULT with the OCCT message', () => {
    expect(diagnoseBlend(report({ stage: 'contours', message: 'edge index or radius law out of range' }))).toMatchObject({
      code: 'BLD_INVALID_RESULT',
      message: expect.stringContaining('out of range'),
    });
  });

  it('a result without a vertex or a contour error is BLD_INVALID_RESULT; a build that works has no diagnosis', () => {
    expect(diagnoseBlend(report({ stage: 'validity', done: true }))?.code).toBe('BLD_INVALID_RESULT');
    expect(diagnoseBlend(report({ stage: 'corners' }))?.code).toBe('BLD_INVALID_RESULT');
    expect(diagnoseBlend(report({ stage: 'none', done: true, valid: true, contours: [{ edges: [0], status: 'ok' }] }))).toBeNull();
    expect(remediationOf('BLD_RADIUS_TOO_LARGE')).toContain('probe_fillet');
  });
});

describe('bisectLargestRadius', () => {
  it('finds the limit within the tolerance and never exceeds the evaluation budget', () => {
    const outcome = bisectLargestRadius((radius) => radius <= 3.2, 5, 0.01, 12);
    expect(outcome.maxRadius).toBeLessThanOrEqual(3.2);
    expect(outcome.maxRadius).toBeGreaterThan(3.19);
    expect(outcome.refusedAt).toBeGreaterThan(3.2);
    expect(outcome.evaluations).toBeLessThanOrEqual(12);
    expect(bisectLargestRadius(() => true, 5, 0.01, 12)).toEqual({ maxRadius: 5, evaluations: 1 });
    expect(bisectLargestRadius(() => false, 5, 0.01, 4).maxRadius).toBe(0);
    expect(bisectLargestRadius(() => true, 0, 0.01, 4).evaluations).toBe(0);
    expect(bisectLargestRadius(() => true, 5, 0, 4).evaluations).toBe(0);
    expect(bisectLargestRadius(() => true, 5, 0.1, 0).evaluations).toBe(0);
  });
});

describe('bisectLargestRadius growth', () => {
  it('doubles past a guess that builds up to the cap, then bisects; the budget and the cap end the search', () => {
    const grown = bisectLargestRadius((radius) => radius <= 8.3, 5, 0.01, 12, 40);
    expect(grown.maxRadius).toBeGreaterThan(8.29);
    expect(grown.maxRadius).toBeLessThanOrEqual(8.3);
    expect(grown.refusedAt).toBeGreaterThan(8.3);
    expect(bisectLargestRadius(() => true, 5, 0.01, 12, 12)).toEqual({ maxRadius: 12, evaluations: 3 });
    expect(bisectLargestRadius(() => true, 5, 0.01, 1, 100)).toEqual({ maxRadius: 5, evaluations: 1 });
    expect(bisectLargestRadius(() => true, 5, 0.01, 12, 3)).toEqual({ maxRadius: 5, evaluations: 1 });
  });
});

describe('continuity helpers', () => {
  it('splits persistent names at the top-level bar', () => {
    expect(splitEdgeName('e(a|b)')).toEqual(['a', 'b']);
    expect(splitEdgeName('e(blend(e(a|b))|c)')).toEqual(['blend(e(a|b))', 'c']);
    expect(splitEdgeName('a|b')).toBeNull();
    expect(splitEdgeName('e(ab)')).toBeNull();
    expect(blendSource('blend(e(a|b))')).toEqual({ edge: 'e(a|b)', supports: ['a', 'b'] });
    expect(blendSource('a:top')).toBeNull();
    expect(blendSource('blend(v:x)')).toBeNull();
  });

  it('rates a contact G0 / G1 / G2 from the normal angle and the relative curvature jump', () => {
    const sample = (g1: number, k: [number, number], g0 = 0): ContactSample => ({ t: 0, g0, g1, normalCurvature: k });
    const tolerances = { g0: 1e-6, g1AngleRad: 0.01, g2Rel: 0.1 };
    expect(measureContact([sample(0, [0, 2]), sample(0, [0, 2])], tolerances)).toMatchObject({ order: 'G1', g2Gap: 2, g2Rel: 1 });
    expect(measureContact([sample(0, [2, 1.95])], tolerances)?.order).toBe('G2');
    expect(measureContact([sample(0, [0, 0])], tolerances)).toMatchObject({ order: 'G2', g2Rel: 0 });
    expect(measureContact([sample(Math.PI / 2, [0, 0])], tolerances)?.order).toBe('G0');
    expect(measureContact([sample(0, [0, 0], 1e-3)], tolerances)).toMatchObject({ order: 'none', g0Gap: 1e-3 });
    expect(measureContact([], tolerances)).toBeNull();
  });

  it('finds fillets through booleans, blends and sources', () => {
    const box: ShapeRecipe = { op: 'solid', entity: { id: 'b', kind: 'box' } as never };
    const fillet: ShapeRecipe = { op: 'fillet', source: box, edges: [0], size: 1 };
    expect(hasFillet(box)).toBe(false);
    expect(hasFillet(fillet)).toBe(true);
    expect(hasFillet({ op: 'chamfer', source: fillet, edges: [0], size: 1 })).toBe(true);
    expect(hasFillet({ op: 'boolean', boolean: 'union', a: box, b: fillet })).toBe(true);
    expect(hasFillet({ op: 'blend', sources: [box, fillet], radius: 1 } as ShapeRecipe)).toBe(true);
    expect(hasFillet({ op: 'brep', blob: 'x' } as ShapeRecipe)).toBe(false);
  });
});

const S = 'box-1.1';
const TOPOLOGY: ShapeTopology = {
  solids: 1,
  faces: [
    { index: 0, name: `${S}:z+`, surface: 'plane', area: 200, normal: [0, 0, 1] },
    { index: 1, name: `${S}:y+`, surface: 'plane', area: 100, normal: [0, 1, 0] },
    { index: 2, name: `blend(e(${S}:y+|${S}:z+))`, surface: 'bspline', area: 40 },
    { index: 3, name: `${S}:x-`, surface: 'plane', area: 20, normal: [-1, 0, 0] },
  ],
  edges: [0, 1, 2, 3].map((index) => ({
    index,
    name: ['e(blend|z+)', 'e(blend|y+)', 'e(blend|x-)', 'e(y+|z+)'][index] as string,
    curve: 'line' as const,
    length: 20,
    start: [0, 0, 0] as [number, number, number],
    end: [20, 0, 0] as [number, number, number],
    mid: [10, 5, 2.5] as [number, number, number],
    seam: false,
    degenerate: false,
  })),
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

interface Script {
  /** Largest size that builds (a fillet node with a larger size or radii entry is refused). */
  limit?: number;
  report?: BlendReport | null;
  noReport?: boolean;
  names?: boolean;
  /** Normal curvature pair per contact edge; null = the kernel cannot answer. */
  curvature?: [number, number] | null;
  normalAngle?: number;
  analysis?: ShapeAnalysis | null;
  noFaceQuery?: boolean;
  noFillet?: boolean;
  noMass?: boolean;
  /** G0 gap reported by every contact sample. */
  gap?: number;
}

function scripted(script: Script = {}): GeometryKernel & { evaluations: number; reports: number } {
  const state = { evaluations: 0, reports: 0 };
  const scales = new Map<unknown, number>();
  const sizeOf = (recipe: ShapeRecipe): number =>
    recipe.op === 'fillet' ? Math.max(recipe.size, recipe.sizeEnd ?? 0, ...(recipe.radii ?? []).map((law) => law.size)) : 0;
  const strip = (topology: ShapeTopology): ShapeTopology =>
    script.names === false
      ? {
          ...topology,
          faces: topology.faces.map(({ name: _name, ...face }) => face),
          edges: topology.edges.map(({ name: _name, ...edge }) => edge),
        }
      : topology;
  const kernel: GeometryKernel = {
    name: 'scripted',
    supports: (op) => (script.noFillet === true ? op !== 'fillet' : true),
    evaluate: (recipe) => {
      state.evaluations++;
      if (recipe.op === 'fillet' && script.limit !== undefined && sizeOf(recipe) > script.limit) return null;
      const handle = handleOf(recipe);
      scales.set(handle, recipe.op === 'fillet' ? sizeOf(recipe) : 1);
      return handle;
    },
    tessellate: () => TETRA,
    topology: () => strip(TOPOLOGY),
    exportStep: () => null,
    analyze: () => script.analysis ?? null,
    ...(script.noMass === true
      ? {}
      : {
          massProperties: (shape: unknown) => {
            const scale = scales.get(shape) ?? 1;
            return { bounds: { min: [0, 0, 0], max: [20 * scale, 10 * scale, 5 * scale] } } as never;
          },
        }),
    ...(script.noReport === true
      ? {}
      : {
          blendReport: () => {
            state.reports++;
            return script.report === undefined ? null : script.report;
          },
        }),
    ...(script.noFaceQuery === true
      ? {}
      : {
          faceQuery: {
            faceGraph: () => GRAPH,
            edgeContinuity: (_shape: unknown, edge: number) =>
              script.curvature === null || edge > 1
                ? null
                : [0, 0.5, 1].map((t) => ({
                    t,
                    point: [t, 0, 0] as [number, number, number],
                    g0: script.gap ?? 0,
                    g1: script.normalAngle ?? 0,
                    normalCurvature: script.curvature ?? ([0, 1] as [number, number]),
                  })),
          } as unknown as NonNullable<GeometryKernel['faceQuery']>,
        }),
  };
  return Object.defineProperties(kernel, {
    evaluations: { get: () => state.evaluations },
    reports: { get: () => state.reports },
  }) as GeometryKernel & { evaluations: number; reports: number };
}

const context = (kernel: GeometryKernel): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel });
const box = (): { doc: CadDocument; id: string } => {
  const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  return { doc: made.document, id: made.affected[0] as string };
};
const filleted = (kernel: GeometryKernel, size = 1): { doc: CadDocument; id: string } => {
  const { doc, id } = box();
  const result = execute(doc, 'fillet_edge', { id, edgeIndices: [3], radius: size }, context(kernel));
  return { doc: result.document, id: result.affected[0] as string };
};

describe('fillet_edge coded refusals', () => {
  const tooLarge = report({ contours: [{ edges: [3], status: 'startsol_failure' }] });

  it('BLD_RADIUS_TOO_LARGE with the edges, the path and the largest radius that builds; the document is unchanged', () => {
    const kernel = scripted({ limit: 4, report: tooLarge });
    const { doc, id } = box();
    const result = execute(doc, 'fillet_edge', { id, edgeIndices: [3], radius: 9 }, context(kernel));
    expectNoOp(result, doc, 'BLD_RADIUS_TOO_LARGE');
    expect(result.rejected).toBe(true);
    expect(result.error).toMatchObject({ code: 'BLD_RADIUS_TOO_LARGE', ids: [id], paths: ['radius'] });
    expect(result.error?.remediation).toContain('probe_fillet');
    expect(result.summary).toContain('edges 3 (e(y+|z+))');
    const largest = Number(/largest that builds: ([\d.]+) mm/.exec(result.summary)?.[1]);
    expect(largest).toBeGreaterThan(3.5);
    expect(largest).toBeLessThanOrEqual(4);
    expectPure(doc, () => execute(doc, 'fillet_edge', { id, edgeIndices: [3], radius: 9 }, context(kernel)));
  });

  it('the per-edge law form reports BLD_WALKING_FAILURE on its edges path', () => {
    const kernel = scripted({ limit: 2, report: report({ contours: [{ edges: [3], status: 'walking_failure' }] }) });
    const { doc, id } = box();
    const result = execute(
      doc,
      'fillet_edge',
      {
        id,
        edges: [
          { index: 3, size: 5, sizeEnd: 6 },
          { index: 2, size: 4 },
        ],
      },
      context(kernel),
    );
    expect(result.error).toMatchObject({ code: 'BLD_WALKING_FAILURE', paths: ['edges'] });
    expect(result.summary).not.toContain('undefined');
  });

  it('per-edge laws are scaled together to find the largest that builds; nothing smaller building is said so', () => {
    const tooLarge = report({ contours: [{ edges: [3], status: 'startsol_failure' }] });
    const { doc, id } = box();
    const laws = {
      id,
      edges: [
        { index: 3, size: 6, sizeEnd: 8, sizes: [{ t: 0.5, size: 7 }] },
        { index: 2, size: 4 },
      ],
    };
    const scaled = execute(doc, 'fillet_edge', laws, context(scripted({ limit: 4, report: tooLarge })));
    expect(scaled.error).toMatchObject({ code: 'BLD_RADIUS_TOO_LARGE', paths: ['edges'] });
    expect(scaled.summary).toMatch(/largest that builds: all sizes x 0\.\d+ \(/);
    const none = execute(doc, 'fillet_edge', { id, edgeIndices: [3], radius: 1 }, context(scripted({ limit: 0.0001, report: tooLarge })));
    expect(none.summary).toContain('no smaller size builds either');
  });

  it('a faulty vertex of four edges is BLD_CORNER_UNSUPPORTED; a kernel without diagnostics keeps the generic summary', () => {
    const corner = report({ stage: 'corners', vertices: [{ point: [0, 0, 0], edges: [0, 1, 2, 3] }] });
    const { doc, id } = box();
    const coded = execute(doc, 'fillet_edge', { id, edgeIndices: [3], radius: 1 }, context(scripted({ limit: 0.5, report: corner })));
    expect(coded.error?.code).toBe('BLD_CORNER_UNSUPPORTED');
    for (const script of [
      { limit: 0.5, noReport: true },
      { limit: 0.5, report: null },
      { limit: 0.5, report: report({ stage: 'none', done: true }) },
    ]) {
      const generic = execute(doc, 'fillet_edge', { id, edgeIndices: [3], radius: 1 }, context(scripted(script)));
      expectNoOp(generic, doc, 'could not round these edges');
      expect(generic.error).toBeUndefined();
    }
  });

  it('chamfer_edge and an unbuildable chamfer keep the generic refusal', () => {
    const { doc, id } = box();
    const kernel = scripted({ limit: 0, report: tooLarge });
    const result = execute(doc, 'chamfer_edge', { id, edgeIndices: [3], distance: 1 }, context({ ...kernel, evaluate: () => null }));
    expectNoOp(result, doc, 'chamfer_edge');
    expect(result.error).toBeUndefined();
  });
});

describe('probe_fillet', () => {
  it('returns the largest radius that builds per edge, within the evaluation budget, and does not change the document', () => {
    const kernel = scripted({ limit: 3.2, report: report({ contours: [{ edges: [3], status: 'startsol_failure' }] }) });
    const { doc, id } = box();
    const result = execute(doc, 'probe_fillet', { id, edgeIndices: [3] }, context(kernel));
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const data = result.data as { edges: Array<Record<string, unknown>>; tolerance: Record<string, unknown>; unit: string };
    const [edge] = data.edges;
    expect(edge?.['index']).toBe(3);
    expect(edge?.['name']).toBe('e(y+|z+)');
    expect(edge?.['upperBound']).toBe(5);
    expect(edge?.['maxRadius']).toBeLessThanOrEqual(3.2);
    expect(edge?.['maxRadius']).toBeGreaterThan(3.15);
    expect(edge?.['limitingCode']).toBe('BLD_RADIUS_TOO_LARGE');
    expect(edge?.['evaluations']).toBeLessThanOrEqual(12);
    expect(data.tolerance).toMatchObject({ name: 'probeTolerance', defaulted: true, unit: 'mm' });
    expect(data.unit).toBe('mm');
    expect(result.summary).toContain('max radius');
    expectPure(doc, () => execute(doc, 'probe_fillet', { id, edgeIndices: [3] }, context(kernel)));
  });

  it('a bound that builds has no limiting code; every roundable edge is probed when none is selected', () => {
    const { doc, id } = box();
    const result = execute(doc, 'probe_fillet', { id, maxEvaluations: 3 }, context(scripted()));
    const edges = (result.data as { edges: Array<Record<string, unknown>> }).edges;
    expect(edges).toHaveLength(TOPOLOGY.edges.length);
    expect(edges[0]).toMatchObject({ maxRadius: 8, upperBound: 2, limitingCode: null, evaluations: 3 });
    const by = execute(
      doc,
      'probe_fillet',
      { id, edgesNear: [[10, 5, 2.5]], edgeNames: ['e(y+|z+)'], tolerance: 0.5 },
      context(scripted({ limit: 1 })),
    );
    expect((by.data as { tolerance: Record<string, unknown> }).tolerance).toMatchObject({ value: 0.5, defaulted: false });
  });

  it('grows past a first guess that builds (mean face width) instead of reporting it as the limit', () => {
    const { doc, id } = box();
    const kernel = scripted({ limit: 8.3, report: report({ contours: [{ edges: [0], status: 'startsol_failure' }] }) });
    const result = execute(doc, 'probe_fillet', { id, edgeIndices: [0] }, context(kernel));
    const [edge] = (result.data as { edges: Array<Record<string, number | string | null>> }).edges;
    expect(edge?.['upperBound']).toBe(2);
    expect(edge?.['maxRadius']).toBeGreaterThan(8.2);
    expect(edge?.['maxRadius']).toBeLessThanOrEqual(8.3);
    expect(edge?.['limitingCode']).toBe('BLD_RADIUS_TOO_LARGE');
  });

  it('refuses bad input without changing the document', () => {
    const { doc, id } = box();
    const kernel = scripted();
    expectNoOp(execute(doc, 'probe_fillet', { id: 'ghost' }, context(kernel)), doc, 'not found');
    expectNoOp(execute(doc, 'probe_fillet', { id, tolerance: 0 }, context(kernel)), doc, 'tolerance must be > 0');
    expectNoOp(execute(doc, 'probe_fillet', { id, maxEvaluations: 0 }, context(kernel)), doc, 'maxEvaluations');
    expectNoOp(execute(doc, 'probe_fillet', { id }, context(scripted({ noFillet: true }))), doc, 'cannot fillet');
    const nothing = execute(doc, 'probe_fillet', { id, edgeIndices: [99] }, context(kernel));
    expectNoOp(nothing, doc);
    expect(nothing.summary).toContain('99');
    const names = execute(doc, 'probe_fillet', { id, edgeNames: ['e(nope|nope)'] }, context(kernel));
    expect(names.error?.code).toBe('REF_LOST');
    expect(execute(doc, 'probe_fillet', { id }, { ...defaultContext(), kernel: null }).summary).toContain('kernel');
  });

  it('without exact mass properties the tolerance comes from the display mesh bounds', () => {
    const { doc, id } = box();
    const mesh = scripted({ limit: 3, noMass: true });
    const result = execute(doc, 'probe_fillet', { id, edgeIndices: [3] }, context(mesh));
    const data = result.data as { tolerance: { value: number } };
    expect(data.tolerance.value).toBeCloseTo(0.001 * Math.sqrt(3), 6);
    const empty = { ...mesh, tessellate: () => null };
    expect(
      (execute(doc, 'probe_fillet', { id, edgeIndices: [3] }, context(empty)).data as { tolerance: { value: number } }).tolerance.value,
    ).toBeCloseTo(0.005, 9);
  });

  it('refuses an operand the kernel cannot build, a kernel without topology and too many edges', () => {
    const { doc, id } = box();
    const unbuildable = { ...scripted(), evaluate: () => null };
    expectNoOp(execute(doc, 'probe_fillet', { id }, context(unbuildable)), doc, 'could not build');
    const flat = { ...scripted(), topology: () => null };
    expectNoOp(execute(doc, 'probe_fillet', { id }, context(flat)), doc, 'no exact topology');
    const many = {
      ...scripted(),
      topology: () => ({
        ...TOPOLOGY,
        edges: Array.from({ length: 40 }, (_, k) => ({ ...(TOPOLOGY.edges[0] as ShapeTopology['edges'][number]), index: k })),
      }),
    };
    expectNoOp(execute(doc, 'probe_fillet', { id }, context(many)), doc, 'at most 32');
    const noBlend = execute(doc, 'probe_fillet', { id, edgeIndices: [0] }, context(scripted({ limit: 1, noFaceQuery: true })));
    expect((noBlend.data as { edges: Array<{ upperBound: number }> }).edges[0]?.upperBound).toBe(20);
    const seamed = { ...scripted(), topology: () => ({ ...TOPOLOGY, edges: TOPOLOGY.edges.map((edge) => ({ ...edge, seam: true })) }) };
    expectNoOp(execute(doc, 'probe_fillet', { id }, context(seamed)), doc, 'no roundable edge');
  });
});

describe('check_blends', () => {
  it('measures the contact lines of a fillet: G1 with a curvature jump 1/r is an info finding', () => {
    const kernel = scripted();
    const { doc, id } = filleted(kernel);
    const result = execute(doc, 'check_blends', {}, context(kernel));
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const data = result.data as {
      status: string;
      blends: Array<{ entityId: string; name: string; kind: string; sourceEdges: string[]; contacts: Array<Record<string, unknown>> }>;
      findings: Array<{ code: string; severity: string }>;
      tolerances: Record<string, { defaulted: boolean }>;
      reviewRequired: boolean;
    };
    expect(data.status).toBe('pass');
    expect(data.blends).toHaveLength(1);
    expect(data.blends[0]).toMatchObject({ entityId: id, kind: 'edge', sourceEdges: [`e(${S}:y+|${S}:z+)`] });
    expect(data.blends[0]?.contacts.map((contact) => contact['edge'])).toEqual([0, 1]);
    expect(data.blends[0]?.contacts[0]).toMatchObject({ g1AngleRad: 0, g2Gap: 1, g2Rel: 1, order: 'G1' });
    expect(data.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['BLD_CHECK_G2_JUMP', 'info'],
      ['BLD_CHECK_G2_JUMP', 'info'],
    ]);
    expect(data.tolerances['g1AngleRad']?.defaulted).toBe(true);
    expect(data.reviewRequired).toBe(false);
    expectPure(doc, () => execute(doc, 'check_blends', {}, context(kernel)));
  });

  it('require G2 fails a curvature jump; a normal angle fails G1; a G2 contact passes', () => {
    const kernel = scripted();
    const { doc } = filleted(kernel);
    const strict = execute(doc, 'check_blends', { require: 'G2' }, context(kernel));
    expect((strict.data as { status: string }).status).toBe('fail');
    const bent = execute(doc, 'check_blends', {}, context(scripted({ normalAngle: 0.3 })));
    const bentData = bent.data as { status: string; findings: Array<{ code: string; value: number; limit: number; unit: string }> };
    expect(bentData.status).toBe('fail');
    expect(bentData.findings[0]).toMatchObject({ code: 'BLD_CHECK_G1_ANGLE', value: 0.3, limit: 0.01, unit: 'rad' });
    const smooth = execute(doc, 'check_blends', { require: 'G2' }, context(scripted({ curvature: [2, 2] })));
    expect(smooth.data).toMatchObject({ status: 'pass', findings: [] });
    expect((smooth.data as { blends: Array<{ contacts: Array<{ order: string }> }> }).blends[0]?.contacts[0]?.order).toBe('G2');
  });

  it('flags an invalid solid, an unnamed kernel and a contact the kernel cannot measure', () => {
    const kernel = scripted();
    const { doc } = filleted(kernel);
    const analysis = { valid: false, status: 'BRepCheck failed', closed: false, volume: 1, area: 1, lumps: [], freeFaces: 0 };
    const invalid = execute(doc, 'check_blends', {}, context(scripted({ analysis })));
    expect((invalid.data as { findings: Array<{ code: string }> }).findings.map((finding) => finding.code)).toContain('BLD_CHECK_INVALID');
    const unnamed = execute(doc, 'check_blends', {}, context(scripted({ names: false })));
    expect(unnamed.data).toMatchObject({ status: 'warn', blends: [] });
    expect((unnamed.data as { findings: Array<{ code: string }> }).findings[0]?.code).toBe('BLD_CHECK_UNVERIFIED_PICK');
    const blind = execute(doc, 'check_blends', {}, context(scripted({ curvature: null })));
    expect(blind.data).toMatchObject({ unverified: 2, status: 'warn' });
    expect((blind.data as { findings: Array<{ code: string; severity: string }> }).findings).toEqual([
      expect.objectContaining({ code: 'BLD_CHECK_UNVERIFIED_CONTACT', severity: 'warn', face: 2 }),
    ]);
    const renamed = {
      ...scripted(),
      topology: () => ({
        ...TOPOLOGY,
        faces: TOPOLOGY.faces.map((face) => (face.index < 2 ? { ...face, name: `other:${face.index}` } : face)),
      }),
    };
    const orphan = execute(doc, 'check_blends', {}, context(renamed));
    expect(orphan.data).toMatchObject({ status: 'warn', unverified: 0 });
    expect((orphan.data as { blends: Array<{ contacts: unknown[] }>; findings: Array<{ message: string }> }).blends[0]?.contacts).toEqual(
      [],
    );
    expect((orphan.data as { findings: Array<{ message: string }> }).findings[0]?.message).toContain('no contact line');
    const unbuildable = execute(doc, 'check_blends', {}, context({ ...scripted(), evaluate: () => null }));
    expect((unbuildable.data as { findings: Array<{ code: string }> }).findings[0]?.code).toBe('BLD_CHECK_INVALID');
  });

  it('an open contact is order none (G0 gap) and the gap tolerance is computed per solid', () => {
    const kernel = scripted({ gap: 5e-5 });
    const small = filleted(kernel, 1);
    const added = execute(small.doc, 'add_box', { size: [20, 10, 5] });
    const bigFillet = execute(added.document, 'fillet_edge', { id: added.affected[0], edgeIndices: [3], radius: 3 }, context(kernel));
    const result = execute(bigFillet.document, 'check_blends', {}, context(kernel));
    const data = result.data as {
      blends: Array<{ entityId: string; contacts: Array<{ order: string }> }>;
      findings: Array<{ code: string; entityId: string }>;
      tolerances: { g0: { value: number } };
    };
    const gaps = data.findings.filter((finding) => finding.code === 'BLD_CHECK_G0_GAP');
    expect(new Set(gaps.map((finding) => finding.entityId))).toEqual(new Set([small.id]));
    expect(data.blends.find((blend) => blend.entityId === small.id)?.contacts[0]?.order).toBe('none');
    expect(data.blends.find((blend) => blend.entityId === bigFillet.affected[0])?.contacts[0]?.order).toBe('G1');
    expect(data.tolerances.g0.value).toBeCloseTo(1e-6 * Math.sqrt(20 ** 2 + 10 ** 2 + 5 ** 2) * 3, 12);
  });

  it('purpose release names the defaulted tolerances and requires a review', () => {
    const kernel = scripted();
    const { doc } = filleted(kernel);
    const release = execute(doc, 'check_blends', { purpose: 'release', g1AngleRad: 0.02 }, context(kernel));
    const data = release.data as {
      reviewRequired: boolean;
      reviewReason: string;
      findings: Array<{ code: string; message: string }>;
      status: string;
    };
    expect(data.reviewRequired).toBe(true);
    expect(data.reviewReason).toContain('human');
    const defaulted = data.findings.find((finding) => finding.code === 'BLD_CHECK_TOLERANCE_DEFAULTED');
    expect(defaulted?.message).toContain('g0, g2Rel');
    expect(defaulted?.message).not.toContain('g1AngleRad');
    expect(data.findings.map((finding) => finding.code)).toContain('BLD_CHECK_REVIEW');
    expect(data.status).toBe('warn');
  });

  it('is not_run without a kernel or exact face queries, and refuses bad input', () => {
    const kernel = scripted();
    const { doc, id } = filleted(kernel);
    const none = execute(doc, 'check_blends', {}, { ...defaultContext(), kernel: null });
    expect(none.data).toMatchObject({ status: 'not_run' });
    expect(none.document).toBe(doc);
    const mesh = execute(doc, 'check_blends', { ids: [id] }, context(scripted({ noFaceQuery: true })));
    expect(mesh.data).toMatchObject({ status: 'not_run' });
    expect(mesh.summary).toContain('not_run');
    expectNoOp(execute(doc, 'check_blends', { ids: ['ghost'] }, context(kernel)), doc, 'SRF_ENTITY_NOT_FOUND');
    expect(execute(doc, 'check_blends', { ids: ['ghost'] }, context(kernel)).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
    expectNoOp(execute(doc, 'check_blends', { g0: 0 }, context(kernel)), doc, 'g0 must be > 0');
    expectNoOp(execute(doc, 'check_blends', { samples: 1 }, context(kernel)), doc, 'samples');
    const empty = execute(createEmptyDocument(), 'check_blends', {}, context(kernel));
    expect(empty.data).toMatchObject({ status: 'not_run', blends: [], notRunReason: 'no filleted solid to check' });
    expect(execute(doc, 'check_blends', { ids: [] }, context(kernel)).data).toMatchObject({ status: 'not_run' });
    const solid = box();
    expect(execute(solid.doc, 'check_blends', { ids: [solid.id] }, context(kernel)).error?.code).toBe('SRF_ENTITY_NOT_FOUND');
    expect((doc.entities[id] as MeshSolidEntity).brep).toBeDefined();
  });
});
