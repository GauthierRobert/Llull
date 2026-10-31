/**
 * BLD M3: setback corners of fillet_edge (vertex picking, persistent vertex names, per-edge setbacks, coded refusals), the vertex derivation,
 * the recipe field, the corner rows of check_blends and what the exporters do with a corner, over a scripted kernel (native values:
 * server/tests/nativeBlendCorners.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import type { ShapeEdge, ShapeTopology } from '@core/geometry/kernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { BlendReport, FaceGraph } from '@core/geometry/kernelPorts';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { GeometryKernel } from '@core/geometry/kernel';
import { diagnoseBlend, remediationOf } from '@core/geometry/blend/diagnose';
import { cornerSources } from '@core/geometry/blend/continuity';
import { nearestVertex, resolveVertexName, solidVertices } from '@core/geometry/blend/vertices';
import { recipeKey, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { blendNotExpressible } from '@core/codegen/recipeLowering';
import { SOURCE, scriptedKernel } from '../helpers/blendKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

const ctxOf = (kernel: GeometryKernel): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel });
const HALF = 5;
const FACES = ['x-', 'x+', 'y-', 'y+', 'z-', 'z+'] as const;
const sign = (face: string): number => (face.endsWith('+') ? HALF : -HALF);

/** A 10 mm cube: 6 named faces, 12 named edges with their end points, 8 vertices. */
function cubeTopology(): ShapeTopology {
  const edges: ShapeEdge[] = [];
  const axes = ['x', 'y', 'z'] as const;
  for (const axis of axes) {
    const [first, second] = axes.filter((other) => other !== axis);
    for (const a of ['-', '+']) {
      for (const b of ['-', '+']) {
        const start = [0, 0, 0];
        const end = [0, 0, 0];
        start[axes.indexOf(axis)] = -HALF;
        end[axes.indexOf(axis)] = HALF;
        for (const point of [start, end]) {
          point[axes.indexOf(first as 'x')] = sign(`${first}${a}`);
          point[axes.indexOf(second as 'y')] = sign(`${second}${b}`);
        }
        const pair = [`${SOURCE}:${first}${a}`, `${SOURCE}:${second}${b}`].sort();
        edges.push({
          index: edges.length,
          name: `e(${pair.join('|')})`,
          curve: 'line',
          length: 10,
          start: start as unknown as ShapeEdge['start'],
          end: end as unknown as ShapeEdge['end'],
          mid: [(start[0] ?? 0) / 2 + (end[0] ?? 0) / 2, (start[1] ?? 0) / 2 + (end[1] ?? 0) / 2, (start[2] ?? 0) / 2 + (end[2] ?? 0) / 2],
          seam: false,
          degenerate: false,
        });
      }
    }
  }
  return {
    solids: 1,
    faces: FACES.map((face, index) => ({ index, name: `${SOURCE}:${face}`, surface: 'plane', area: 100 })),
    edges,
    vertices: 8,
    volume: 1000,
  };
}

const TOPOLOGY = cubeTopology();
const cube = (): { doc: CadDocument; id: string } => {
  const made = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
  return { doc: made.document, id: made.affected[0] as string };
};
const brepOf = (doc: CadDocument, id: string): ShapeRecipe | undefined => (doc.entities[id] as MeshSolidEntity).brep;
const filletOf = (doc: CadDocument, id: string): Extract<ShapeRecipe, { op: 'fillet' | 'chamfer' }> =>
  brepOf(doc, id) as Extract<ShapeRecipe, { op: 'fillet' | 'chamfer' }>;
const corner = [-5, -5, -5] as const;

