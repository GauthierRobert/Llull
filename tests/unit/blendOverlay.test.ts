/**
 * blend_overlay (06 BLD M5 review overlays): the check_blends readings of one solid as polylines with a status each, over scripted kernels
 * (the native values are checked in the desktop app). The readings are check_blends' own: the overlay never re-measures.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import type { FaceGraph } from '@core/geometry/kernelPorts';
import type { BlendOverlayLine } from '@core/commands/brep/blendOverlay';
import { SOURCE, edgeOf, scriptedKernel } from '../helpers/blendKernel';
import { CHAIN_FILLET, CHAIN_GRAPH, CHAIN_TOPOLOGY, chainKernel } from '../helpers/profiledChainKernel';
import { chamfer, entityOf, stub } from '../helpers/chamferLegsKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

const ctxOf = (kernel: GeometryKernel): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel });
type Overlay = {
  status: string;
  lines: BlendOverlayLine[];
  counts: Record<string, number>;
  findings: Array<{ code: string; severity: string; face: number | null; edge: number | null }>;
  firstFailure: { code: string; edge: number | null } | null;
  notRunReason?: string;
};

/** A box with the two profiled blends of the scripted topology, and `blend_overlay` read with `g1(edge, t)` as the angle between the normals. */
function overlayOf(
  g1: (edge: number, t: number) => number,
  params: Record<string, unknown> = {},
): { doc: CadDocument; result: ReturnType<typeof execute> } {
  const context = ctxOf(chainKernel(g1));
  const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  const done = execute(box.document, 'fillet_edge', { id: box.affected[0], ...CHAIN_FILLET }, context);
  expect(done.error).toBeUndefined();
  return { doc: done.document, result: execute(done.document, 'blend_overlay', { id: done.affected[0], ...params }, context) };
}
const dataOf = (result: ReturnType<typeof execute>): Overlay => result.data as Overlay;

