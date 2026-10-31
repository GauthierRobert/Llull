/**
 * BLD M4 remainder: fillet_faces over faces that share a sharp edge goes through those edges and their tangent chain (fillet_edge's builder),
 * over a scripted kernel; the flat spandrel build only serves faces that share none. Native values: server/tests/nativeBlendFaceSets.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import type { FaceGraph } from '@core/geometry/kernelPorts';
import { edgeOf, scriptedKernel, TOPOLOGY } from '../helpers/blendKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

const context = (kernel: GeometryKernel): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel });
const box = (): { doc: CadDocument; id: string } => {
  const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  return { doc: made.document, id: made.affected[0] as string };
};
const brepOf = (doc: CadDocument, id: string): ShapeRecipe | undefined => (doc.entities[id] as MeshSolidEntity).brep;
/** Face sets of the scripted topology: the nearest-face stub maps x to the face index. */
const setOf = (...faces: number[]): { near: Array<[number, number, number]> } => ({ near: faces.map((face) => [face, 0, 0]) });
// scripted adjacency: edge 0 joins faces 0 and 1, edge 2 joins faces 0 and 2, edge 1 joins faces 1 and 2, edge 4 joins faces 0 and 3

/**
 * A kernel whose fillet result carries the blend faces of a tangent chain the way the native kernel names them: edge 0 joins faces x+ (0) and
 * z+ (1), edge 1 joins the faces `between`; the result has a blend face for edge 0 and for edge 1.
 */
const chained = (between: [number, number]): GeometryKernel => {
  const name = (edge: [number, number]): string => `e(${TOPOLOGY.faces[edge[0]]?.name}|${TOPOLOGY.faces[edge[1]]?.name})`;
  const edgeNames = [name([0, 1]), name(between)];
  const source: ShapeTopology = { ...TOPOLOGY, edges: edgeNames.map((edgeName, index) => edgeOf(index, { name: edgeName })) };
  const result: ShapeTopology = {
    ...source,
    faces: [
      ...source.faces,
      ...edgeNames.map((edgeName, k) => ({ index: 10 + k, name: `blend(${edgeName})`, surface: 'cylinder' as const, area: 1 })),
    ],
  };
  const base = scriptedKernel({
    topology: source,
    graph: { faces: [], edgeFaces: [[0, 1], between], edgeConvexity: [] } as unknown as FaceGraph,
  });
  return { ...base, topology: (shape) => (JSON.stringify(shape).includes('"fillet"') ? result : source) };
};