describe('solidVertices, nearestVertex and resolveVertexName', () => {
  it('finds the 8 vertices of the cube with their three edges and a sorted name made of the edge names', () => {
    const vertices = solidVertices(TOPOLOGY);
    expect(vertices).toHaveLength(8);
    for (const vertex of vertices) {
      expect(vertex.edges).toHaveLength(3);
      expect(vertex.name).toMatch(/^v\(e\(.*\),e\(.*\),e\(.*\)\)$/);
    }
    const origin = vertices[nearestVertex(vertices, corner)];
    expect(origin?.point).toEqual(corner);
    expect(origin?.name).toBe(`v(e(${SOURCE}:x-|${SOURCE}:y-),e(${SOURCE}:x-|${SOURCE}:z-),e(${SOURCE}:y-|${SOURCE}:z-))`);
  });

  it('resolves a name to exactly one vertex; a gone or a repeated name is lost / split; a kernel without names names nothing', () => {
    const vertices = solidVertices(TOPOLOGY);
    const name = vertices[0]?.name as string;
    expect(resolveVertexName(vertices, name)).toEqual({ ok: true, index: 0 });
    expect(resolveVertexName(vertices, 'v(e(gone))')).toEqual({ ok: false, lost: true, name: 'v(e(gone))' });
    const twice = [vertices[0], vertices[0]] as never;
    expect(resolveVertexName(twice, name)).toEqual({ ok: false, lost: false, name });
    const unnamed = { ...TOPOLOGY, edges: TOPOLOGY.edges.map(({ name: _name, ...edge }) => edge) };
    expect(solidVertices(unnamed).every((vertex) => vertex.name === undefined)).toBe(true);
    expect(nearestVertex([], corner)).toBe(-1);
  });

  it('skips degenerate edges and keeps a closed edge once', () => {
    const closed = { ...TOPOLOGY.edges[0], index: 12, start: [-5, -5, -5], end: [-5, -5, -5] } as unknown as ShapeEdge;
    const pole = { ...TOPOLOGY.edges[1], index: 13, degenerate: true, start: [9, 9, 9], end: [9, 9, 9] } as unknown as ShapeEdge;
    const vertices = solidVertices({ ...TOPOLOGY, edges: [...TOPOLOGY.edges, closed, pole] });
    expect(vertices).toHaveLength(8);
    expect(vertices[nearestVertex(vertices, corner)]?.edges.filter((edge) => edge === 12)).toHaveLength(1);
  });
});

describe('cornerSources', () => {
  it('splits a corner patch name at the top-level commas; any other name is null', () => {
    expect(cornerSources('blend(v:e(a|b),e(a|c),e(b|c))')).toEqual(['e(a|b)', 'e(a|c)', 'e(b|c)']);
    expect(cornerSources('blend(e(a|b))')).toBeNull();
    expect(cornerSources('blend(v:e(a|b),e(a|c),e(b|c))#4')).toEqual(['e(a|b)', 'e(a|c)', 'e(b|c)']);
    expect(cornerSources('blend(v:e(a|b')).toBeNull();
  });
});