describe('blend_overlay', () => {
  it('draws the two contacts and the junction of a smooth profiled chain, all pass, with their points and measured angle', () => {
    const { result } = overlayOf(() => 0, { samples: 5 });
    const data = dataOf(result);
    expect(data.status).toBe('pass');
    expect(data.lines.map((line) => [line.role, line.edge, line.status])).toEqual([
      ['contact', 0, 'pass'],
      ['junction', 2, 'pass'],
      ['contact', 1, 'pass'],
    ]);
    expect(data.counts).toEqual({ pass: 3, warn: 0, fail: 0, not_run: 0 });
    expect(data.lines.every((line) => line.points.length === 5)).toBe(true);
    expect(data.lines[0]).toMatchObject({ face: 3, blend: 'blend(e(T|W1))', angleRad: 0 });
    expect(data.firstFailure).toBeNull();
  });

  it('a contact whose normals differ by more than the G1 limit is a fail line, the others stay pass, and the first failing finding is named', () => {
    const { result } = overlayOf((edge) => (edge === 0 ? 0.3 : 0));
    const data = dataOf(result);
    expect(data.status).toBe('fail');
    expect(data.lines.find((line) => line.edge === 0)).toMatchObject({ status: 'fail', angleRad: 0.3 });
    expect(data.lines.filter((line) => line.status === 'pass').map((line) => line.edge)).toEqual([2, 1]);
    expect(data.counts).toMatchObject({ pass: 2, fail: 1 });
    expect(data.firstFailure).toMatchObject({ code: 'BLD_CHECK_G1_ANGLE', edge: 0 });
    expect(result.summary).toContain('1 fail');
  });

  it('the samples parameter sets the points per line', () => {
    const data = dataOf(overlayOf(() => 0, { samples: 3 }).result);
    expect(data.lines.every((line) => line.points.length === 3)).toBe(true);
  });

  it('is pure and read-only: the document is returned unchanged, nothing affected', () => {
    const { doc, result } = overlayOf(() => 0);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    const kernel = scriptedKernel({ topology: CHAIN_TOPOLOGY, graph: CHAIN_GRAPH });
    expectPure(doc, () => execute(doc, 'blend_overlay', { id: Object.keys(doc.entities)[0] }, ctxOf(kernel)));
  });

  it('a solid without a blend answers not_run with a reason, no error and no line', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    const result = execute(box.document, 'blend_overlay', { id: box.affected[0] }, ctxOf(scriptedKernel()));
    expect(result.error).toBeUndefined();
    expect(dataOf(result)).toMatchObject({ status: 'not_run', lines: [], firstFailure: null });
    expect(dataOf(result).notRunReason).toContain('no filleted');
  });

  it('refuses an unknown id and a 2D entity, leaving the document unchanged', () => {
    const doc = createEmptyDocument();
    const missing = execute(doc, 'blend_overlay', { id: 'nope' });
    expectNoOp(missing, doc);
    expect(missing.error?.code).toBe('SRF_ENTITY_NOT_FOUND');
    const line = execute(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 0],
      ],
    });
    expect(line.affected).toHaveLength(1);
    const flat = execute(line.document, 'blend_overlay', { id: line.affected[0] });
    expectNoOp(flat, line.document);
    expect(flat.error?.code).toBe('SRF_ENTITY_NOT_FOUND');
  });

  it('rejects samples outside 2..101 as invalid params', () => {
    const { doc } = overlayOf(() => 0);
    const id = Object.keys(doc.entities)[0] as string;
    expectNoOp(execute(doc, 'blend_overlay', { id, samples: 1 }), doc, 'invalid params');
  });

  it('without an exact kernel the solid answers not_run and nothing is drawn', () => {
    const { doc } = overlayOf(() => 0);
    const id = Object.keys(doc.entities)[0] as string;
    const result = execute(doc, 'blend_overlay', { id }, { ...defaultContext(), kernel: null });
    expect(result.error).toBeUndefined();
    expect(dataOf(result)).toMatchObject({ status: 'not_run', lines: [] });
    const noQueries = execute(
      doc,
      'blend_overlay',
      { id },
      ctxOf(scriptedKernel({ topology: CHAIN_TOPOLOGY, graph: CHAIN_GRAPH, noFaceQuery: true })),
    );
    expect(dataOf(noQueries)).toMatchObject({ status: 'not_run', lines: [] });
  });

  it('an info finding (a curvature jump under G1) is not listed and does not colour the line', () => {
    const kernel = scriptedKernel({
      topology: CHAIN_TOPOLOGY,
      graph: CHAIN_GRAPH,
      g1: () => 0,
      curvature: (edge) => (edge === 0 ? [0, 1] : [0, 0]),
    });
    const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const done = execute(box.document, 'fillet_edge', { id: box.affected[0], ...CHAIN_FILLET }, ctxOf(kernel));
    const checked = execute(done.document, 'check_blends', {}, ctxOf(kernel)).data as {
      findings: Array<{ code: string; severity: string }>;
    };
    expect(checked.findings.map((found) => found.severity)).toContain('info');
    const data = dataOf(execute(done.document, 'blend_overlay', { id: done.affected[0] }, ctxOf(kernel)));
    expect(data.findings).toEqual([]);
    expect(data.lines.map((line) => line.status)).toEqual(['pass', 'pass', 'pass']);
  });

  it('a boolean result with no blend answers not_run with the reason, not an error', () => {
    const kernel = scriptedKernel({ topology: CHAIN_TOPOLOGY, graph: CHAIN_GRAPH });
    const a = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const b = execute(a.document, 'add_box', { size: [5, 5, 5] });
    const union = execute(b.document, 'boolean', { op: 'union', a: a.affected[0], b: b.affected[0] }, ctxOf(kernel));
    const id = union.affected[0] as string;
    expect(id).toBeDefined();
    const result = execute(union.document, 'blend_overlay', { id }, ctxOf(kernel));
    expect(result.error).toBeUndefined();
    expect(dataOf(result).notRunReason).toContain('no filleted');
  });

  it('a blend face with no contact line counts as one not_run', () => {
    const kernel = scriptedKernel({
      topology: CHAIN_TOPOLOGY,
      graph: { faces: [], edgeFaces: [[], [], [], []], edgeConvexity: [] } as unknown as FaceGraph,
    });
    const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const filleted = execute(box.document, 'fillet_edge', { id: box.affected[0], radius: 1 }, ctxOf(kernel));
    const data = dataOf(execute(filleted.document, 'blend_overlay', { id: filleted.affected[0] }, ctxOf(kernel)));
    expect(data.lines).toEqual([]);
    expect(data.counts.not_run).toBeGreaterThan(0);
  });
});