describe('fillet_faces over the edges two face sets share', () => {
  it('a set of several faces (one of them curved) blends every shared edge with the one radius; data lists the edges, the blend faces, the unit', () => {
    const { doc, id } = box();
    const kernel = scriptedKernel();
    const result = execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1, 2), radius: 2 }, context(kernel));
    expect(result.error).toBeUndefined();
    expect(result.summary).toMatch(/^fillet_faces: /);
    expect(result.summary).toContain("Blend edges (shared by facesA and facesB, with the kernel's tangent chain)");
    expect(brepOf(result.document, result.affected[0] as string)).toMatchObject({ op: 'fillet', edges: [0, 2], size: 2 });
    const data = result.data as {
      id: string;
      blends: unknown[];
      blendEdges: Array<{ index: number; start: number[]; end: number[] }>;
      unit: string;
    };
    expect(data).toMatchObject({ id: result.affected[0], blends: [], consumedFaces: [], unit: 'mm' });
    expect(data.blendEdges.map((entry) => entry.index)).toEqual([0, 2]);
    expect(data.blendEdges[0]).toMatchObject({ start: [0, 0, 0], end: [20, 0, 0] });
    expectPure(doc, () => execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1, 2), radius: 2 }, context(kernel)));
  });

  it('every pair that shares a sharp edge is built by the edge path (a plain radius too); only faces that share none use the spandrel', () => {
    const { doc, id } = box();
    const adjacent = execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1), radius: 2 }, context(scriptedKernel()));
    expect(brepOf(adjacent.document, adjacent.affected[0] as string)).toMatchObject({ op: 'fillet', edges: [0], size: 2 });
    const apart = execute(doc, 'fillet_faces', { id, facesA: setOf(3), facesB: setOf(1), radius: 2 }, context(scriptedKernel()));
    expect(brepOf(apart.document, apart.affected[0] as string)).toMatchObject({ op: 'faceBlend', facesA: [3], facesB: [1] });
  });

  it('radiusEnd, a law and a width on one shared edge become fillet_edge sizes (smooth end radius, expression law, chord mode)', () => {
    const { doc, id } = box();
    const kernel = scriptedKernel();
    const sets = { id, facesA: setOf(0), facesB: setOf(1) };
    const ended = execute(doc, 'fillet_faces', { ...sets, radius: 1, radiusEnd: 2 }, context(kernel));
    expect(brepOf(ended.document, ended.affected[0] as string)).toMatchObject({ op: 'fillet', edges: [0], size: 1, sizeEnd: 2 });
    const lawed = execute(doc, 'fillet_faces', { ...sets, law: { expression: '1 + t', samples: 9 } }, context(kernel));
    expect(lawed.error).toBeUndefined();
    expect(brepOf(lawed.document, lawed.affected[0] as string)).toMatchObject({ op: 'fillet', edges: [0], radii: [{ size: 1 }] });
    const chord = execute(doc, 'fillet_faces', { ...sets, width: 2 }, context(kernel));
    expect(chord.error).toBeUndefined();
    expect((brepOf(chord.document, chord.affected[0] as string) as { size: number }).size).toBeCloseTo(2 / Math.SQRT2, 6);
    const chordEnd = execute(doc, 'fillet_faces', { ...sets, width: 2, widthEnd: 3 }, context(kernel));
    const converted = brepOf(chordEnd.document, chordEnd.affected[0] as string) as { size: number; sizeEnd: number };
    expect(converted.size).toBeCloseTo(2 / Math.SQRT2, 6);
    expect(converted.sizeEnd).toBeCloseTo(3 / Math.SQRT2, 6);
  });

  it('startNear picks the t = 0 end: the sizes swap, a law runs the other way, and data / summary give the ends in that order', () => {
    const { doc, id } = box();
    const kernel = scriptedKernel();
    const sets = { id, facesA: setOf(0), facesB: setOf(1) };
    const atStart = execute(doc, 'fillet_faces', { ...sets, radius: 1, radiusEnd: 2, startNear: [1, 0, 0] }, context(kernel));
    expect(brepOf(atStart.document, atStart.affected[0] as string)).toMatchObject({ size: 1, sizeEnd: 2 });
    const atEnd = execute(doc, 'fillet_faces', { ...sets, radius: 1, radiusEnd: 2, startNear: [19, 0, 0] }, context(kernel));
    expect(brepOf(atEnd.document, atEnd.affected[0] as string)).toMatchObject({ size: 2, sizeEnd: 1 });
    const blendEdges = (atEnd.data as { blendEdges: Array<{ start: number[]; end: number[] }> }).blendEdges;
    expect(blendEdges[0]).toMatchObject({ start: [20, 0, 0], end: [0, 0, 0] });
    expect(atEnd.summary).toContain('0 (20, 0, 0) -> (0, 0, 0)');
    const lawEnd = execute(
      doc,
      'fillet_faces',
      { ...sets, law: { expression: '1 + t', samples: 9 }, startNear: [19, 0, 0] },
      context(kernel),
    );
    expect(brepOf(lawEnd.document, lawEnd.affected[0] as string)).toMatchObject({ radii: [{ size: 2 }] });
    const widthEnd = execute(doc, 'fillet_faces', { ...sets, width: 2, widthEnd: 3, startNear: [19, 0, 0] }, context(kernel));
    expect(brepOf(widthEnd.document, widthEnd.affected[0] as string)).toMatchObject({ size: expect.closeTo(3 / Math.SQRT2, 6) as number });
  });

  it('refusals keep fillet_faces param names (law.expression, radiusEnd, width), in error.paths and in the summary', () => {
    const { doc, id } = box();
    const kernel = context(scriptedKernel());
    const sets = { id, facesA: setOf(0), facesB: setOf(1) };
    const bad = execute(doc, 'fillet_faces', { ...sets, law: { expression: 't - 2' } }, kernel);
    expect(bad.error).toMatchObject({ code: 'BLD_LAW_INVALID', paths: ['law.expression'] });
    expect(bad.summary).toContain('(law.expression)');
    expect(bad.document).toBe(doc);
    const closed = { id, facesA: setOf(1), facesB: setOf(2) };
    expect(execute(doc, 'fillet_faces', { ...closed, law: { expression: '1 + t', samples: 9 } }, kernel).error).toMatchObject({
      code: 'BLD_LAW_NOT_PERIODIC',
      paths: ['law'],
    });
    expect(execute(doc, 'fillet_faces', { ...closed, radius: 1, radiusEnd: 2 }, kernel).error).toMatchObject({
      code: 'BLD_LAW_NOT_PERIODIC',
      paths: ['radiusEnd'],
    });
    expect(execute(doc, 'fillet_faces', { ...closed, width: 1, widthEnd: 2 }, kernel).error).toMatchObject({
      code: 'BLD_LAW_NOT_PERIODIC',
      paths: ['widthEnd'],
    });
    const tangent = execute(doc, 'fillet_faces', { ...closed, width: 1 }, context(scriptedKernel({ g1: () => 0 })));
    expect(tangent.error).toMatchObject({ code: 'BLD_CHORD_UNDEFINED', paths: ['width'] });
    const periodic = execute(doc, 'fillet_faces', { ...closed, law: { expression: '1 + 0.2 * sin(tau * t)', samples: 9 } }, kernel);
    expect(periodic.error).toBeUndefined();
  });

  it('a profile rides along', () => {
    const { doc, id } = box();
    const profiled = execute(
      doc,
      'fillet_faces',
      { id, facesA: setOf(0), facesB: setOf(1, 2), radius: 1, profile: { type: 'conic', rho: 0.4 } },
      context(scriptedKernel()),
    );
    expect(brepOf(profiled.document, profiled.affected[0] as string)).toMatchObject({ op: 'fillet', profile: { type: 'conic', rho: 0.4 } });
  });

  it('the kernel chain of a shared edge is read back: inside the sets it is reported, resting on a face outside them the blend is refused', () => {
    const { doc, id } = box();
    // the kernel also rounded edge 1, which bounds faces 1 and 2: inside facesB = {1, 2}
    const inside = execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1, 2), radius: 2 }, context(chained([1, 2])));
    expect(inside.error).toBeUndefined();
    expect((inside.data as { blendEdges: Array<{ index: number }> }).blendEdges.map((entry) => entry.index)).toEqual([0, 1]);
    expect((inside.data as { blends: unknown[] }).blends).toHaveLength(2);
    // ... bounding face 2 (x+ and side), which is in neither set
    const outside = execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1), radius: 2 }, context(chained([0, 2])));
    expectNoOp(outside, doc, 'outside facesA and facesB');
    expect(outside.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['facesA'] });
    expect(outside.summary).toContain('edge 1 (bounds box-1.1:side)');
  });

  it('a varying size is refused when the kernel chain has more than one edge, at the param of the size; the hold line likewise', () => {
    const { doc, id } = box();
    const kernel = chained([1, 2]);
    // one shared edge (0), a kernel chain of two (0 and 1, both inside the sets)
    const sets = { id, facesA: setOf(0), facesB: setOf(1, 2) };
    const varying = execute(doc, 'fillet_faces', { ...sets, facesA: setOf(0), radius: 1, radiusEnd: 2 }, context(kernel));
    expectNoOp(varying, doc, 'kernel rounded a chain of 2 edges');
    expect(varying.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['radiusEnd'] });
    const lawed = execute(doc, 'fillet_faces', { ...sets, law: { expression: '1 + t' } }, context(kernel));
    expect(lawed.error?.paths).toEqual(['law']);
    const widthEnd = execute(doc, 'fillet_faces', { ...sets, width: 1, widthEnd: 2 }, context(kernel));
    expect(widthEnd.error?.paths).toEqual(['widthEnd']);
  });

  it('two seeds that are not one tangent chain with radiusEnd are refused before the build, at radiusEnd', () => {
    const { doc, id } = box();
    const refused = execute(
      doc,
      'fillet_faces',
      { id, facesA: setOf(0), facesB: setOf(1, 2), radius: 1, radiusEnd: 2 },
      context(scriptedKernel()),
    );
    expectNoOp(refused, doc, 'not one tangent chain');
    expect(refused.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['radiusEnd'] });
  });

  it('a split blend face carries the same name twice: it is one edge, so a varying size is fine; an unreadable chain is refused', () => {
    const { doc, id } = box();
    const base = chained([1, 2]);
    const withFaces = (extra: Array<{ index: number; name?: string }>): GeometryKernel => ({
      ...base,
      topology: (shape) => {
        const full = base.topology(shape);
        return full === null || !JSON.stringify(shape).includes('"fillet"')
          ? full
          : {
              ...full,
              faces: [
                ...full.faces.filter((face) => face.index < 10),
                ...extra.map((face) => ({ ...face, surface: 'cylinder' as const, area: 1 })),
              ],
            };
      },
    });
    const name = TOPOLOGY.faces[0]?.name + '|' + TOPOLOGY.faces[1]?.name;
    const twice = withFaces([
      { index: 10, name: `blend(e(${name}))` },
      { index: 11, name: `blend(e(${name}))` },
    ]);
    const sets = { id, facesA: setOf(0), facesB: setOf(1) };
    const split = execute(doc, 'fillet_faces', { ...sets, radius: 1, radiusEnd: 2 }, context(twice));
    expect(split.error).toBeUndefined();
    expect((split.data as { blends: unknown[] }).blends).toHaveLength(2);
    const stranger = execute(doc, 'fillet_faces', { ...sets, radius: 1 }, context(withFaces([{ index: 10, name: 'strange' }])));
    expectNoOp(stranger, doc, "cannot read the kernel's chain");
    expect(stranger.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['facesA'] });
    const unnamed = execute(doc, 'fillet_faces', { ...sets, radius: 1 }, context(withFaces([{ index: 10 }])));
    expect(unnamed.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
  });

  it('the refusal lists at most 10 out-of-set chain edges and counts the rest', () => {
    const { doc, id } = box();
    const base = scriptedKernel();
    const many = Array.from({ length: 13 }, (_, k) => ({
      index: 10 + k,
      name: `blend(e(box-1.1:x+|box-1.1:side${k}))`,
      surface: 'cylinder' as const,
      area: 1,
    }));
    const kernel: GeometryKernel = {
      ...base,
      topology: (shape) => {
        const full = base.topology(shape);
        return full === null || !JSON.stringify(shape).includes('"fillet"') ? full : { ...full, faces: [...full.faces, ...many] };
      },
    };
    const refused = execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1), radius: 1 }, context(kernel));
    expect(refused.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    expect(refused.summary).toContain('and 3 more');
    expect(refused.summary.match(/bounds /g)).toHaveLength(10);
  });

  it('startNear on a closed edge is refused at startNear, naming the seam vertex; an open edge is fine', () => {
    const { doc, id } = box();
    const closed = execute(
      doc,
      'fillet_faces',
      { id, facesA: setOf(1), facesB: setOf(2), radius: 1, radiusEnd: 1, startNear: [0, 0, 0] },
      context(scriptedKernel()),
    );
    expectNoOp(closed, doc, 'seam vertex is at (5, 0, 0)');
    expect(closed.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', paths: ['startNear'] });
    const open = execute(
      doc,
      'fillet_faces',
      { id, facesA: setOf(0), facesB: setOf(1), radius: 1, radiusEnd: 2, startNear: [0, 0, 0] },
      context(scriptedKernel()),
    );
    expect(open.error).toBeUndefined();
  });

  it('sets that share no sharp edge, tangent edges and a kernel without adjacency are named refusals', () => {
    const { doc, id } = box();
    const apart = execute(doc, 'fillet_faces', { id, facesA: setOf(3), facesB: setOf(1), width: 1 }, context(scriptedKernel()));
    expectNoOp(apart, doc, 'share no sharp edge');
    expect(apart.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED', ids: [id], paths: ['facesA'] });
    const curvedApart = execute(doc, 'fillet_faces', { id, facesA: setOf(3), facesB: setOf(1, 2), radius: 1 }, context(scriptedKernel()));
    expect(curvedApart.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    const tangent = { faces: [], edgeFaces: [[0, 1]], edgeConvexity: ['smooth'] } as unknown as FaceGraph;
    const smooth = execute(
      doc,
      'fillet_faces',
      { id, facesA: setOf(0), facesB: setOf(1), width: 1 },
      context(scriptedKernel({ graph: tangent })),
    );
    expect(smooth.error?.code).toBe('BLD_FACE_BLEND_UNSUPPORTED');
    const noGraph = execute(
      doc,
      'fillet_faces',
      { id, facesA: setOf(0), facesB: setOf(1), width: 1 },
      context(scriptedKernel({ noGraph: true })),
    );
    expect(noGraph.error).toMatchObject({ code: 'BLD_FACE_BLEND_UNSUPPORTED' });
    expect(noGraph.summary).toContain('no face adjacency');
  });

  it('seam and degenerate edges are not blend edges', () => {
    const { doc, id } = box();
    const seamed = {
      faces: [],
      edgeFaces: [
        [0, 1],
        [0, 1],
      ],
      edgeConvexity: [],
    } as unknown as FaceGraph;
    const base = scriptedKernel({ graph: seamed });
    const kernel: GeometryKernel = {
      ...base,
      topology: (shape) => {
        const full = base.topology(shape);
        return full === null ? null : { ...full, edges: full.edges.map((edge) => (edge.index === 1 ? { ...edge, seam: true } : edge)) };
      },
    };
    const result = execute(doc, 'fillet_faces', { id, facesA: setOf(0), facesB: setOf(1), width: 1 }, context(kernel));
    expect((result.data as { blendEdges: Array<{ index: number }> }).blendEdges.map((entry) => entry.index)).toEqual([0]);
  });

  it('exactly one of radius / width / law / holdLine; radiusEnd needs radius; widthEnd needs width; sizes are positive', () => {
    const { doc, id } = box();
    const kernel = context(scriptedKernel());
    const sets = { id, facesA: setOf(0), facesB: setOf(1) };
    for (const extra of [{}, { radius: 1, width: 1 }, { width: 1, law: { expression: '1' } }])
      expect(execute(doc, 'fillet_faces', { ...sets, ...extra }, kernel).error?.code).toBe('BLD_BLEND_PARAMS');
    expect(execute(doc, 'fillet_faces', { ...sets }, kernel).error?.remediation).toContain('radiusEnd only with radius');
    expect(execute(doc, 'fillet_faces', { ...sets, width: 1, radiusEnd: 2 }, kernel).error).toMatchObject({
      code: 'BLD_BLEND_PARAMS',
      paths: ['radiusEnd'],
    });
    expect(execute(doc, 'fillet_faces', { ...sets, radius: 1, widthEnd: 2 }, kernel).error).toMatchObject({
      code: 'BLD_BLEND_PARAMS',
      paths: ['widthEnd'],
    });
    expect(execute(doc, 'fillet_faces', { ...sets, width: -1 }, kernel).error).toMatchObject({ code: 'BLD_LAW_INVALID', paths: ['width'] });
    expect(execute(doc, 'fillet_faces', { ...sets, radius: 1, radiusEnd: 0 }, kernel).error).toMatchObject({
      code: 'BLD_LAW_INVALID',
      paths: ['radiusEnd'],
    });
  });
});