describe('fillet_edge corners', () => {
  it('all: true gives every cube vertex a setback corner with a distance for each of its 3 edges and records the vertex names', () => {
    const kernel = scriptedKernel({ topology: TOPOLOGY });
    const { doc, id } = cube();
    const done = execute(doc, 'fillet_edge', { id, radius: 1, corners: [{ all: true, type: 'setback', setback: 2 }] }, {
      ...{},
      kernel,
    } as never);
    expect(done.rejected).not.toBe(true);
    const recipe = filletOf(done.document, done.affected[0] as string);
    expect(recipe.edges).toHaveLength(12);
    expect(recipe.corners).toHaveLength(8);
    for (const entry of recipe.corners ?? []) {
      expect(entry.type).toBe('setback');
      expect(entry.distances).toHaveLength(3);
      expect(entry.distances.every((distance) => distance.distance === 2)).toBe(true);
    }
    expect(done.summary).toContain('8 setback corner(s)');
    const recorded = (done.document.featureHistory.at(-1)?.params as { corners?: Array<{ name?: string; setback?: number }> }).corners;
    expect(recorded).toHaveLength(8);
    expect(recorded?.every((entry) => entry.name?.startsWith('v(e(') === true && entry.setback === 2)).toBe(true);
  });

  it('a recorded vertex name wins on regeneration: the same vertex gets the corner; nothing more is recorded', () => {
    const kernel = scriptedKernel({ topology: TOPOLOGY });
    const { doc, id } = cube();
    const name = solidVertices(TOPOLOGY)[0]?.name as string;
    const done = execute(
      doc,
      'fillet_edge',
      { id, edgeIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], radius: 1, corners: [{ name, setback: 2 }] },
      ctxOf(kernel),
    );
    const recipe = filletOf(done.document, done.affected[0] as string);
    expect(recipe.corners).toHaveLength(1);
    expect(recipe.corners?.[0]?.vertex).toEqual(solidVertices(TOPOLOGY)[0]?.point);
    expect(done.recordExtras?.['corners']).toBeUndefined();
  });

  it('near picks the nearest vertex; setbacks override single edges by point or name; rolling_ball leaves the kernel corner', () => {
    const kernel = scriptedKernel({ topology: TOPOLOGY });
    const { doc, id } = cube();
    const edge = TOPOLOGY.edges.find(
      (candidate) => candidate.start[0] === -5 && candidate.end[0] === 5 && candidate.start[1] === -5 && candidate.start[2] === -5,
    );
    const done = execute(
      doc,
      'fillet_edge',
      {
        id,
        radius: 1,
        corners: [
          { near: [-4.9, -5, -5.1], setback: 2, setbacks: [{ near: edge?.mid, distance: 3 }] },
          { near: [5, 5, 5], type: 'rolling_ball' },
          { near: [5, -5, -5], setback: 2, setbacks: [{ name: edge?.name, distance: 4 }] },
        ],
      },
      ctxOf(kernel),
    );
    expect(done.rejected).not.toBe(true);
    const corners = filletOf(done.document, done.affected[0] as string).corners ?? [];
    expect(corners).toHaveLength(2);
    const first = corners[0]?.distances.find((entry) => entry.edge === edge?.index);
    expect(first?.distance).toBe(3);
    expect(corners[0]?.distances.filter((entry) => entry.distance === 2)).toHaveLength(2);
    expect(corners[1]?.distances.find((entry) => entry.edge === edge?.index)?.distance).toBe(4);
  });

  it('only rolling_ball entries leave the recipe without corners', () => {
    const kernel = scriptedKernel({ topology: TOPOLOGY });
    const { doc, id } = cube();
    const done = execute(doc, 'fillet_edge', { id, radius: 1, corners: [{ all: true, type: 'rolling_ball' }] }, ctxOf(kernel));
    expect(filletOf(done.document, done.affected[0] as string).corners).toBeUndefined();
  });

  it('is pure and a no-op for bad corner input: selectors, repeated vertex, missing setback, foreign override edge, unknown kernel topology', () => {
    const kernel = scriptedKernel({ topology: TOPOLOGY });
    const { doc, id } = cube();
    const run = (corners: unknown[], context: unknown = { kernel }): ReturnType<typeof execute> =>
      execute(doc, 'fillet_edge', { id, radius: 1, corners }, context as never);
    expectPure(doc, () => run([{ all: true, setback: 2 }]));
    expectNoOp(run([{ setback: 2 }]), doc, 'needs exactly one of name, near or all');
    expectNoOp(run([{ all: true, near: corner, setback: 2 }]), doc, 'needs exactly one of name, near or all');
    expectNoOp(
      run([
        { near: corner, setback: 2 },
        { near: corner, setback: 2 },
      ]),
      doc,
      'already has a corner entry',
    );
    expectNoOp(run([{ near: corner }]), doc, 'has no setback');
    expectNoOp(run([{ near: corner, setback: 2, setbacks: [{ distance: 1 }] }]), doc, 'needs exactly one of near or name');
    expectNoOp(
      run([{ near: corner, setback: 2, setbacks: [{ near: [5, 5, 5], name: 'x', distance: 1 }] }]),
      doc,
      'needs exactly one of near or name',
    );
    const far = TOPOLOGY.edges.find((candidate) => candidate.start[0] === 5 && candidate.start[1] === 5 && candidate.end[0] === 5);
    expectNoOp(run([{ near: corner, setback: 2, setbacks: [{ near: far?.mid, distance: 1 }] }]), doc, 'does not meet the vertex');
    expectNoOp(
      run([
        {
          near: corner,
          setback: 2,
          setbacks: [
            { near: far?.mid, distance: 1 },
            { near: far?.mid, distance: 2 },
          ],
        },
      ]),
      doc,
    );
    const unrounded = execute(doc, 'fillet_edge', { id, edgeIndices: [0], radius: 1, corners: [{ all: true, setback: 2 }] }, {
      kernel,
    } as never);
    expectNoOp(unrounded, doc, 'no vertex has 3 or more rounded edges');
    const noTopology = scriptedKernel({ noTopology: true });
    expectNoOp(run([{ near: corner, setback: 2 }], { kernel: noTopology }), doc);
  });

  it('a lost or split vertex name refuses with REF_LOST / REF_SPLIT and how to re-pick it; so does an override edge name', () => {
    const kernel = scriptedKernel({ topology: TOPOLOGY });
    const { doc, id } = cube();
    const lost = execute(doc, 'fillet_edge', { id, radius: 1, corners: [{ name: 'v(e(gone))', setback: 2 }] }, ctxOf(kernel));
    expectNoOp(lost, doc);
    expect(lost.error?.code).toBe('REF_LOST');
    expect(lost.error?.remediation).toContain('corners[].name');
    const missingEdge = execute(
      doc,
      'fillet_edge',
      { id, radius: 1, corners: [{ near: corner, setback: 2, setbacks: [{ name: 'e(gone)', distance: 3 }] }] },
      ctxOf(kernel),
    );
    expect(missingEdge.error?.code).toBe('REF_LOST');
    const edgeName = TOPOLOGY.edges[0]?.name as string;
    const repeatedEdges: ShapeTopology = {
      ...TOPOLOGY,
      edges: TOPOLOGY.edges.map((edge) => (edge.index === 1 ? { ...edge, name: edgeName } : edge)),
    };
    const repeated = execute(
      doc,
      'fillet_edge',
      { id, radius: 1, corners: [{ near: corner, setback: 2, setbacks: [{ name: edgeName, distance: 3 }] }] },
      { kernel: scriptedKernel({ topology: repeatedEdges }) } as never,
    );
    expect(repeated.error?.code).toBe('REF_SPLIT');
  });

  it('a setback corner needs constant circular blends: a varying radius or a profile is BLD_CORNER_UNSUPPORTED with the param path', () => {
    const kernel = scriptedKernel({ topology: TOPOLOGY });
    const { doc, id } = cube();
    const varying = execute(doc, 'fillet_edge', { id, radius: 1, radiusEnd: 2, corners: [{ all: true, setback: 2 }] }, ctxOf(kernel));
    expectNoOp(varying, doc);
    expect(varying.error).toMatchObject({ code: 'BLD_CORNER_UNSUPPORTED', ids: [id], paths: ['corners[0]'] });
    const profiled = execute(
      doc,
      'fillet_edge',
      { id, radius: 1, profile: { type: 'conic', rho: 0.5 }, corners: [{ all: true, setback: 2 }] },
      ctxOf(kernel),
    );
    expect(profiled.error?.code).toBe('BLD_CORNER_UNSUPPORTED');
    const rolling = execute(doc, 'fillet_edge', { id, radius: 1, radiusEnd: 2, corners: [{ all: true, type: 'rolling_ball' }] }, {
      kernel,
    } as never);
    expect(rolling.error).toBeUndefined();
  });

  it('a radius that is linear between the two ends of each edge is accepted at a setback corner; the smooth law of radiusEnd and a multi-station law are refused', () => {
    const kernel = scriptedKernel({ topology: TOPOLOGY });
    const { doc, id } = cube();
    const law = { size: 1, sizeEnd: 1.5, interpolation: 'linear' as const };
    const linear = execute(
      doc,
      'fillet_edge',
      { id, edges: TOPOLOGY.edges.map((edge) => ({ index: edge.index, ...law })), corners: [{ all: true, setback: 2 }] },
      ctxOf(kernel),
    );
    expect(linear.error).toBeUndefined();
    expect(filletOf(linear.document, linear.affected[0] as string).corners).toHaveLength(8);
    const equal = execute(
      doc,
      'fillet_edge',
      { id, edges: TOPOLOGY.edges.map((edge) => ({ index: edge.index, size: 1, sizeEnd: 1 })), corners: [{ all: true, setback: 2 }] },
      ctxOf(kernel),
    );
    expect(equal.error).toBeUndefined();
    const smooth = execute(
      doc,
      'fillet_edge',
      { id, edges: TOPOLOGY.edges.map((edge) => ({ index: edge.index, size: 1, sizeEnd: 1.5 })), corners: [{ all: true, setback: 2 }] },
      ctxOf(kernel),
    );
    expect(smooth.error).toMatchObject({ code: 'BLD_CORNER_UNSUPPORTED', paths: ['corners[0]'] });
    const stations = execute(
      doc,
      'fillet_edge',
      {
        id,
        edges: TOPOLOGY.edges.map((edge) => ({ index: edge.index, size: 1, sizes: [{ t: 0.5, size: 2 }] })),
        corners: [{ all: true, setback: 2 }],
      },
      ctxOf(kernel),
    );
    expect(stations.error?.code).toBe('BLD_CORNER_UNSUPPORTED');
  });

  it('works with per-edge entries and chord mode: the corner distances follow the planned edges', () => {
    const kernel = scriptedKernel({ topology: TOPOLOGY });
    const { doc, id } = cube();
    const done = execute(
      doc,
      'fillet_edge',
      { id, edges: TOPOLOGY.edges.map((edge) => ({ index: edge.index, size: 1 })), corners: [{ all: true, setback: 2 }] },
      ctxOf(kernel),
    );
    expect(filletOf(done.document, done.affected[0] as string).corners).toHaveLength(8);
  });

  it('a kernel refusal that the kernel explains as a short setback is BLD_SETBACK_TOO_SHORT with the edge text, ids and the corners path', () => {
    const report: BlendReport = {
      stage: 'setback',
      contours: [],
      vertices: [],
      partial: false,
      unsupportedVertices: [],
      done: false,
      valid: false,
      message: '[BLD_SETBACK_TOO_SHORT] setback 0.5 on edge 3 at [5, 5, 5] must exceed 1',
    };
    const base = scriptedKernel({ topology: TOPOLOGY });
    const kernel = {
      ...base,
      evaluate: (recipe: ShapeRecipe) => (recipe.op === 'fillet' ? null : base.evaluate(recipe)),
      blendReport: () => report,
    };
    const { doc, id } = cube();
    const refused = execute(doc, 'fillet_edge', { id, radius: 1, corners: [{ all: true, setback: 0.5 }] }, ctxOf(kernel));
    expectNoOp(refused, doc);
    expect(refused.rejected).toBe(true);
    expect(refused.error).toMatchObject({ code: 'BLD_SETBACK_TOO_SHORT', ids: [id], paths: ['corners'] });
    expect(refused.error?.remediation).toContain('minimum');
    expect(refused.summary).toContain('must exceed 1');
  });
});

