import { describe, expect, it } from 'vitest';
import { type CadDocument, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { cageProblem } from '@core/geometry/subdivision';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { volumeOf } from '../../helpers/fixtureDocument';

const empty = createEmptyDocument();
const run = (doc: CadDocument, name: string, params: object): ReturnType<typeof execute> =>
  execute(doc, name, params as Record<string, unknown>);
const entityOf = (doc: CadDocument, id: string): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;
const add = (params: object, doc: CadDocument = empty): { doc: CadDocument; id: string; e: SubdivisionEntity } => {
  const result = run(doc, 'add_subdivision_solid', params);
  expect(result.affected, result.summary).toHaveLength(1);
  const id = result.affected[0] as string;
  return { doc: result.document, id, e: entityOf(result.document, id) };
};
const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
const data = <T>(result: ReturnType<typeof execute>): T => result.data as T;

/** Vertices, edges, faces and Euler characteristic of a cage. */
function counts(e: SubdivisionEntity): { V: number; E: number; F: number; euler: number } {
  const V = e.vertices.length;
  const F = e.faces.length;
  const E = e.faces.reduce((total, face) => total + face.length, 0) / 2;
  return { V, E, F, euler: V - E + F };
}
const creased = (doc: CadDocument, id: string): CadDocument => run(doc, 'edit_subdivision_cage', { id, crease: true }).document;
const uniqueIds = (e: SubdivisionEntity): boolean =>
  new Set(e.elementIds.vertices).size === e.vertices.length && new Set(e.elementIds.faces).size === e.faces.length;

describe('extrude_cage_faces (VC-DIR-19)', () => {
  const cube = add({ box: { size: [2, 2, 2] }, levels: 2 });
  it('extrudes the top face: V12 E20 F10, creased volume 12, ids kept and minted', () => {
    const result = run(cube.doc, 'extrude_cage_faces', { id: cube.id, faces: [0], distance: 1 });
    const e = entityOf(result.document, cube.id);
    expect(counts(e)).toEqual({ V: 12, E: 20, F: 10, euler: 2 });
    expect(volumeOf(creased(result.document, cube.id), cube.id)).toBeCloseTo(12, 12);
    expect(e.elementIds.vertices.slice(0, 8)).toEqual(cube.e.elementIds.vertices);
    expect(e.elementIds.faces.slice(0, 6)).toEqual(cube.e.elementIds.faces);
    expect(e.elementIds.vertices.slice(8)).toHaveLength(4);
    expect(e.elementIds.faces.slice(6).every((id) => id.startsWith('f-2.'))).toBe(true);
    expect(uniqueIds(e)).toBe(true);
    expect(cageProblem(e)).toBeNull();
    const d = data<{ capFaces: string[]; newFaces: string[]; newVertices: string[]; vertexIds: string[] }>(result);
    expect(d.capFaces).toEqual(['f-1.0']);
    expect(d.newFaces).toHaveLength(4);
    expect(d.newVertices).toHaveLength(4);
    expect(d.vertexIds).toHaveLength(12);
    expect(result.document.featureHistory.at(-1)?.params).toMatchObject({ faces: ['f-1.0'] });
    for (const v of e.elementIds.vertices.slice(8)) expect((e.vertices[e.elementIds.vertices.indexOf(v)] as Vec3)[2]).toBe(2);
  });
  it('moves along a given direction, negative distances cut inward, ids work as references', () => {
    const along = run(cube.doc, 'extrude_cage_faces', { id: cube.id, faces: ['f-1.0'], distance: 1, direction: [0, 0, 5] });
    expect(volumeOf(creased(along.document, cube.id), cube.id)).toBeCloseTo(12, 12);
    const inward = run(cube.doc, 'extrude_cage_faces', { id: cube.id, faces: ['f-1.0'], distance: -0.5 });
    expect(volumeOf(creased(inward.document, cube.id), cube.id)).toBeCloseTo(6, 12);
    const tilted = run(cube.doc, 'extrude_cage_faces', { id: cube.id, faces: [0], distance: 1, direction: [1, 0, 1] });
    expect(Math.max(...entityOf(tilted.document, cube.id).vertices.map((p) => p[0]))).toBeCloseTo(1 + Math.SQRT1_2, 12);
  });
  it('extrudes edge-connected faces as one region or each on its own', () => {
    const slab = add({ box: { size: [4, 2, 2], segments: [2, 1, 1] }, levels: 1 });
    const together = run(slab.doc, 'extrude_cage_faces', { id: slab.id, faces: [0, 1], distance: 1 });
    expect(counts(entityOf(together.document, slab.id))).toEqual({ V: 18, E: 32, F: 16, euler: 2 });
    const apart = run(slab.doc, 'extrude_cage_faces', { id: slab.id, faces: [0, 1], distance: 1, individual: true });
    const e = entityOf(apart.document, slab.id);
    expect(e.vertices.length).toBe(12 + 8);
    expect(e.faces.length).toBe(10 + 8);
    expect(counts(e).euler).toBe(2);
    expect(cageProblem(e)).toBeNull();
  });
  it('keeps and copies sharp edges onto the new rim', () => {
    const sharp = run(cube.doc, 'set_cage_crease', { id: cube.id, edges: 'all', sharpness: 3 });
    const result = run(sharp.document, 'extrude_cage_faces', { id: cube.id, faces: [0], distance: 1 });
    const e = entityOf(result.document, cube.id);
    expect(e.edgeSharpness?.every((edge) => edge.s === 3)).toBe(true);
    expect(e.edgeSharpness?.length).toBe(12 + 4);
    const corner = run(cube.doc, 'set_cage_crease', { id: cube.id, vertices: [0], sharpness: 2 });
    const around = run(corner.document, 'extrude_cage_faces', { id: cube.id, faces: [0], distance: 1 });
    expect(entityOf(around.document, cube.id).vertexSharpness).toHaveLength(2);
  });
  it('refuses with stable codes and leaves the document alone', () => {
    const cases: Array<[object, string]> = [
      [{ faces: [0], distance: 0 }, 'DIR_DISTANCE_ZERO'],
      [{ faces: [0], distance: 1, direction: [0, 0, 0] }, 'DIR_DIRECTION_ZERO'],
      [{ faces: ['f-9.9'], distance: 1 }, 'DIR_REF_LOST'],
      [{ faces: [42], distance: 1 }, 'DIR_REF_LOST'],
      [{ faces: ['e:v-1.0|v-1.1'], distance: 1 }, 'DIR_ELEMENT_KIND'],
      [{ faces: ['v-1.0'], distance: 1 }, 'DIR_ELEMENT_KIND'],
      [{ faces: [0, 1, 2, 3, 4, 5], distance: 1 }, 'DIR_REGION_DEGENERATE'],
    ];
    for (const [params, expected] of cases) {
      const result = run(cube.doc, 'extrude_cage_faces', { id: cube.id, ...params });
      expectNoOp(result, cube.doc);
      expect(code(result), result.summary).toBe(expected);
    }
    expect(code(run(cube.doc, 'extrude_cage_faces', { id: 'nope', faces: [0], distance: 1 }))).toBe('DIR_ENTITY_NOT_FOUND');
  });
  it('refuses a result above the cage size cap', () => {
    const big = add({ box: { size: [14, 14, 14], segments: [14, 14, 14] }, levels: 0 });
    const top = big.e.faces.flatMap((face, f) => (face.every((v) => (big.e.vertices[v] as Vec3)[2] === 7) ? [f] : []));
    const bottom = big.e.faces.flatMap((face, f) => (face.every((v) => (big.e.vertices[v] as Vec3)[2] === -7) ? [f] : []));
    const result = run(big.doc, 'extrude_cage_faces', { id: big.id, faces: [...top, ...bottom], distance: 1, individual: true });
    expect(code(result)).toBe('DIR_CAGE_TOO_LARGE');
  });
  it('is pure', () => {
    expectPure(cube.doc, () => run(cube.doc, 'extrude_cage_faces', { id: cube.id, faces: [0], distance: 1 }));
  });
});

describe('inset_cage_faces (VC-DIR-20)', () => {
  const cube = add({ box: { size: [2, 2, 2] }, levels: 2 });
  it('insets the top face by 0.5 and sinks it by 0.5: volume 8 - 7/6', () => {
    const result = run(cube.doc, 'inset_cage_faces', { id: cube.id, faces: [0], thickness: 0.5, depth: -0.5 });
    const e = entityOf(result.document, cube.id);
    expect(counts(e)).toEqual({ V: 12, E: 20, F: 10, euler: 2 });
    expect(volumeOf(creased(result.document, cube.id), cube.id)).toBeCloseTo(8 - 7 / 6, 12);
    expect(data<{ innerFaces: string[] }>(result).innerFaces).toEqual(['f-1.0']);
    const inner = e.elementIds.vertices.slice(8).map((id) => e.vertices[e.elementIds.vertices.indexOf(id)] as Vec3);
    for (const p of inner) {
      expect(Math.abs(p[0])).toBeCloseTo(0.5, 12);
      expect(p[2]).toBeCloseTo(0.5, 12);
    }
    expect(uniqueIds(e)).toBe(true);
  });
  it('even offset keeps the width at corners; plain offset moves the corner by the thickness', () => {
    const even = entityOf(run(cube.doc, 'inset_cage_faces', { id: cube.id, faces: [0], thickness: 0.2 }).document, cube.id);
    const plain = entityOf(
      run(cube.doc, 'inset_cage_faces', { id: cube.id, faces: [0], thickness: 0.2, evenOffset: false }).document,
      cube.id,
    );
    expect((even.vertices[8] as Vec3).map(Math.abs)).toEqual([0.8, 0.8, 1].map((v) => expect.closeTo(v, 12)));
    expect(Math.abs((plain.vertices[8] as Vec3)[0])).toBeCloseTo(1 - 0.2 / Math.SQRT2, 12);
  });
  it('insets region faces together or individually, and lifts with a positive depth', () => {
    const slab = add({ box: { size: [4, 2, 2], segments: [2, 1, 1] }, levels: 1 });
    const together = run(slab.doc, 'inset_cage_faces', { id: slab.id, faces: [0, 1], thickness: 0.2, depth: 0.3 });
    const individual = run(slab.doc, 'inset_cage_faces', { id: slab.id, faces: [0, 1], thickness: 0.2, individual: true });
    expect(entityOf(together.document, slab.id).vertices.length).toBe(12 + 6);
    expect(entityOf(individual.document, slab.id).vertices.length).toBe(12 + 8);
    expect(Math.max(...entityOf(together.document, slab.id).vertices.map((p) => p[2]))).toBeCloseTo(1.3, 12);
    expect(cageProblem(entityOf(together.document, slab.id))).toBeNull();
  });
  it('refuses a thickness that collapses the inner loop and reports the limit', () => {
    const result = run(cube.doc, 'inset_cage_faces', { id: cube.id, faces: [0], thickness: 1.5 });
    expectNoOp(result, cube.doc);
    expect(code(result)).toBe('DIR_INSET_TOO_THICK');
    const limit = Number(/largest valid thickness is ([0-9.]+)/.exec(result.summary)?.[1]);
    expect(limit).toBeCloseTo(1, 4);
  });
  it('refuses bad numbers, references and regions', () => {
    const cases: Array<[object, string]> = [
      [{ faces: [0], thickness: 0 }, 'DIR_INSET_TOO_THICK'],
      [{ faces: ['f-9.9'], thickness: 0.1 }, 'DIR_REF_LOST'],
      [{ faces: [0, 1, 2, 3, 4, 5], thickness: 0.1 }, 'DIR_REGION_DEGENERATE'],
    ];
    for (const [params, expected] of cases) {
      const result = run(cube.doc, 'inset_cage_faces', { id: cube.id, ...params });
      expectNoOp(result, cube.doc);
      expect(code(result), result.summary).toBe(expected);
    }
    expect(code(run(cube.doc, 'inset_cage_faces', { id: 'nope', faces: [0], thickness: 1 }))).toBe('DIR_ENTITY_NOT_FOUND');
  });
  it('is pure', () => {
    expectPure(cube.doc, () => run(cube.doc, 'inset_cage_faces', { id: cube.id, faces: [0], thickness: 0.5 }));
  });
});

describe('loop_cut_cage (VC-DIR-21)', () => {
  const cube = add({ box: { size: [2, 2, 2] }, levels: 2 });
  it('cuts the cube at mid height: V12 E20 F10, volume 8', () => {
    const result = run(cube.doc, 'loop_cut_cage', { id: cube.id, edge: [0, 4] });
    const e = entityOf(result.document, cube.id);
    expect(counts(e)).toEqual({ V: 12, E: 20, F: 10, euler: 2 });
    expect(volumeOf(creased(result.document, cube.id), cube.id)).toBeCloseTo(8, 12);
    expect(e.vertices.slice(8).map((p) => p[2])).toEqual([0, 0, 0, 0]);
    expect(e.elementIds.vertices.slice(0, 8)).toEqual(cube.e.elementIds.vertices);
    expect(uniqueIds(e)).toBe(true);
    expect(cageProblem(e)).toBeNull();
    const d = data<{ newVertices: string[]; newFaces: string[]; stripFaces: string[] }>(result);
    expect(d.newVertices).toHaveLength(4);
    expect(d.newFaces).toHaveLength(4);
    expect(d.stripFaces).toHaveLength(4);
    expect(result.document.featureHistory.at(-1)?.params).toMatchObject({ edge: expect.stringMatching(/^e:v-1\./) });
  });
  it('inserts several loops, honours the factor and the edge direction', () => {
    const three = entityOf(run(cube.doc, 'loop_cut_cage', { id: cube.id, edge: [0, 4], cuts: 3 }).document, cube.id);
    expect(counts(three)).toEqual({ V: 20, E: 36, F: 18, euler: 2 });
    expect(new Set(three.vertices.slice(8).map((p) => p[2]))).toEqual(new Set([0.5, 0, -0.5]));
    const quarter = (edge: [number, number]): number[] =>
      entityOf(run(cube.doc, 'loop_cut_cage', { id: cube.id, edge, factor: 0.25 }).document, cube.id)
        .vertices.slice(8)
        .map((p) => p[2]);
    expect(quarter([0, 4])).toEqual([0.5, 0.5, 0.5, 0.5].map((v) => v));
    expect(quarter([4, 0])).toEqual([-0.5, -0.5, -0.5, -0.5]);
    const byId = run(cube.doc, 'loop_cut_cage', {
      id: cube.id,
      edge: `e:${cube.e.elementIds.vertices[0]}|${cube.e.elementIds.vertices[4]}`,
    });
    expect(entityOf(byId.document, cube.id).vertices.length).toBe(12);
  });
  it('splits sharp rungs into two sharp halves', () => {
    const sharp = run(cube.doc, 'set_cage_crease', { id: cube.id, edges: [[0, 4]], sharpness: 2 });
    const e = entityOf(run(sharp.document, 'loop_cut_cage', { id: cube.id, edge: [0, 4] }).document, cube.id);
    expect(e.edgeSharpness).toHaveLength(2);
    expect(e.edgeSharpness?.every((edge) => edge.s === 2)).toBe(true);
  });
  it('follows the strip through quads around an n-gon prism and refuses to cross an n-gon', () => {
    const drum = add({ cylinder: { radius: 1, height: 2, sides: 5 }, levels: 1 });
    const vertical = run(drum.doc, 'loop_cut_cage', { id: drum.id, edge: [0, 5] });
    expect(entityOf(vertical.document, drum.id).vertices.length).toBe(10 + 5);
    const cap = run(drum.doc, 'loop_cut_cage', { id: drum.id, edge: [0, 1] });
    expect(code(cap)).toBe('DIR_LOOP_NOT_QUAD');
    expectNoOp(cap, drum.doc);
  });
  it('cuts mirror loops of a symmetric cage and breaks no symmetry', () => {
    const slab = add({ box: { size: [4, 2, 2], segments: [2, 1, 1] }, levels: 2 });
    const sym = run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: ['x'] });
    const vertical = slab.e.vertices.findIndex((p) => p[0] === -2 && p[1] === -1 && p[2] === 1);
    const below = slab.e.vertices.findIndex((p) => p[0] === -2 && p[1] === -1 && p[2] === -1);
    const ring = run(sym.document, 'loop_cut_cage', { id: slab.id, edge: [vertical, below] });
    expect(entityOf(ring.document, slab.id).vertices.length).toBe(12 + 6);
    expect(data<{ stripFaces: string[] }>(ring).stripFaces).toHaveLength(6);
    const along = slab.e.vertices.findIndex((p) => p[0] === 0 && p[1] === -1 && p[2] === 1);
    const cut = run(sym.document, 'loop_cut_cage', { id: slab.id, edge: [vertical, along] });
    const e = entityOf(cut.document, slab.id);
    expect(e.vertices.length).toBe(12 + 8);
    expect(e.symmetry?.partners[0]).toHaveLength(20);
    expect(data<{ stripFaces: string[] }>(cut).stripFaces).toHaveLength(8);
    expect(
      data<{ symmetry: { maxDeviation: number } }>(run(cut.document, 'check_subdivision', { id: slab.id })).symmetry.maxDeviation,
    ).toBeLessThan(1e-12);
    const box = add({ box: { size: [2, 2, 2] }, levels: 1 });
    const boxSym = run(box.doc, 'set_cage_symmetry', { id: box.id, planes: ['x'] });
    const left = box.e.vertices.findIndex((p) => p[0] === -1 && p[1] === -1 && p[2] === 1);
    const right = box.e.vertices.findIndex((p) => p[0] === 1 && p[1] === -1 && p[2] === 1);
    const lopsided = run(boxSym.document, 'loop_cut_cage', { id: box.id, edge: [left, right], factor: 0.3 });
    expect(code(lopsided)).toBe('DIR_SYMMETRY_BROKEN');
    expectNoOp(lopsided, boxSym.document);
    const centred = run(boxSym.document, 'loop_cut_cage', { id: box.id, edge: [left, right], factor: 0.5 });
    expect(entityOf(centred.document, box.id).symmetry?.partners[0]).toHaveLength(12);
  });
  it('refuses bad input with stable codes', () => {
    const cases: Array<[object, string]> = [
      [{ edge: [0, 4], cuts: 0 }, 'DIR_LOOP_CUTS_RANGE'],
      [{ edge: [0, 4], cuts: 33 }, 'DIR_LOOP_CUTS_RANGE'],
      [{ edge: [0, 4], factor: 1 }, 'DIR_LOOP_CUTS_RANGE'],
      [{ edge: [0, 4], cuts: 2, factor: 0.5 }, 'DIR_LOOP_CUTS_RANGE'],
      [{ edge: [0, 6] }, 'DIR_REF_LOST'],
      [{ edge: 'f-1.0' }, 'DIR_ELEMENT_KIND'],
    ];
    for (const [params, expected] of cases) {
      const result = run(cube.doc, 'loop_cut_cage', { id: cube.id, ...params });
      expectNoOp(result, cube.doc);
      expect(code(result), result.summary).toBe(expected);
    }
    expect(code(run(cube.doc, 'loop_cut_cage', { id: 'nope', edge: [0, 4] }))).toBe('DIR_ENTITY_NOT_FOUND');
  });
  it('is pure', () => {
    expectPure(cube.doc, () => run(cube.doc, 'loop_cut_cage', { id: cube.id, edge: [0, 4], cuts: 2 }));
  });
});

