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
const dataOf = <T>(result: ReturnType<typeof execute>): T => result.data as T;
const counts = (e: SubdivisionEntity): { V: number; E: number; F: number; euler: number } => {
  const edges = new Set(
    e.faces.flatMap((face) => face.map((a, i) => [a, face[(i + 1) % face.length] as number].sort((x, y) => x - y).join(':'))),
  );
  return { V: e.vertices.length, E: edges.size, F: e.faces.length, euler: e.vertices.length - edges.size + e.faces.length };
};
const creased = (doc: CadDocument, id: string): CadDocument => run(doc, 'edit_subdivision_cage', { id, crease: true }).document;
const at = (e: SubdivisionEntity, p: Vec3): number => e.vertices.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-9);
const faceAt = (e: SubdivisionEntity, p: Vec3): number =>
  e.faces.findIndex((face) => {
    const c = face.reduce<Vec3>(
      (s, v) => [s[0] + (e.vertices[v] as Vec3)[0], s[1] + (e.vertices[v] as Vec3)[1], s[2] + (e.vertices[v] as Vec3)[2]],
      [0, 0, 0],
    );
    return Math.hypot(c[0] / face.length - p[0], c[1] / face.length - p[1], c[2] / face.length - p[2]) < 1e-9;
  });
const unique = (e: SubdivisionEntity): boolean =>
  new Set(e.elementIds.vertices).size === e.vertices.length && new Set(e.elementIds.faces).size === e.faces.length;
const cube = add({ box: { size: [2, 2, 2] }, levels: 2 });

describe('delete_cage_faces and fill_cage_hole (VC-DIR-35)', () => {
  const deleted = run(cube.doc, 'delete_cage_faces', { id: cube.id, faces: [0] });
  it('deleting the top face opens the cage: 1 boundary loop, Euler 1, ids kept, no volume', () => {
    const e = entityOf(deleted.document, cube.id);
    expect(counts(e)).toEqual({ V: 8, E: 12, F: 5, euler: 1 });
    expect(e.boundary).toBe('edge_and_corner');
    expect(cageProblem(e)).toBeNull();
    expect(e.elementIds.faces).toEqual(cube.e.elementIds.faces.slice(1));
    const data = dataOf<{ boundaryLoops: string[][]; removedFaces: string[] }>(deleted);
    expect(data.boundaryLoops).toHaveLength(1);
    expect(data.boundaryLoops[0]).toHaveLength(4);
    expect(data.removedFaces).toEqual(['f-1.0']);
    const check = dataOf<{ open: boolean; boundaryLoops: unknown[]; genus: number; meshVolume: unknown }>(
      run(deleted.document, 'check_subdivision', { id: cube.id }),
    );
    expect(check).toMatchObject({ open: true, genus: 0, meshVolume: null });
    expect(check.boundaryLoops).toHaveLength(1);
    expect(run(deleted.document, 'mass_properties', { entityId: cube.id }).summary).toContain('no solid volume');
  });
  it('fills the hole as an n-gon: closed again, Euler 2, creased volume 8', () => {
    const edge = dataOf<{ boundaryLoops: string[][] }>(deleted).boundaryLoops[0] as string[];
    const filled = run(deleted.document, 'fill_cage_hole', { id: cube.id, edge: `e:${[edge[0], edge[1]].sort().join('|')}` });
    const e = entityOf(filled.document, cube.id);
    expect(counts(e)).toEqual({ V: 8, E: 12, F: 6, euler: 2 });
    expect(e.boundary).toBeUndefined();
    expect(volumeOf(creased(filled.document, cube.id), cube.id)).toBeCloseTo(8, 12);
    expect(dataOf<{ loopSize: number }>(filled).loopSize).toBe(4);
  });
  it('fills with quads around a centre vertex', () => {
    const big = add({ box: { size: [2, 2, 2], segments: [2, 2, 1] }, levels: 1 });
    const top = [0, 1, 2, 3].map((f) => big.e.elementIds.faces[f] as string);
    const open = run(big.doc, 'delete_cage_faces', { id: big.id, faces: top, boundary: 'edge_only' });
    expect(entityOf(open.document, big.id).boundary).toBe('edge_only');
    const loop = dataOf<{ boundaryLoops: string[][] }>(open).boundaryLoops[0] as string[];
    expect(loop).toHaveLength(8);
    const filled = run(open.document, 'fill_cage_hole', {
      id: big.id,
      edge: [at(entityOf(open.document, big.id), [-1, -1, 1]), at(entityOf(open.document, big.id), [0, -1, 1])],
      mode: 'quads',
    });
    const e = entityOf(filled.document, big.id);
    expect(e.faces).toHaveLength(entityOf(open.document, big.id).faces.length + 4);
    expect(e.vertices).toHaveLength(entityOf(open.document, big.id).vertices.length + 1);
    expect(e.boundary).toBeUndefined();
  });
  it('is pure and refuses bad input with stable codes', () => {
    expectPure(cube.doc, () => run(cube.doc, 'delete_cage_faces', { id: cube.id, faces: [0] }));
    expectPure(deleted.document, () => run(deleted.document, 'fill_cage_hole', { id: cube.id, edge: [0, 1] }));
    const all = run(cube.doc, 'delete_cage_faces', { id: cube.id, faces: [0, 1, 2, 3, 4, 5] });
    expect(code(all)).toBe('DIR_CAGE_EMPTY');
    expectNoOp(all, cube.doc);
    expect(code(run(cube.doc, 'delete_cage_faces', { id: cube.id, faces: ['f-9.9'] }))).toBe('DIR_REF_LOST');
    expect(code(run(cube.doc, 'delete_cage_faces', { id: 'nope', faces: [0] }))).toBe('DIR_ENTITY_NOT_FOUND');
    const pinch = run(cube.doc, 'delete_cage_faces', { id: cube.id, faces: [0, 3] });
    expect(entityOf(pinch.document, cube.id).faces.length === 6 ? code(pinch) : undefined).toBeUndefined();
    expect(code(run(cube.doc, 'fill_cage_hole', { id: cube.id, edge: [0, 1] }))).toBe('DIR_NOT_BOUNDARY');
    const odd = add({ box: { size: [2, 2, 2] } });
    const tri = run(odd.doc, 'delete_cage_faces', { id: odd.id, faces: [0] });
    const wrong = run(tri.document, 'fill_cage_hole', { id: odd.id, edge: 'e:v-3.0|v-3.1' });
    expect(['DIR_REF_LOST', 'DIR_NOT_BOUNDARY']).toContain(code(wrong));
  });
});