describe('diagnoseBlend of the setback stage', () => {
  const report = (message: string | undefined): BlendReport => ({
    stage: 'setback',
    contours: [],
    vertices: [],
    partial: false,
    unsupportedVertices: [],
    done: false,
    valid: false,
    ...(message === undefined ? {} : { message }),
  });

  it('keeps the code a reason carries, defaults to BLD_CORNER_FAILED, and has a remediation for each', () => {
    expect(diagnoseBlend(report('[BLD_SETBACK_TOO_SHORT] too short'))).toMatchObject({
      code: 'BLD_SETBACK_TOO_SHORT',
      message: 'too short',
    });
    expect(diagnoseBlend(report('[BLD_CORNER_UNSUPPORTED] concave'))).toMatchObject({ code: 'BLD_CORNER_UNSUPPORTED' });
    expect(diagnoseBlend(report('something broke'))).toMatchObject({ code: 'BLD_CORNER_FAILED', message: 'something broke' });
    expect(diagnoseBlend(report(undefined))).toMatchObject({ code: 'BLD_CORNER_FAILED', message: 'the kernel gave no reason' });
    for (const code of ['BLD_SETBACK_TOO_SHORT', 'BLD_CORNER_UNSUPPORTED', 'BLD_CORNER_FAILED'] as const)
      expect(remediationOf(code).length).toBeGreaterThan(10);
  });
});