describe('symmetric topology edits and replay (VC-DIR-16, 30)', () => {
  const grip = add({ box: { size: [40, 20, 10], segments: [4, 2, 1] }, levels: 2 });
  const plan = (distance: number): CadDocument => {
    let doc = run(grip.doc, 'set_cage_symmetry', { id: grip.id, planes: ['x'] }).document;
    const top = data<{ faces: string[] }>(
      run(doc, 'select_cage_elements', { id: grip.id, faces: { normal: [0, 0, 1], within: 0.2 } }),
    ).faces;
    expect(top).toHaveLength(8);
    doc = run(doc, 'extrude_cage_faces', { id: grip.id, faces: top.slice(0, 4), distance }).document;
    doc = run(doc, 'inset_cage_faces', { id: grip.id, faces: top.slice(0, 4), thickness: 1, depth: -1 }).document;
    doc = run(doc, 'loop_cut_cage', { id: grip.id, edge: [0, 15], cuts: 2 }).document;
    return doc;
  };
  it('mirrors the extrusion of half the faces and stays symmetric', () => {
    const doc = plan(8);
    const e = entityOf(doc, grip.id);
    expect(e.symmetry?.planes).toEqual(['x']);
    expect(uniqueIds(e)).toBe(true);
    expect(cageProblem(e)).toBeNull();
    const check = run(doc, 'check_subdivision', { id: grip.id });
    expect(data<{ symmetry: { maxDeviation: number }; euler: number }>(check).symmetry.maxDeviation).toBeLessThan(1e-12);
    expect(data<{ euler: number }>(check).euler).toBe(2);
    expect(doc.featureHistory.map((step) => step.name)).toEqual([
      'add_subdivision_solid',
      'set_cage_symmetry',
      'extrude_cage_faces',
      'inset_cage_faces',
      'loop_cut_cage',
    ]);
  });
  it('keeps targeting the same ids when an earlier step is edited, and reports a lost one', () => {
    const doc = plan(8);
    const extrude = doc.featureHistory.find((step) => step.name === 'extrude_cage_faces');
    const edited = run(doc, 'edit_step_params', { stepId: extrude?.id, params: { ...(extrude?.params as object), distance: 12 } });
    const e = entityOf(edited.document, grip.id);
    expect(Math.max(...e.vertices.map((p) => p[2]))).toBeCloseTo(5 + 12, 9);
    const faces = (extrude?.params as { faces: string[] }).faces;
    const inset = edited.document.featureHistory.find((step) => step.name === 'inset_cage_faces');
    expect((inset?.params as { faces: string[] }).faces).toEqual(faces);
    const dropped = run(doc, 'edit_step_params', { stepId: extrude?.id, params: { ...(extrude?.params as object), faces: ['f-1.9999'] } });
    expect(dropped.summary).toContain('DIR_REF_LOST');
    expect(dropped.document).toBe(doc);
  });
  it('a result that breaks the declared symmetry is refused', () => {
    const sym = run(grip.doc, 'set_cage_symmetry', { id: grip.id, planes: ['x'] }).document;
    const result = run(sym, 'extrude_cage_faces', { id: grip.id, faces: [0], distance: 2, direction: [1, 0, 1] });
    expect(code(result)).toBe('DIR_SYMMETRY_BROKEN');
    expectNoOp(result, sym);
  });
});
