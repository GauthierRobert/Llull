/**
 * BLD cliff edges of fillet_faces (TECHNICAL_SPEC 13.28), what the result reports: data.cliffEngaged / cliffEdgeAngle / cliffFace and the summary,
 * the check_blends info row at the cliff edge, and the save -> load -> replay round trip of the recipe field, over a scripted kernel (native values:
 * server/tests/nativeBlendCliff.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel, type GeometryKernel, type ShapeTopology } from '@core/geometry/kernel';
import type { FaceGraph } from '@core/geometry/kernelPorts';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { recipeKey } from '@core/geometry/shapeRecipe';
import { SOURCE, edgeOf, scriptedKernel } from '../helpers/blendKernel';

afterEach(() => setGeometryKernel(null));

const A = `${SOURCE}:ledge`;
const B = `${SOURCE}:wall`;
const FAR = `${SOURCE}:far`;
const BLEND = `blend(e(${A}|${B}))`;
const face = (index: number, name: string): ShapeTopology['faces'][number] => ({
  index,
  name,
  surface: 'plane',
  area: 4,
  normal: [1, 0, 0],
});
// source solid: ledge (0), wall (1), the face beyond the cliff edge (2)
const BEFORE: ShapeTopology = { solids: 1, faces: [face(0, A), face(1, B), face(2, FAR)], edges: [edgeOf(0)], vertices: 8, volume: 10 };
const withBlend = (faces: ShapeTopology['faces'], edges: ShapeTopology['edges']): ShapeTopology => ({ ...BEFORE, faces, edges });
// engaged: the ledge is gone; the blend (2) meets the wall along edge 0 (its support), the far face along edge 1 (the cliff edge) and an end wall in an arc (edge 2)
const ENGAGED = withBlend(
  [face(0, B), face(1, FAR), { ...face(2, BLEND), surface: 'cylinder' }],
  [edgeOf(0), edgeOf(1), edgeOf(2, { curve: 'circle' })],
);
const ENGAGED_GRAPH = { faces: [], edgeFaces: [[2, 0], [2, 1], [2]], edgeConvexity: [] } as unknown as FaceGraph;
// not needed: both supports stay, the blend meets each along a contact line
const PLAIN = withBlend([face(0, A), face(1, B), { ...face(2, BLEND), surface: 'cylinder' }], [edgeOf(0), edgeOf(1)]);
const PLAIN_GRAPH = {
  faces: [],
  edgeFaces: [
    [2, 0],
    [2, 1],
  ],
  edgeConvexity: [],
} as unknown as FaceGraph;

const isBlend = (shape: unknown): boolean => (shape as { recipe?: { op?: string } }).recipe?.op === 'faceBlend';

/** A scripted kernel whose source solid has BEFORE and whose face blend has `after`. */
function kernelWith(after: ShapeTopology, graph: FaceGraph, script: { g1?: number; noContinuity?: boolean } = {}): GeometryKernel {
  const base = scriptedKernel({
    topology: after,
    graph,
    g1: (edge) => (edge === 1 ? (script.g1 ?? 0) : 0),
    distance: () => 0,
    ...(script.noContinuity === true ? { noContinuity: true } : {}),
  });
  return { ...base, topology: (shape) => (isBlend(shape) ? after : BEFORE) };
}

const request = (id: unknown, cliff: 'A' | null): Record<string, unknown> => ({
  id,
  facesA: { near: [[0, 0, 0]] },
  facesB: { near: [[1, 0, 0]] },
  radius: 3,
  ...(cliff === null ? {} : { cliff }),
});

const built = (kernel: GeometryKernel, cliff: 'A' | null = 'A'): ReturnType<typeof execute> => {
  const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  return execute(box.document, 'fillet_faces', request(box.affected[0], cliff), { ...defaultContext(), kernel });
};