describe('bevel_cage_edges (VC-DIR-34)', () => {
  const edge: [number, number] = [at(cube.e, [1, -1, 1]), at(cube.e, [-1, -1, 1])];
  it('bevels the top-front edge: V10 E15 F7, creased volume 7.75', () => {
    const result = run(cube.doc, 'bevel_cage_edges', { id: cube.id, edges: [edge], width: 0.25 });
    const e = entityOf(result.document, cube.id);
    expect(counts(e)).toEqual({ V: 10, E: 15, F: 7, euler: 2 });
    expect(cageProblem(e)).toBeNull();
    expect(unique(e)).toBe(true);
    expect(volumeOf(creased(result.document, cube.id), cube.id)).toBeCloseTo(7.75, 12);
    expect(dataOf<{ newVertices: string[]; newFaces: string[] }>(result)).toMatchObject({ newVertices: expect.arrayContaining([]) });
    expect(result.document.featureHistory.at(-1)?.params).toMatchObject({ edges: [expect.stringMatching(/^e:/)] });
  });
  it('segments add quads, sharp marks the long edges', () => {
    const result = run(cube.doc, 'bevel_cage_edges', { id: cube.id, edges: [edge], width: 0.25, segments: 3, sharp: 10 });
    const e = entityOf(result.document, cube.id);
    expect(counts(e)).toEqual({ V: 14, E: 21, F: 9, euler: 2 });
    expect(e.creases).toHaveLength(2);
  });
  it('bevels several independent edges, including the mirror edge of a symmetric cage', () => {
    const sym = run(cube.doc, 'set_cage_symmetry', { id: cube.id, planes: ['x'] });
    const result = run(sym.document, 'bevel_cage_edges', {
      id: cube.id,
      edges: [[at(cube.e, [1, -1, 1]), at(cube.e, [1, 1, 1])]],
      width: 0.25,
    });
    expect(counts(entityOf(result.document, cube.id))).toEqual({ V: 12, E: 18, F: 8, euler: 2 });
    expect(entityOf(result.document, cube.id).symmetry).toBeDefined();
  });
  it('is pure and refuses with stable codes', () => {
    expectPure(cube.doc, () => run(cube.doc, 'bevel_cage_edges', { id: cube.id, edges: [edge], width: 0.25 }));
    expect(code(run(cube.doc, 'bevel_cage_edges', { id: cube.id, edges: [edge], width: 0.5 }))).toBe('DIR_BEVEL_TOO_WIDE');
    expect(code(run(cube.doc, 'bevel_cage_edges', { id: cube.id, edges: [edge], width: 0 }))).toBe('DIR_BEVEL_WIDTH_RANGE');
    expect(code(run(cube.doc, 'bevel_cage_edges', { id: cube.id, edges: [edge], width: 0.2, segments: 99 }))).toBe('DIR_BEVEL_WIDTH_RANGE');
    expect(code(run(cube.doc, 'bevel_cage_edges', { id: cube.id, edges: [edge], width: 0.2, sharp: 11 }))).toBe('DIR_SHARPNESS_RANGE');
    const touching = run(cube.doc, 'bevel_cage_edges', { id: cube.id, edges: [edge, [edge[1], at(cube.e, [-1, 1, 1])]], width: 0.2 });
    expect(code(touching)).toBe('DIR_BEVEL_ADJACENT');
    expectNoOp(touching, cube.doc);
    expect(code(run(cube.doc, 'bevel_cage_edges', { id: cube.id, edges: [[0, 7]], width: 0.2 }))).toBe('DIR_REF_LOST');
    const open = run(cube.doc, 'delete_cage_faces', { id: cube.id, faces: [0] });
    const rim = run(open.document, 'bevel_cage_edges', { id: cube.id, edges: [edge], width: 0.2 });
    expect(code(rim)).toBe('DIR_BEVEL_BOUNDARY');
  });
});