describe('the fillet recipe field', () => {
  const node = (corners: unknown): unknown => ({
    op: 'fillet',
    source: { op: 'solid', entity: { id: 'a', kind: 'box', size: [1, 1, 1] } },
    edges: [0, 1, 2],
    size: 1,
    corners,
  });
  const good = {
    vertex: [0, 0, 0],
    type: 'setback',
    distances: [
      { edge: 0, distance: 1 },
      { edge: 1, distance: 1 },
      { edge: 2, distance: 1 },
    ],
  };

  it('is part of the recipe key and validated when read from an untrusted document', () => {
    const plain = node(undefined) as ShapeRecipe;
    const withCorner = node([good]) as ShapeRecipe;
    expect(recipeKey(withCorner)).not.toBe(recipeKey(plain));
    expect(validateShapeRecipe(withCorner)).toBeNull();
    expect(validateShapeRecipe(node('x'))).toContain('corners must be a list');
    expect(validateShapeRecipe(node([{ ...good, type: 'rolling_ball' }]))).toContain('type "setback"');
    expect(validateShapeRecipe(node([{ ...good, vertex: [0, 0] }]))).toContain('vertex');
    expect(validateShapeRecipe(node([{ ...good, distances: good.distances.slice(0, 2) }]))).toContain('3 or more edges');
    expect(validateShapeRecipe(node([{ ...good, distances: [{ edge: 0, distance: 0 }, ...good.distances.slice(1)] }]))).toContain(
      'distance > 0',
    );
    expect(validateShapeRecipe(node([{ ...good, distances: [{ edge: -1, distance: 1 }, ...good.distances.slice(1)] }]))).toContain(
      'edge index',
    );
    expect(validateShapeRecipe({ ...(node([good]) as object), op: 'chamfer' })).toContain('corners apply to fillets only');
  });

  it('is not expressible as a program op: the export carries the exact result', () => {
    expect(blendNotExpressible(node([good]) as ShapeRecipe)).toBe(true);
    expect(blendNotExpressible(node(undefined) as ShapeRecipe)).toBe(false);
  });
});