type Finding = { code: string; severity: string; value: number; message: string; edge: number };
const findingsOf = (result: ReturnType<typeof execute>): Finding[] => (result.data as { findings: Finding[] }).findings;

describe('fillet_faces cliff report', () => {
  it('engaged: data carries the angle at the cliff edge and the consumed face, the summary says it is sharp there', () => {
    const result = built(kernelWith(ENGAGED, ENGAGED_GRAPH, { g1: Math.PI / 3 }));
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ cliffEngaged: true, cliffEdgeAngle: 60, cliffFace: A, consumedFaces: [A] });
    expect(result.summary).toContain('G1 to set B, sharp (60°) at the cliff edge (angle between the surface normals, 0 = tangent)');
  });

  it('not needed: cliffEngaged false and the summary says the plain tangent blend was built', () => {
    const result = built(kernelWith(PLAIN, PLAIN_GRAPH, { g1: Math.PI / 3 }));
    expect(result.data).toMatchObject({ cliffEngaged: false });
    expect(result.data).not.toHaveProperty('cliffEdgeAngle');
    expect(result.summary).toContain('plain tangent blend was built');
  });

  it('an edge the kernel cannot measure is not reported as a cliff', () => {
    expect(built(kernelWith(ENGAGED, ENGAGED_GRAPH, { noContinuity: true })).data).toMatchObject({ cliffEngaged: false });
  });

  it('without cliff the data has no cliff fields', () => {
    expect(built(kernelWith(PLAIN, PLAIN_GRAPH), null).data).not.toHaveProperty('cliffEngaged');
  });

  it('check_blends reads the cliff edge as an info row with its angle, not a failure; a plain blend has none', () => {
    const kernel = kernelWith(ENGAGED, ENGAGED_GRAPH, { g1: Math.PI / 3 });
    const checked = execute(built(kernel).document, 'check_blends', {}, { ...defaultContext(), kernel });
    const row = findingsOf(checked).find((finding) => finding.code === 'BLD_CHECK_CLIFF_EDGE');
    expect(row).toMatchObject({ severity: 'info', edge: 1 });
    expect(row?.value).toBeCloseTo(Math.PI / 3, 9);
    expect(row?.message).toContain('cliff edge, not a tangent contact (angle 60°)');
    expect(findingsOf(checked).filter((finding) => finding.severity === 'fail')).toEqual([]);
    const plainKernel = kernelWith(PLAIN, PLAIN_GRAPH);
    const plain = execute(built(plainKernel).document, 'check_blends', {}, { ...defaultContext(), kernel: plainKernel });
    expect(findingsOf(plain).map((finding) => finding.code)).not.toContain('BLD_CHECK_CLIFF_EDGE');
  });

  it.each([['A' as const], [null]])('save -> load -> replay with cliff %s keeps the recipe field and the recipe key', (cliff) => {
    const kernel = kernelWith(ENGAGED, ENGAGED_GRAPH, { g1: Math.PI / 3 });
    const ctx = { ...defaultContext(), kernel };
    const made = built(kernel, cliff);
    const id = made.affected[0] as string;
    const recipeOf = (doc: CadDocument): { cliff?: string } & NonNullable<MeshSolidEntity['brep']> =>
      (doc.entities[id] as MeshSolidEntity).brep as never;
    const loaded = deserializeDocument(serializeDocument(made.document));
    expect(recipeOf(loaded)).toEqual(recipeOf(made.document));
    expect(recipeOf(loaded).cliff).toBe(cliff ?? undefined);
    expect(loaded.featureHistory.at(-1)?.params).toMatchObject(cliff === null ? {} : { cliff });
    const replayed = execute(loaded, 'replay_history', {}, ctx);
    expect(replayed.error).toBeUndefined();
    expect(recipeOf(replayed.document).cliff).toBe(cliff ?? undefined);
    expect(recipeKey(recipeOf(replayed.document))).toBe(recipeKey(recipeOf(made.document)));
  });
});