describe('blend_overlay corner patches and chamfers', () => {
  it('a corner patch is drawn as corner lines with its profile and the largest of the interior and end angles; a warning shows as warn', () => {
    const patch = `blend(v:e(${SOURCE}:a|${SOURCE}:b),e(${SOURCE}:a|${SOURCE}:c),e(${SOURCE}:b|${SOURCE}:c))#1`;
    const topology: ShapeTopology = {
      solids: 1,
      vertices: 8,
      volume: 1000,
      faces: [
        { index: 0, name: `${SOURCE}:x+`, surface: 'plane', area: 4, normal: [1, 0, 0] },
        { index: 1, name: `${SOURCE}:z+`, surface: 'plane', area: 4, normal: [0, 0, 1] },
        { index: 2, name: patch, surface: 'bspline', area: 3 },
      ],
      edges: [edgeOf(0), edgeOf(1), edgeOf(2)],
    };
    const graph = { faces: [], edgeFaces: [[0, 2], [1, 2], [2]], edgeConvexity: [] } as unknown as FaceGraph;
    const kernel = scriptedKernel({ topology, graph, g1: (_edge, t) => (t === 0 || t === 1 ? 0.02 : 0.001) });
    const box = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    const filleted = execute(
      box.document,
      'fillet_edge',
      { id: box.affected[0], radius: 1, corners: [{ near: [-5, -5, -5], setback: 2 }] },
      { kernel: scriptedKernel({ topology: { ...topology, faces: topology.faces.slice(0, 2) } }) } as never,
    );
    const data = dataOf(execute(filleted.document, 'blend_overlay', { id: filleted.affected[0] }, ctxOf(kernel)));
    expect(data.lines.map((line) => [line.role, line.profile, line.status])).toEqual([
      ['corner', 'star', 'warn'],
      ['corner', 'star', 'warn'],
    ]);
    expect(data.lines[0]?.angleRad).toBe(0.02);
    expect(data.status).toBe('warn');
    expect(data.counts).toMatchObject({ warn: 2 });
    expect(data.firstFailure).toBeNull();
    expect(data.findings[0]).toMatchObject({ code: 'BLD_CHECK_G1_ANGLE', severity: 'warn' });
  });

  const chamferDoc = (): CadDocument => ({
    ...createEmptyDocument(),
    entities: { m: { ...entityOf(chamfer()), mesh: { positions: [], indices: [] } } as never },
    order: ['m'],
  });

  it('a chamfer whose leg is off its law is a fail line with its deviation; a measured one passes with the same points as its edge', () => {
    const doc = chamferDoc();
    const off = dataOf(execute(doc, 'blend_overlay', { id: 'm' }, ctxOf(stub({ first: () => 1.5 }))));
    expect(off.lines).toHaveLength(1);
    expect(off.lines[0]).toMatchObject({ role: 'chamfer', status: 'fail', angleRad: null, gap: null, profile: 'chamfer' });
    expect(off.lines[0]?.deviation).toBeCloseTo(0.5, 9);
    expect(off.firstFailure).toMatchObject({ code: 'BLD_CHECK_CHAMFER_LEGS' });
    const good = dataOf(execute(doc, 'blend_overlay', { id: 'm' }, ctxOf(stub())));
    expect(good.lines[0]).toMatchObject({ status: 'pass' });
    expect(good.lines[0]?.points.length).toBeGreaterThan(1);
  });

  it('a chamfer that could not be verified is a not_run line and the status is not_run, never a pass', () => {
    const data = dataOf(execute(chamferDoc(), 'blend_overlay', { id: 'm' }, ctxOf(stub({ missing: 'contact' }))));
    expect(data.status).toBe('not_run');
    expect(data.lines[0]).toMatchObject({ role: 'chamfer', status: 'not_run' });
    expect(data.counts.not_run).toBe(1);
    expect(data.findings[0]).toMatchObject({ code: 'BLD_CHECK_CHAMFER_UNVERIFIED', severity: 'warn' });
  });
});

describe('blend_overlay radius law', () => {
  const S = 'box-1.1';
  const SOURCE_EDGE = `e(${S}:y+|${S}:z+)`;
  const line = (index: number, name: string, y: number): ShapeTopology['edges'][number] =>
    edgeOf(index, { name, start: [-10, y, 2.5], end: [10, y, 2.5], mid: [0, y, 2.5] });
  const topology: ShapeTopology = {
    solids: 1,
    faces: [
      { index: 0, name: `${S}:z+`, surface: 'plane', area: 160, normal: [0, 0, 1] },
      { index: 1, name: `${S}:y+`, surface: 'plane', area: 60, normal: [0, 1, 0] },
      { index: 2, name: `blend(${SOURCE_EDGE})`, surface: 'bspline', area: 40 },
      { index: 3, name: `${S}:x-`, surface: 'plane', area: 20, normal: [-1, 0, 0] },
    ],
    edges: [
      line(0, `e(blend|${S}:z+)`, 4),
      edgeOf(1, { name: `e(blend|${S}:y+)`, start: [-10, 5, 1.5], end: [10, 5, 1.5], mid: [0, 5, 1.5] }),
      line(2, 'end', 40),
      line(3, SOURCE_EDGE, 5),
    ],
    vertices: 8,
    volume: 1000,
  };
  const graph = {
    faces: [],
    edgeFaces: [
      [2, 0],
      [2, 1],
      [2, 3],
      [0, 1],
    ],
    edgeConvexity: [],
  } as unknown as FaceGraph;

  it('a blend whose realised radius is off its law is a failing finding of the face: its pass lines show fail and the first failure names the radius', () => {
    const kernel = scriptedKernel({
      topology,
      graph,
      g1: () => 0,
      sections: (_face, count) =>
        Array.from({ length: count }, (_, k) => {
          const x = -10 + (20 * k) / (count - 1);
          return { t: k / (count - 1), a: [x, 4, 2.5], mid: [x, 4.3, 2.2], b: [x, 5, 1.5], radius: 1.2, centre: [x, 4, 1.5] };
        }),
    });
    const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const done = execute(box.document, 'fillet_edge', { id: box.affected[0], edges: [{ index: 3, size: 1 }] }, ctxOf(kernel));
    const data = dataOf(execute(done.document, 'blend_overlay', { id: done.affected[0] }, ctxOf(kernel)));
    expect(data.status).toBe('fail');
    expect(data.lines.length).toBeGreaterThan(0);
    expect(data.lines.every((found) => found.status === 'fail')).toBe(true);
    expect(data.firstFailure?.code).toBe('BLD_CHECK_RADIUS_LAW');
  });
});