describe('check_blends corner patches', () => {
  function patched(
    edgeG1: (edge: number, t: number) => number,
    params: Record<string, unknown> = {},
    gap: (edge: number, t: number) => number = () => 0,
    rank = '',
  ): ReturnType<typeof execute> {
    const patch = `blend(v:e(${SOURCE}:a|${SOURCE}:b),e(${SOURCE}:a|${SOURCE}:c),e(${SOURCE}:b|${SOURCE}:c))${rank}`;
    const topology: ShapeTopology = {
      ...TOPOLOGY,
      faces: [...TOPOLOGY.faces.slice(0, 2), { index: 2, name: patch, surface: 'bspline', area: 3 }],
    };
    const graph = { faces: [], edgeFaces: [[0, 2], [1, 2], [2]], edgeConvexity: [] } as unknown as FaceGraph;
    const kernel = scriptedKernel({ topology, graph, g1: edgeG1, g0: gap });
    const { doc, id } = cube();
    const filleted = execute(doc, 'fillet_edge', { id, radius: 1, corners: [{ near: corner, setback: 2 }] }, {
      kernel: scriptedKernel({ topology: TOPOLOGY }),
    } as never);
    return execute(filleted.document, 'check_blends', params, ctxOf(kernel));
  }

  it('lists the patch as a corner row measured on the open interior, with the end angle apart', () => {
    const result = patched((_edge, t) => (t === 0 || t === 1 ? 0.02 : 0.001));
    const rows = (
      result.data as {
        blends: Array<{ kind: string; sourceEdges: string[]; contacts: Array<{ g1AngleRad: number; g1EndAngleRad: number }> }>;
      }
    ).blends;
    const row = rows.find((blend) => blend.kind === 'corner');
    expect(row?.sourceEdges).toHaveLength(3);
    expect(row?.contacts).toHaveLength(2);
    expect(row?.contacts[0]?.g1AngleRad).toBeCloseTo(0.001);
    expect(row?.contacts[0]?.g1EndAngleRad).toBeCloseTo(0.02);
    expect((result.data as { status: string }).status).not.toBe('fail');
    const data = result.data as {
      findings: Array<{ code: string; severity: string; value?: number }>;
      tolerances: Record<string, { value: number; defaulted: boolean }>;
    };
    expect(
      data.findings.some((finding) => finding.code === 'BLD_CHECK_G1_ANGLE' && finding.severity === 'warn' && finding.value === 0.02),
    ).toBe(true);
    expect(data.tolerances['g0Corner']?.defaulted).toBe(true);
    expect((result.data as { status: string }).status).toBe('warn');
  });

  it('an explicit g0 is the corner limit unchanged (g0Corner = g0, not defaulted); without it g0Corner is 5x the default and only listed when a corner row exists', () => {
    type Tolerances = Record<string, { value: number; defaulted: boolean }>;
    const explicit = patched(() => 0.001, { g0: 3e-4 }).data as { tolerances: Tolerances };
    expect(explicit.tolerances['g0Corner']?.value).toBe(3e-4);
    expect(explicit.tolerances['g0Corner']?.defaulted).toBe(false);
    const byDefault = patched(() => 0.001).data as { tolerances: Tolerances };
    expect((byDefault.tolerances['g0Corner']?.value ?? 0) / (byDefault.tolerances['g0']?.value ?? 1)).toBeCloseTo(5, 6);
    const { doc, id } = cube();
    const plain = execute(doc, 'fillet_edge', { id, radius: 1 }, ctxOf(scriptedKernel({ topology: TOPOLOGY })));
    const checked = execute(plain.document, 'check_blends', {}, ctxOf(scriptedKernel({ topology: TOPOLOGY }))).data as {
      tolerances: Tolerances;
    };
    expect(checked.tolerances['g0Corner']).toBeUndefined();
    expect(checked.tolerances['g0']).toBeDefined();
  });

  it('judges a corner gap between g0 and 5 x g0 by the corner limit: fine by default, BLD_CHECK_G0_GAP when g0 is given explicitly', () => {
    type Run = { findings: Array<{ code: string; severity: string }>; tolerances: Record<string, { value: number }> };
    const g0 = (patched(() => 0.001).data as Run).tolerances['g0']?.value ?? 0;
    expect(g0).toBeGreaterThan(0);
    const byDefault = patched(
      () => 0.001,
      {},
      () => 3 * g0,
    ).data as Run;
    expect(byDefault.findings.filter((finding) => finding.code === 'BLD_CHECK_G0_GAP')).toEqual([]);
    const explicit = patched(
      () => 0.001,
      { g0 },
      () => 3 * g0,
    ).data as Run;
    expect(explicit.findings.some((finding) => finding.code === 'BLD_CHECK_G0_GAP' && finding.severity === 'fail')).toBe(true);
  });

  it('a sub-patch of an exact star (blend(v:...)#k) is judged at the default g0, the plate patch at 5x: the same 3 x g0 gap fails the star and passes the plate; g0Corner is listed for plate rows only', () => {
    type Run = {
      findings: Array<{ code: string; severity: string }>;
      tolerances: Record<string, { value: number }>;
      blends: Array<{ kind: string; profile: string; sourceEdges: string[] }>;
    };
    const g0 = (patched(() => 0.001).data as Run).tolerances['g0']?.value ?? 0;
    const star = patched(
      () => 0.001,
      {},
      () => 3 * g0,
      '#2',
    ).data as Run;
    expect(star.findings.some((finding) => finding.code === 'BLD_CHECK_G0_GAP' && finding.severity === 'fail')).toBe(true);
    expect(star.tolerances['g0Corner']).toBeUndefined();
    const row = star.blends.find((blend) => blend.kind === 'corner');
    expect(row?.profile).toBe('star');
    expect(row?.sourceEdges).toHaveLength(3);
    const plate = patched(
      () => 0.001,
      {},
      () => 3 * g0,
    ).data as Run;
    expect(plate.findings.filter((finding) => finding.code === 'BLD_CHECK_G0_GAP')).toEqual([]);
    expect(plate.tolerances['g0Corner']).toBeDefined();
    expect(plate.blends.find((blend) => blend.kind === 'corner')?.profile).toBe('patch');
  });

  it('fails with BLD_CHECK_G1_ANGLE when the interior of a patch contact is not tangent', () => {
    const result = patched(() => 0.05);
    const findings = (result.data as { findings: Array<{ code: string; severity: string }> }).findings;
    expect(findings.some((finding) => finding.code === 'BLD_CHECK_G1_ANGLE' && finding.severity === 'fail')).toBe(true);
    expect((result.data as { status: string }).status).toBe('fail');
  });
});