describe('bridge_cage_faces (VC-DIR-22)', () => {
  const box = add({ box: { size: [3, 3, 1], segments: [3, 3, 1] }, levels: 2 });
  const top = faceAt(box.e, [0, 0, 0.5]);
  const bottom = faceAt(box.e, [0, 0, -0.5]);
  it('bridges the centre faces of the 3x3x1 box: Euler 0, genus 1, creased volume 8', () => {
    const result = run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [top], facesB: [bottom] });
    const e = entityOf(result.document, box.id);
    expect(counts(e)).toEqual({ V: 32, E: 64, F: 32, euler: 0 });
    expect(cageProblem(e)).toBeNull();
    expect(unique(e)).toBe(true);
    const check = dataOf<{ genus: number; euler: number }>(run(result.document, 'check_subdivision', { id: box.id }));
    expect(check).toMatchObject({ genus: 1, euler: 0 });
    expect(volumeOf(creased(result.document, box.id), box.id)).toBeCloseTo(8, 12);
    expect(dataOf<{ loopSize: number }>(result).loopSize).toBe(4);
    expect(result.document.featureHistory.at(-1)?.params).toMatchObject({ facesA: [box.e.elementIds.faces[top]] });
  });
  it('segments add layers, twist rotates the pairing', () => {
    const layered = run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [top], facesB: [bottom], segments: 3 });
    expect(counts(entityOf(layered.document, box.id))).toMatchObject({ euler: 0 });
    expect(entityOf(layered.document, box.id).faces.length).toBe(counts(entityOf(box.doc, box.id)).F - 2 + 12);
    const a = run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [top], facesB: [bottom] });
    const b = run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [top], facesB: [bottom], twist: 1 });
    expect(entityOf(b.document, box.id).faces).not.toEqual(entityOf(a.document, box.id).faces);
    expect(cageProblem(entityOf(b.document, box.id))).toBeNull();
  });
  it('bridges two holes of an open cage and merges a second solid', () => {
    const holed = run(box.doc, 'delete_cage_faces', { id: box.id, faces: [top, bottom] });
    const loops = dataOf<{ boundaryLoops: string[][] }>(holed).boundaryLoops;
    expect(loops).toHaveLength(2);
    const pair = (loop: string[]): string => `e:${[loop[0], loop[1]].sort().join('|')}`;
    const joined = run(holed.document, 'bridge_cage_faces', {
      id: box.id,
      loopA: pair(loops[0] as string[]),
      loopB: pair(loops[1] as string[]),
    });
    expect(counts(entityOf(joined.document, box.id))).toEqual({ V: 32, E: 64, F: 32, euler: 0 });
    expect(entityOf(joined.document, box.id).boundary).toBeUndefined();
    const second = add({ box: { size: [3, 3, 1], segments: [3, 3, 1] }, id: 'other', position: [0, 0, 4] }, box.doc);
    const merged = run(second.doc, 'bridge_cage_faces', {
      id: box.id,
      facesA: [top],
      otherId: 'other',
      facesB: [faceAt(second.e, [0, 0, -0.5])],
    });
    expect(merged.document.entities['other']).toBeUndefined();
    const e = entityOf(merged.document, box.id);
    expect(e.vertices).toHaveLength(box.e.vertices.length * 2);
    expect(cageProblem(e)).toBeNull();
    expect(unique(e)).toBe(true);
    expect(dataOf<{ merged: string }>(merged).merged).toBe('other');
  });
  it('is pure and refuses with stable codes', () => {
    expectPure(box.doc, () => run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [top], facesB: [bottom] }));
    const mismatch = run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [top], facesB: [0, 1] });
    expect(code(mismatch)).toBe('DIR_BRIDGE_COUNT_MISMATCH');
    expectNoOp(mismatch, box.doc);
    expect(code(run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [top] }))).toBe('DIR_SELECTOR_INVALID');
    expect(code(run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [top], facesB: [bottom], segments: 99 }))).toBe(
      'DIR_SELECTOR_INVALID',
    );
    expect(code(run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [top], facesB: [top] }))).toBe('DIR_BRIDGE_SAME');
    expect(code(run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [0, 5], facesB: [bottom] }))).toBe('DIR_BRIDGE_REGION');
    expect(code(run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [top], facesB: [bottom], otherId: 'nope' }))).toBe(
      'DIR_ENTITY_NOT_FOUND',
    );
    expect(code(run(box.doc, 'bridge_cage_faces', { id: box.id, facesA: [top], facesB: [bottom], otherId: box.id }))).toBe(
      'DIR_ENTITY_NOT_FOUND',
    );
    expect(code(run(box.doc, 'bridge_cage_faces', { id: box.id, loopA: [0, 1], facesB: [bottom] }))).toBe('DIR_NOT_BOUNDARY');
  });
});