describe('setback overrides survive replay and upstream edits', () => {
  const overridden = (kernel: ReturnType<typeof scriptedKernel>): { doc: CadDocument; id: string; result: ReturnType<typeof execute> } => {
    const { doc, id } = cube();
    const edge = TOPOLOGY.edges.find(
      (candidate) => candidate.start[0] === -5 && candidate.end[0] === 5 && candidate.start[1] === -5 && candidate.start[2] === -5,
    );
    const result = execute(
      doc,
      'fillet_edge',
      { id, radius: 1, corners: [{ all: true, setback: 2, setbacks: [{ near: edge?.mid, distance: 3 }] }] },
      ctxOf(kernel),
    );
    return { doc: result.document, id: result.affected[0] as string, result };
  };

  it('records every override as { name, distance } only, and each vertex gets only the overrides of the edges that meet it', () => {
    const { doc } = overridden(scriptedKernel({ topology: TOPOLOGY }));
    const recorded = (doc.featureHistory.at(-1)?.params as { corners: Array<{ name?: string; setbacks?: Array<Record<string, unknown>> }> })
      .corners;
    expect(recorded).toHaveLength(8);
    const carrying = recorded.filter((entry) => entry.setbacks !== undefined);
    expect(carrying).toHaveLength(2);
    for (const entry of carrying) {
      expect(entry.setbacks).toHaveLength(1);
      expect(Object.keys(entry.setbacks?.[0] ?? {}).sort()).toEqual(['distance', 'name']);
    }
  });

  it('replay_history gives the identical recipe, and an upstream edit re-runs the fillet with the same overrides', () => {
    const kernel = scriptedKernel({ topology: TOPOLOGY });
    const { doc, id } = overridden(kernel);
    const first = filletOf(doc, doc.order[0] as string);
    const replayed = execute(doc, 'replay_history', {}, ctxOf(kernel));
    expect(replayed.rejected).not.toBe(true);
    expect(brepOf(replayed.document, replayed.document.order[0] as string)).toEqual(first);
    expect(first.corners).toHaveLength(8);
    const edited = execute(doc, 'edit_step_params', { stepId: doc.featureHistory[0]?.id, params: { size: [12, 12, 12] } }, ctxOf(kernel));
    expect(edited.rejected).not.toBe(true);
    const again = filletOf(edited.document, edited.document.order[0] as string);
    expect(again.corners).toEqual(first.corners);
    expect(again.edges).toEqual(first.edges);
    expect(id).toBeDefined();
  });

  it('a vertex whose name is not unique is recorded by its point, not by the name', () => {
    const clashing: ShapeTopology = { ...TOPOLOGY, edges: TOPOLOGY.edges.map((edge) => ({ ...edge, name: 'same' })) };
    const { doc, id } = cube();
    const done = execute(
      doc,
      'fillet_edge',
      { id, edgeIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], radius: 1, corners: [{ near: corner, setback: 2 }] },
      ctxOf(scriptedKernel({ topology: clashing })),
    );
    const recorded = (done.document.featureHistory.at(-1)?.params as { corners: Array<{ name?: string; near?: number[] }> }).corners;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.name).toBeUndefined();
    expect(recorded[0]?.near).toEqual([...corner]);
  });

  it('works for a part far from the origin: vertices coincide within a tolerance scaled to the part, not to the coordinates', () => {
    const far = {
      ...TOPOLOGY,
      edges: TOPOLOGY.edges.map((edge) => ({ ...edge, start: edge.start.map((c) => c + 1e5), end: edge.end.map((c) => c + 1e5) })),
    } as unknown as ShapeTopology;
    expect(solidVertices(far)).toHaveLength(8);
    const nudged = {
      ...far,
      edges: far.edges.map((edge, at) =>
        at === 0 ? { ...edge, start: [edge.start[0], edge.start[1], (edge.start[2] ?? 0) + 1e-3] } : edge,
      ),
    } as unknown as ShapeTopology;
    expect(solidVertices(nudged).length).toBeGreaterThan(8);
  });
});