describe('weld_cage_vertices and slide_cage_edges (VC-DIR-33)', () => {
  it('collapses an edge by welding its ends: V7 F6', () => {
    const a = at(cube.e, [1, -1, 1]);
    const b = at(cube.e, [-1, -1, 1]);
    const result = run(cube.doc, 'weld_cage_vertices', { id: cube.id, vertices: [a, b], toCentre: true });
    const e = entityOf(result.document, cube.id);
    expect(counts(e)).toEqual({ V: 7, E: 11, F: 6, euler: 2 });
    expect(e.vertices.some((p) => p[0] === 0 && p[1] === -1 && p[2] === 1)).toBe(true);
    expect(cageProblem(e)).toBeNull();
    expect(dataOf<{ welded: string[][] }>(result).welded).toHaveLength(1);
  });
  it('welds near vertices of an open cage back into a closed one (tolerance clusters)', () => {
    const open = run(cube.doc, 'delete_cage_faces', { id: cube.id, faces: [0] });
    const welded = run(open.document, 'weld_cage_vertices', { id: cube.id, vertices: [0, 1, 2, 3], tolerance: 2.5 });
    expect(entityOf(welded.document, cube.id).vertices.length).toBeLessThan(8);
  });
  it('refuses a non-manifold weld and bad input', () => {
    const opposite = run(cube.doc, 'weld_cage_vertices', { id: cube.id, vertices: [at(cube.e, [1, 1, 1]), at(cube.e, [-1, -1, -1])] });
    expect(code(opposite)).toBe('DIR_WELD_NONMANIFOLD');
    expectNoOp(opposite, cube.doc);
    expect(code(run(cube.doc, 'weld_cage_vertices', { id: cube.id, vertices: [0, 0] }))).toBe('DIR_NOTHING_TO_DO');
    expect(code(run(cube.doc, 'weld_cage_vertices', { id: cube.id, vertices: [0, 1], tolerance: 0.1 }))).toBe('DIR_NOTHING_TO_DO');
    expect(code(run(cube.doc, 'weld_cage_vertices', { id: cube.id, vertices: [0, 99] }))).toBe('DIR_REF_LOST');
    expectPure(cube.doc, () => run(cube.doc, 'weld_cage_vertices', { id: cube.id, vertices: [0, 1] }));
  });
  it('welds the mirror cluster of a symmetric cage too', () => {
    const sym = run(cube.doc, 'set_cage_symmetry', { id: cube.id, planes: ['x'] });
    const result = run(sym.document, 'weld_cage_vertices', { id: cube.id, vertices: [at(cube.e, [1, -1, 1]), at(cube.e, [1, 1, 1])] });
    expect(dataOf<{ welded: string[][] }>(result).welded).toHaveLength(2);
    expect(entityOf(result.document, cube.id).symmetry).toBeDefined();
  });
  const cut = run(cube.doc, 'loop_cut_cage', { id: cube.id, edge: [at(cube.e, [1, -1, 1]), at(cube.e, [1, -1, -1])] });
  const mid = entityOf(cut.document, cube.id);
  const midEdge: [number, number] = [at(mid, [1, -1, 0]), at(mid, [-1, -1, 0])];
  it('slides the mid loop by 0.5: the loop moves, the volume stays 8', () => {
    const slid = run(cut.document, 'slide_cage_edges', { id: cube.id, edges: { loopFrom: midEdge }, factor: 0.5 });
    const e = entityOf(slid.document, cube.id);
    const zs = e.vertices.filter((p) => Math.abs(p[2]) !== 1).map((p) => p[2]);
    expect(zs).toHaveLength(4);
    expect(new Set(zs.map((z) => Math.abs(z))).size).toBe(1);
    expect(Math.abs(zs[0] as number)).toBeCloseTo(0.5, 12);
    expect(volumeOf(creased(slid.document, cube.id), cube.id)).toBeCloseTo(8, 12);
    const back = run(cut.document, 'slide_cage_edges', { id: cube.id, edges: { loopFrom: midEdge }, factor: -0.5 });
    expect(
      entityOf(back.document, cube.id)
        .vertices.filter((p) => Math.abs(p[2]) !== 1)
        .map((p) => p[2])[0],
    ).toBeCloseTo(-zs[0]!, 12);
    expect(counts(e)).toEqual(counts(mid));
  });
  it('slides by id on a symmetric cage and stays symmetric; refuses bad factors and open loops', () => {
    const sym = run(cut.document, 'set_cage_symmetry', { id: cube.id, planes: ['x', 'y'] });
    const slid = run(sym.document, 'slide_cage_edges', { id: cube.id, edges: [[midEdge[0], midEdge[1]]], factor: 0.25 });
    expect(slid.affected).toEqual([cube.id]);
    expect(dataOf<{ slid: string[] }>(slid).slid).toHaveLength(4);
    expectPure(cut.document, () => run(cut.document, 'slide_cage_edges', { id: cube.id, edges: { loopFrom: midEdge }, factor: 0.5 }));
    for (const factor of [0, 1.5, -2])
      expect(code(run(cut.document, 'slide_cage_edges', { id: cube.id, edges: { loopFrom: midEdge }, factor }))).toBe('DIR_SLIDE_RANGE');
    const open = run(cut.document, 'delete_cage_faces', { id: cube.id, faces: [faceAt(mid, [0, -1, 0.5])] });
    const edge = [at(entityOf(open.document, cube.id), [1, -1, 0]), at(entityOf(open.document, cube.id), [1, -1, 1])] as [number, number];
    const refused = run(open.document, 'slide_cage_edges', { id: cube.id, edges: { loopFrom: edge }, factor: 0.5 });
    expect(['DIR_SLIDE_LOOP_INVALID', 'DIR_REF_LOST']).toContain(code(refused));
  });
});
