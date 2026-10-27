import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type CadDocument, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { GeometryKernel } from '@core/geometry/kernel';
import { boxCage } from '@core/geometry/subdivision';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { volumeOf } from '../../helpers/fixtureDocument';

const empty = createEmptyDocument();
const run = (doc: CadDocument, name: string, params: object, ctx?: Parameters<typeof execute>[3]): ReturnType<typeof execute> =>
  execute(doc, name, params as Record<string, unknown>, ctx);
const entityOf = (doc: CadDocument, id: string): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;
const add = (params: object, doc: CadDocument = empty): { doc: CadDocument; id: string; e: SubdivisionEntity } => {
  const result = run(doc, 'add_subdivision_solid', params);
  expect(result.affected, result.summary).toHaveLength(1);
  const id = result.affected[0] as string;
  return { doc: result.document, id, e: entityOf(result.document, id) };
};
const dataOf = <T>(result: ReturnType<typeof execute>): T => result.data as T;
const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
const near = (actual: readonly number[], expected: readonly number[], digits = 6): void =>
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, digits));

describe('add_subdivision_solid v2', () => {
  it('mints stable element ids from the creating step and reports them', () => {
    const { e, doc } = add({ box: { size: [2, 2, 2] }, levels: 2 });
    expect(e.elementIds.vertices).toEqual(Array.from({ length: 8 }, (_, i) => `v-1.${i}`));
    expect(e.elementIds.faces).toEqual(Array.from({ length: 6 }, (_, i) => `f-1.${i}`));
    const second = add({ box: { size: [1, 1, 1] } }, doc);
    expect(second.e.elementIds.vertices[0]).toBe('v-2.0');
    const data = dataOf<{ vertexIds: string[]; faceIds: string[] }>(run(empty, 'add_subdivision_solid', { box: { size: [1, 1, 1] } }));
    expect(data.vertexIds).toHaveLength(8);
    expect(data.faceIds).toHaveLength(6);
  });
  it('stores semi-sharp edges, corners and the crease method; infinite sharpness goes to creases', () => {
    const { e } = add({
      box: { size: [2, 2, 2] },
      edgeSharpness: [
        { a: 0, b: 1, s: 2 },
        { a: 1, b: 2, s: 10 },
      ],
      vertexSharpness: [{ v: 3, s: 1.5 }],
      creaseMethod: 'chaikin',
    });
    expect(e.edgeSharpness).toEqual([{ a: 0, b: 1, s: 2 }]);
    expect(e.creases).toEqual([[1, 2]]);
    expect(e.vertexSharpness).toEqual([{ v: 3, s: 1.5 }]);
    expect(e.creaseMethod).toBe('chaikin');
  });
  it('refuses with stable codes', () => {
    const box = boxCage([1, 1, 1], [1, 1, 1]);
    const open = { vertices: box.vertices, faces: box.faces.slice(1) };
    const huge = boxCage([1, 1, 1], [100, 100, 100]);
    const dense = boxCage([1, 1, 1], [40, 40, 40]); // 9602 vertices pass the vertex cap, 9600 faces x 4^4 refined quads do not
    const cases: Array<[object, string]> = [
      [{ box: { size: [1, 1, 1] }, edgeSharpness: [{ a: 0, b: 1, s: 12 }] }, 'DIR_SHARPNESS_RANGE'],
      [{ box: { size: [1, 1, 1] }, vertexSharpness: [{ v: 0, s: 0 }] }, 'DIR_SHARPNESS_RANGE'],
      [open, 'DIR_CAGE_OPEN'],
      [{ box: { size: [1, 1, 1] }, levels: 5 }, 'DIR_LEVELS_RANGE'],
      [{ vertices: huge.vertices, faces: huge.faces }, 'DIR_CAGE_TOO_LARGE'],
      [{ vertices: dense.vertices, faces: dense.faces, levels: 4 }, 'DIR_CAGE_TOO_LARGE'],
    ];
    for (const [params, expected] of cases) {
      const result = run(empty, 'add_subdivision_solid', params);
      expectNoOp(result, empty);
      expect(code(result), result.summary).toBe(expected);
    }
  });
});

describe('edit_subdivision_cage v2', () => {
  const pad = add({ box: { size: [2, 2, 2], segments: [2, 2, 2] }, levels: 3, position: [5, 0, 0] });
  const cases = JSON.parse(
    readFileSync(new URL('../../../docs/design/04-direct-freeform-editing/validation/data/cage_edit_cases.json', import.meta.url), 'utf8'),
  ) as { topVertexIndex: number; verticesAfter: number[][]; meshVolumeLevel3Before: number; meshVolumeLevel3After: number };

  it('reproduces the reference soft edit (VC-DIR-06)', () => {
    expect(volumeOf(pad.doc, pad.id)).toBeCloseTo(cases.meshVolumeLevel3Before, 8);
    const result = run(pad.doc, 'edit_subdivision_cage', {
      id: pad.id,
      vertexIndices: [cases.topVertexIndex],
      falloff: 1.5,
      translate: [0, 0, 0.5],
    });
    const world = dataOf<{ vertices: number[][] }>(result).vertices;
    cases.verticesAfter.forEach((p, v) => near(world[v] as number[], [p[0]! + 5, p[1]!, p[2]!]));
    expect(volumeOf(result.document, pad.id) / cases.meshVolumeLevel3After).toBeCloseTo(1, 9);
  });
  it('records ids for index references so a replay is order independent', () => {
    const result = run(pad.doc, 'edit_subdivision_cage', { id: pad.id, vertexIndices: [2], faces: [0], translate: [0, 0, 0.1] });
    const step = result.document.featureHistory.at(-1);
    const params = step?.params as { vertices: string[]; faces: string[]; vertexIndices?: unknown };
    expect(params.vertices).toEqual(['v-1.2']);
    expect(params.faces).toEqual(['f-1.0']);
    expect(params.vertexIndices).toBeUndefined();
    const byId = run(pad.doc, 'edit_subdivision_cage', { id: pad.id, vertices: ['v-1.2'], faces: ['f-1.0'], translate: [0, 0, 0.1] });
    expect(entityOf(byId.document, pad.id).vertices).toEqual(entityOf(result.document, pad.id).vertices);
  });
  it('selects by edges and faces', () => {
    const edge = run(pad.doc, 'edit_subdivision_cage', { id: pad.id, edges: [[0, 1]], translate: [0, 0, 1] });
    expect(dataOf<{ selected: number[] }>(edge).selected).toEqual([0, 1]);
    const face = run(pad.doc, 'edit_subdivision_cage', { id: pad.id, faces: ['f-1.0'], translate: [0, 0, 1] });
    expect(dataOf<{ selected: number[] }>(face).selected).toHaveLength(4);
    expect(dataOf<{ selectedIds: string[] }>(face).selectedIds[0]).toMatch(/^v-1\./);
  });
  it('rotates about a world axis through the pivot, with soft weights scaling the angle', () => {
    const quarter = run(pad.doc, 'edit_subdivision_cage', {
      id: pad.id,
      region: { min: [4, -2, 0.5], max: [6, 2, 2] },
      rotate: { axis: [0, 0, 1], angleDeg: 90, pivot: [5, 0, 0] },
    });
    const before = entityOf(pad.doc, pad.id);
    const after = entityOf(quarter.document, pad.id);
    const top = before.vertices.flatMap((p, v) => (p[2] === 1 ? [v] : []));
    for (const v of top) {
      const [p, q] = [before.vertices[v] as Vec3, after.vertices[v] as Vec3];
      near(q, [-p[1], p[0], p[2]], 9);
    }
    const bottom = before.vertices.findIndex((p) => p[2] === -1);
    expect(after.vertices[bottom]).toEqual(before.vertices[bottom]);
    const soft = run(pad.doc, 'edit_subdivision_cage', {
      id: pad.id,
      vertexIndices: [2],
      falloff: { radius: 1.5, shape: 'linear' },
      rotate: { axis: [0, 0, 1], angleDeg: 90 },
    });
    expect(soft.affected).toEqual([pad.id]);
  });
  it('scales then translates about the pivot and honours the entity frame', () => {
    const turned = add({ box: { size: [2, 2, 2] }, rotation: [0, 0, Math.PI / 2], position: [5, 0, 0] });
    const moved = run(turned.doc, 'edit_subdivision_cage', { id: turned.id, translate: [1, 0, 0], scale: [2, 1, 1], pivot: [5, 0, 0] });
    const xs = dataOf<{ vertices: number[][] }>(moved).vertices.map((p) => p[0] as number);
    expect(Math.min(...xs)).toBeCloseTo(5);
    expect(Math.max(...xs)).toBeCloseTo(7);
  });
  it('measures the soft-selection distance along cage edges when asked (topological)', () => {
    const cube = add({ box: { size: [2, 2, 2] }, levels: 1 });
    const common = { id: cube.id, vertexIndices: [0], translate: [0, 0, -1] as Vec3 };
    const euclid = run(cube.doc, 'edit_subdivision_cage', { ...common, falloff: { radius: 3, metric: 'euclidean' } });
    const topo = run(cube.doc, 'edit_subdivision_cage', { ...common, falloff: { radius: 3, metric: 'topological' } });
    const far = cube.e.vertices.findIndex((p) => p[0] === 1 && p[1] === 1 && p[2] === 1);
    const moved = (r: ReturnType<typeof execute>): number => (entityOf(r.document, cube.id).vertices[far] as Vec3)[2] - 1;
    expect(moved(euclid)).toBeLessThan(0);
    expect(moved(topo)).toBe(0);
    const constant = run(cube.doc, 'edit_subdivision_cage', { ...common, falloff: { radius: 2.5, shape: 'constant' } });
    expect(dataOf<{ selected: number[] }>(constant).selected).toEqual([0]);
    expect(constant.summary).toMatch(/by falloff/);
  });
  it('keeps a symmetric cage symmetric and projects on-plane vertices back (VC-DIR-11)', () => {
    const slab = add({ box: { size: [2, 2, 2], segments: [2, 1, 1] }, levels: 2 });
    const sym = run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: ['x'] });
    const dragged = slab.e.vertices.findIndex((p) => p[0] === 1 && p[1] === -1 && p[2] === 1);
    const mirror = slab.e.vertices.findIndex((p) => p[0] === -1 && p[1] === -1 && p[2] === 1);
    const edit = run(sym.document, 'edit_subdivision_cage', { id: slab.id, vertexIndices: [dragged], translate: [0.3, 0.2, 0.4] });
    const after = entityOf(edit.document, slab.id).vertices;
    near(sub(after[dragged] as Vec3, slab.e.vertices[dragged] as Vec3), [0.3, 0.2, 0.4], 9);
    near(sub(after[mirror] as Vec3, slab.e.vertices[mirror] as Vec3), [-0.3, 0.2, 0.4], 9);
    const check = run(edit.document, 'check_subdivision', { id: slab.id });
    expect(dataOf<{ symmetry: { maxDeviation: number } }>(check).symmetry.maxDeviation).toBeLessThan(1e-12);
    const onPlane = slab.e.vertices.findIndex((p) => p[0] === 0);
    const pushed = run(sym.document, 'edit_subdivision_cage', { id: slab.id, vertexIndices: [onPlane], translate: [0.5, 0, 0.2] });
    expect((entityOf(pushed.document, slab.id).vertices[onPlane] as Vec3)[0]).toBe(0);
    const ignored = run(sym.document, 'edit_subdivision_cage', {
      id: slab.id,
      vertexIndices: [dragged],
      translate: [0.3, 0, 0],
      symmetry: 'ignore',
    });
    expect(entityOf(ignored.document, slab.id).vertices[mirror]).toEqual(slab.e.vertices[mirror]);
  });
  it('creases the mirror edges too and rewrites creases', () => {
    const slab = add({ box: { size: [2, 2, 2], segments: [2, 1, 1] } });
    const sym = run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: ['x'] });
    const left = slab.e.vertices.flatMap((p, v) => (p[0] === -1 ? [v] : []));
    const creased = run(sym.document, 'edit_subdivision_cage', { id: slab.id, vertexIndices: left, crease: true });
    expect(entityOf(creased.document, slab.id).creases.length).toBeGreaterThan(4);
    const smooth = run(creased.document, 'edit_subdivision_cage', { id: slab.id, crease: false });
    expect(entityOf(smooth.document, slab.id).creases).toHaveLength(0);
  });
  it.each([
    [{ id: 'nope', levels: 1 }, 'DIR_ENTITY_NOT_FOUND', "entity 'nope' not found"],
    [{}, 'DIR_NOTHING_TO_DO', 'give at least one of'],
    [{ vertexIndices: [0], region: { min: [0, 0, 0], max: [1, 1, 1] }, levels: 1 }, 'DIR_SELECTION_CONFLICT', 'not both'],
    [{ vertexIndices: [99], translate: [0, 0, 1] }, 'DIR_REF_LOST', 'outside 0..'],
    [{ vertices: ['v-9.9'], translate: [0, 0, 1] }, 'DIR_REF_LOST', 'does not exist'],
    [{ vertices: ['f-1.0'], translate: [0, 0, 1] }, 'DIR_ELEMENT_KIND', 'not a vertex'],
    [{ faces: ['v-1.0'], translate: [0, 0, 1] }, 'DIR_ELEMENT_KIND', 'not a face'],
    [{ edges: ['v-1.0'], translate: [0, 0, 1] }, 'DIR_ELEMENT_KIND', 'not a edge'],
    [{ edges: [[0, 6]], translate: [0, 0, 1] }, 'DIR_REF_LOST', 'does not exist'],
    [{ falloff: -1, translate: [0, 0, 1] }, 'DIR_FALLOFF_INVALID', 'falloff must be >= 0'],
    [{ scale: [1, 0, 1] }, 'DIR_SCALE_NONPOSITIVE', 'scale factors must be > 0'],
    [{ rotate: { axis: [0, 0, 0], angleDeg: 5 } }, 'DIR_NOTHING_TO_DO', 'non-zero'],
    [{ levels: 7 }, 'DIR_LEVELS_RANGE', 'levels must be an integer'],
    [{ region: { min: [50, 50, 50], max: [60, 60, 60] }, translate: [0, 0, 1] }, 'DIR_SELECTION_EMPTY', 'selection is empty'],
  ])('rejects bad edits (%#)', (params, expected, text) => {
    const cube = add({ box: { size: [2, 2, 2] } });
    const result = run(cube.doc, 'edit_subdivision_cage', { id: cube.id, ...params });
    expectNoOp(result, cube.doc, text);
    expect(code(result)).toBe(expected);
  });
  it('is pure and refuses non-subdivision entities', () => {
    expectPure(pad.doc, () =>
      run(pad.doc, 'edit_subdivision_cage', { id: pad.id, translate: [1, 1, 1], crease: true, rotate: { axis: [1, 0, 0], angleDeg: 3 } }),
    );
    const withBox = run(pad.doc, 'add_box', { size: [1, 1, 1] });
    expectNoOp(
      run(withBox.document, 'edit_subdivision_cage', { id: withBox.affected[0], levels: 1 }),
      withBox.document,
      "expected 'subdivision'",
    );
  });
});

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

describe('set_cage_crease', () => {
  const cube = add({ box: { size: [2, 2, 2] }, levels: 4 });
  it.each([
    [1, 6.31819142235],
    [2, 7.56419867056],
    [0.5, 4.23357576242],
  ])('sets every edge to %s (VC-DIR-07)', (sharpness, volume) => {
    const result = run(cube.doc, 'set_cage_crease', { id: cube.id, edges: 'all', sharpness });
    expect(volumeOf(result.document, cube.id) / volume).toBeCloseTo(1, 9);
    expect(dataOf<{ edges: string[] }>(result).edges).toHaveLength(12);
  });
  it('stores 10 as an infinite crease, 0 removes, loops and corners work', () => {
    const slab = add({ box: { size: [4, 2, 2], segments: [2, 1, 1] } });
    const infinite = run(slab.doc, 'set_cage_crease', { id: slab.id, edges: 'all', sharpness: 10 });
    expect(entityOf(infinite.document, slab.id).creases).toHaveLength(20);
    expect(entityOf(infinite.document, slab.id).edgeSharpness).toBeUndefined();
    const cleared = run(infinite.document, 'set_cage_crease', { id: slab.id, edges: 'all', sharpness: 0 });
    expect(entityOf(cleared.document, slab.id).creases).toHaveLength(0);
    const loop = run(slab.doc, 'set_cage_crease', { id: slab.id, edges: { loopFrom: [0, 1] }, sharpness: 3, method: 'chaikin' });
    const stored = entityOf(loop.document, slab.id);
    expect(stored.edgeSharpness?.length).toBe(dataOf<{ edges: string[] }>(loop).edges.length);
    expect(stored.creaseMethod).toBe('chaikin');
    expect(loop.document.featureHistory.at(-1)?.params).toMatchObject({ edges: { loopFrom: expect.stringMatching(/^e:v-1\./) } });
    const corner = run(slab.doc, 'set_cage_crease', { id: slab.id, vertices: [0, 'v-1.1'], sharpness: 2 });
    expect(entityOf(corner.document, slab.id).vertexSharpness).toEqual([
      { v: 0, s: 2 },
      { v: 1, s: 2 },
    ]);
    const off = run(corner.document, 'set_cage_crease', { id: slab.id, vertices: [0], sharpness: 0 });
    expect(entityOf(off.document, slab.id).vertexSharpness).toEqual([{ v: 1, s: 2 }]);
    const listed = run(slab.doc, 'set_cage_crease', { id: slab.id, edges: [[0, 1], 'e:v-1.1|v-1.2'], sharpness: 1 });
    expect(entityOf(listed.document, slab.id).edgeSharpness).toHaveLength(2);
  });
  it('mirrors onto the symmetric images', () => {
    const slab = add({ box: { size: [2, 2, 2], segments: [2, 1, 1] } });
    const sym = run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: ['x'] });
    const right = slab.e.vertices.findIndex((p) => p[0] === 1 && p[1] === -1 && p[2] === 1);
    const middle = slab.e.vertices.findIndex((p) => p[0] === 0 && p[1] === -1 && p[2] === 1);
    const result = run(sym.document, 'set_cage_crease', { id: slab.id, edges: [[right, middle]], vertices: [right], sharpness: 2 });
    expect(entityOf(result.document, slab.id).edgeSharpness).toHaveLength(2);
    expect(entityOf(result.document, slab.id).vertexSharpness).toHaveLength(2);
  });
  it.each([
    [{ edges: 'all', sharpness: 12 }, 'DIR_SHARPNESS_RANGE'],
    [{ edges: 'all', sharpness: -1 }, 'DIR_SHARPNESS_RANGE'],
    [{ sharpness: 1 }, 'DIR_NOTHING_TO_DO'],
    [{ edges: ['e:v-9.1|v-9.2'], sharpness: 1 }, 'DIR_REF_LOST'],
    [{ edges: ['f-1.0'], sharpness: 1 }, 'DIR_ELEMENT_KIND'],
    [{ edges: { loopFrom: [0, 7] }, sharpness: 1 }, 'DIR_REF_LOST'],
    [{ vertices: [99], sharpness: 1 }, 'DIR_REF_LOST'],
    [{ id: 'nope', edges: 'all', sharpness: 1 }, 'DIR_ENTITY_NOT_FOUND'],
  ])('rejects %j with %s (VC-DIR-27)', (params, expected) => {
    const result = run(cube.doc, 'set_cage_crease', { id: cube.id, ...params });
    expectNoOp(result, cube.doc);
    expect(code(result)).toBe(expected);
  });
  it('is pure', () => {
    expectPure(cube.doc, () => run(cube.doc, 'set_cage_crease', { id: cube.id, edges: 'all', sharpness: 2 }));
  });
});

describe('set_cage_symmetry', () => {
  const slab = add({ box: { size: [2, 2, 2], segments: [2, 1, 1] } });
  it('pairs vertices, stores the partners and reports counts', () => {
    const result = run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: ['x', 'x'] });
    const data = dataOf<{ planes: string[]; pairs: number[]; onPlane: number[]; maxDeviation: number }>(result);
    expect(data.planes).toEqual(['x']);
    expect(data.pairs).toEqual([4]);
    expect(data.onPlane).toEqual([4]);
    expect(data.maxDeviation).toBe(0);
    expect(entityOf(result.document, slab.id).symmetry?.partners[0]).toHaveLength(12);
    const two = run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: ['x', 'y'] });
    expect(dataOf<{ pairs: number[] }>(two).pairs).toEqual([4, 6]);
  });
  it('clears the symmetry and refuses clearing none', () => {
    const sym = run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: ['x'] });
    const cleared = run(sym.document, 'set_cage_symmetry', { id: slab.id, planes: [] });
    expect(entityOf(cleared.document, slab.id).symmetry).toBeUndefined();
    expectNoOp(run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: [] }), slab.doc, 'no symmetry to clear');
  });
  it('lists unpaired vertices, and snaps near-mirror ones onto exact mirrors', () => {
    const nudged = run(slab.doc, 'edit_subdivision_cage', {
      id: slab.id,
      vertexIndices: [slab.e.vertices.findIndex((p) => p[0] === 1)],
      translate: [0.01, 0, 0],
    });
    const refused = run(nudged.document, 'set_cage_symmetry', { id: slab.id, planes: ['x'] });
    expectNoOp(refused, nudged.document, 'no mirror partner');
    expect(code(refused)).toBe('DIR_SYMMETRY_UNPAIRED');
    expect(refused.summary).toMatch(/v-1\.\d+ \(x:/);
    const snapped = run(nudged.document, 'set_cage_symmetry', { id: slab.id, planes: ['x'], tolerance: 0.05, snap: true });
    expect(dataOf<{ maxDeviation: number }>(snapped).maxDeviation).toBeLessThan(1e-12);
    const onPlane = run(slab.doc, 'edit_subdivision_cage', {
      id: slab.id,
      vertexIndices: [slab.e.vertices.findIndex((p) => p[0] === 0)],
      translate: [0.01, 0, 0],
    });
    const fixed = run(onPlane.document, 'set_cage_symmetry', { id: slab.id, planes: ['x'], tolerance: 0.05, snap: true });
    expect(entityOf(fixed.document, slab.id).vertices.filter((p) => p[0] === 0)).toHaveLength(4);
  });
  it('refuses a cage whose faces have no mirror face', () => {
    const lopsided = add({
      vertices: [
        [1, 1, 1],
        [-1, -1, 1],
        [-1, 1, -1],
        [1, -1, -1],
      ],
      faces: [
        [0, 1, 2],
        [0, 3, 1],
        [0, 2, 3],
        [1, 3, 2],
      ],
    });
    const result = run(lopsided.doc, 'set_cage_symmetry', { id: lopsided.id, planes: ['x'] });
    expectNoOp(result, lopsided.doc);
    expect(['DIR_SYMMETRY_TOPOLOGY', 'DIR_SYMMETRY_UNPAIRED']).toContain(code(result));
  });
  it('is pure and refuses a missing id', () => {
    expectPure(slab.doc, () => run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: ['x'] }));
    expect(code(run(slab.doc, 'set_cage_symmetry', { id: 'nope', planes: ['x'] }))).toBe('DIR_ENTITY_NOT_FOUND');
  });
});

describe('select_cage_elements (VC-DIR-40)', () => {
  const pad = add({ box: { size: [2, 2, 2], segments: [2, 2, 2] }, levels: 2 });
  it('finds the four top faces by normal cone', () => {
    const result = run(pad.doc, 'select_cage_elements', { id: pad.id, faces: { normal: [0, 0, 1], within: 0.2 } });
    const data = dataOf<{ faces: string[]; vertices: string[]; faceIndices: number[] }>(result);
    expect(data.faces).toHaveLength(4);
    expect(data.vertices).toHaveLength(9);
    expect(data.faceIndices.every((f) => pad.e.faces[f]?.every((v) => (pad.e.vertices[v] as Vec3)[2] === 1))).toBe(true);
    expect(result.affected).toEqual([]);
  });
  it('follows an equatorial edge loop and a quad ring', () => {
    const equator = pad.e.vertices.flatMap((p, v) => (p[2] === 0 ? [v] : []));
    const edge = pad.e.faces
      .flatMap((face) => face.map((a, i) => [a, face[(i + 1) % 4] as number] as const))
      .find(([a, b]) => equator.includes(a) && equator.includes(b)) as readonly [number, number];
    const loop = run(pad.doc, 'select_cage_elements', { id: pad.id, loopFrom: [...edge] });
    expect(dataOf<{ edges: string[]; vertices: string[] }>(loop)).toMatchObject({ edges: expect.any(Array) });
    expect(dataOf<{ edges: string[] }>(loop).edges).toHaveLength(8);
    expect(dataOf<{ vertices: string[] }>(loop).vertices).toHaveLength(8);
    const ring = run(pad.doc, 'select_cage_elements', { id: pad.id, ringFrom: [...edge] });
    expect(dataOf<{ faces: string[] }>(ring).faces.length).toBeGreaterThanOrEqual(4);
    const ids = dataOf<{ edges: string[] }>(loop).edges;
    const again = run(pad.doc, 'select_cage_elements', { id: pad.id, loopFrom: ids[3] });
    expect(new Set(dataOf<{ edges: string[] }>(again).edges)).toEqual(new Set(ids));
  });
  it('selects the nearest element, a region, a sphere, grows and filters by kind', () => {
    const nearest = run(pad.doc, 'select_cage_elements', { id: pad.id, nearest: [1.2, 1.1, 0.9] });
    expect(dataOf<{ vertexIndices: number[] }>(nearest).vertexIndices.map((v) => pad.e.vertices[v])).toEqual([[1, 1, 1]]);
    expect(
      dataOf<{ edges: string[] }>(run(pad.doc, 'select_cage_elements', { id: pad.id, nearest: [0.5, 1, 1], kind: 'edge' })).edges,
    ).toHaveLength(1);
    expect(
      dataOf<{ faces: string[] }>(run(pad.doc, 'select_cage_elements', { id: pad.id, nearest: [0.5, 0.5, 1.2], kind: 'face' })).faces,
    ).toHaveLength(1);
    const region = run(pad.doc, 'select_cage_elements', { id: pad.id, region: { min: [-1.1, -1.1, 0.9], max: [1.1, 1.1, 1.1] } });
    expect(dataOf<{ faces: string[]; edges: string[]; vertices: string[] }>(region)).toMatchObject({ vertices: expect.any(Array) });
    expect(dataOf<{ faces: string[] }>(region).faces).toHaveLength(4);
    expect(dataOf<{ edges: string[] }>(region).edges).toHaveLength(12);
    const sphere = run(pad.doc, 'select_cage_elements', { id: pad.id, within: { point: [1, 1, 1], radius: 1.1 } });
    expect(dataOf<{ vertices: string[] }>(sphere).vertices).toHaveLength(4);
    const grown = run(pad.doc, 'select_cage_elements', { id: pad.id, nearest: [1, 1, 1], grow: 1 });
    expect(dataOf<{ vertices: string[] }>(grown).vertices.length).toBeGreaterThan(3);
    const faces = run(pad.doc, 'select_cage_elements', { id: pad.id, within: { point: [0, 0, 0], radius: 5 }, kind: 'face' });
    expect(dataOf<{ faces: string[]; vertices: string[] }>(faces)).toMatchObject({ vertices: [] });
  });
  it.each([
    [{}, 'DIR_SELECTOR_INVALID'],
    [{ nearest: [0, 0, 0], region: { min: [0, 0, 0], max: [1, 1, 1] } }, 'DIR_SELECTOR_INVALID'],
    [{ faces: { normal: [0, 0, 0] } }, 'DIR_SELECTOR_INVALID'],
    [{ loopFrom: 'e:v-9.1|v-9.2' }, 'DIR_REF_LOST'],
    [{ ringFrom: 'f-1.0' }, 'DIR_ELEMENT_KIND'],
    [{ id: 'nope', nearest: [0, 0, 0] }, 'DIR_ENTITY_NOT_FOUND'],
  ])('rejects %j with %s', (params, expected) => {
    const result = run(pad.doc, 'select_cage_elements', { id: pad.id, ...params });
    expect(code(result)).toBe(expected);
    expect(result.document).toBe(pad.doc);
  });
  it('refuses a ring through an n-gon with DIR_LOOP_NOT_QUAD', () => {
    const drum = add({ cylinder: { radius: 1, height: 2, sides: 5 } });
    const capEdge = drum.e.faces[drum.e.faces.length - 1] as readonly number[];
    const result = run(drum.doc, 'select_cage_elements', { id: drum.id, ringFrom: [capEdge[0] as number, capEdge[1] as number] });
    expect(code(result)).toBe('DIR_LOOP_NOT_QUAD');
  });
});

describe('evaluate_subdivision and check_subdivision', () => {
  const cube = add({ box: { size: [2, 2, 2] }, levels: 3 });
  it('returns the exact limit of the cube (VC-DIR-02, 03)', () => {
    const result = run(cube.doc, 'evaluate_subdivision', {
      id: cube.id,
      vertices: ['v-1.2'],
      samples: [
        { face: 'f-1.0', u: 0.5, v: 0.5 },
        { face: 0, u: 0.5, v: 1 },
      ],
    });
    const points = dataOf<{ points: Array<{ id: string; limit: number[]; normal?: number[]; rule?: string; valence?: number }> }>(
      result,
    ).points;
    near(points[0]?.limit as number[], [0.5, 0.5, 0.5], 12);
    near(points[0]?.normal as number[], [0.57735026919, 0.57735026919, 0.57735026919], 10);
    expect(points[0]).toMatchObject({ rule: 'smooth', valence: 3, id: 'v-1.2' });
    near(points[1]?.limit as number[], [0, 0, 68 / 81], 12);
    near(points[2]?.limit as number[], [0, 395 / 648, 395 / 648], 12);
    expect(points[1]?.id).toBe('f-1.0@0.5,0.5');
    expect(dataOf<{ extraordinary: Array<{ valence: number }> }>(result).extraordinary).toHaveLength(8);
    expect(result.affected).toEqual([]);
  });
  it('evaluates every vertex by default, with curvature and degenerate flags', () => {
    const result = run(cube.doc, 'evaluate_subdivision', { id: cube.id, curvature: true });
    const points = dataOf<{ points: Array<Record<string, unknown>> }>(result).points;
    expect(points).toHaveLength(8);
    expect(points.every((p) => p['degenerate'] === true && p['code'] === 'DIR_EVAL_DEGENERATE')).toBe(true);
    const fine = add({ box: { size: [4, 4, 4], segments: [4, 4, 4] } });
    const regular = run(fine.doc, 'evaluate_subdivision', {
      id: fine.id,
      curvature: true,
      vertices: [fine.e.vertices.findIndex((p) => p[2] === 2 && p[0] === 0 && p[1] === 0)],
    });
    const point = dataOf<{ points: Array<Record<string, unknown>> }>(regular).points[0] as Record<string, unknown>;
    expect(point['k1']).toBeDefined();
    const sample = run(fine.doc, 'evaluate_subdivision', { id: fine.id, curvature: true, samples: [{ face: 0, u: 0.5, v: 0.5 }] });
    expect(dataOf<{ points: Array<Record<string, unknown>> }>(sample).points[0]).toMatchObject({ kind: 'sample', approximate: false });
  });
  it('flags non-quad faces and refuses bad references and budgets', () => {
    const drum = add({ cylinder: { radius: 1, height: 2, sides: 5 } });
    const cap = drum.e.faces.length - 1;
    const flagged = run(drum.doc, 'evaluate_subdivision', { id: drum.id, samples: [{ face: cap, u: 0.5, v: 0.5 }], vertices: [] });
    expect(flagged.summary).toContain('DIR_EVAL_DEGENERATE');
    expect(code(run(cube.doc, 'evaluate_subdivision', { id: cube.id, vertices: ['v-9.9'] }))).toBe('DIR_REF_LOST');
    expect(code(run(cube.doc, 'evaluate_subdivision', { id: cube.id, samples: [{ face: 'v-1.0', u: 0, v: 0 }] }))).toBe('DIR_ELEMENT_KIND');
    expect(code(run(cube.doc, 'evaluate_subdivision', { id: 'nope' }))).toBe('DIR_ENTITY_NOT_FOUND');
    const samples = Array.from({ length: 10_001 }, () => ({ face: 0, u: 0.5, v: 0.5 }));
    expect(code(run(cube.doc, 'evaluate_subdivision', { id: cube.id, samples }))).toBe('DIR_EVAL_BUDGET');
  });
  it('checks the smooth cube (VC-DIR-28)', () => {
    const result = run(cube.doc, 'check_subdivision', { id: cube.id });
    const data = dataOf<{
      status: string;
      findings: Array<{ code: string; severity: string }>;
      extraordinaryHistogram: Record<string, number>;
      euler: number;
      genus: number;
      meshVolume: number;
      limitVolumeEstimate: number;
      limitPatches: unknown;
      provenance: { scheme: string };
      tolerances: Array<{ defaulted: boolean }>;
    }>(result);
    expect(data.extraordinaryHistogram).toEqual({ '3': 8 });
    expect(data.euler).toBe(2);
    expect(data.genus).toBe(0);
    expect(data.meshVolume / 2.66462478968).toBeCloseTo(1, 9);
    expect(data.limitVolumeEstimate).toBeCloseTo(2.62042, 4);
    expect(data.findings.map((f) => f.code)).toEqual(['DIR_CHECK_LEVEL_MESH_DEVIATION', 'DIR_CHECK_EXTRAORDINARY']);
    expect(data.status).toBe('warn');
    expect(data.limitPatches).toBeNull();
    expect(data.provenance.scheme).toBe('Catmull-Clark');
    expect(data.tolerances.every((t) => t.defaulted)).toBe(true);
    expect(run(cube.doc, 'check_subdivision', { id: cube.id, tolerances: { meshVsLimitRel: 0.05, symmetry: 1 } }).summary).toContain(
      'pass',
    );
  });
  it('fails on a degenerate face and a self-intersecting level mesh, warns on symmetry deviation', () => {
    const slab = add({ box: { size: [3, 1, 1], segments: [3, 1, 1] }, levels: 2 });
    const through = run(slab.doc, 'edit_subdivision_cage', {
      id: slab.id,
      vertices: slab.e.vertices.flatMap((p, v) => (p[2] === 0.5 && Math.abs(p[0]) < 1 ? [v] : [])),
      translate: [0, 0, -5],
    });
    const crossing = run(through.document, 'check_subdivision', { id: slab.id });
    expect(dataOf<{ status: string }>(crossing).status).toBe('fail');
    expect(crossing.summary).toContain('DIR_CHECK_SELF_INTERSECTION');
    const flat = run(slab.doc, 'edit_subdivision_cage', { id: slab.id, vertices: [0, 1], scale: [1, 1, 1], translate: [0, 0, 0] });
    expect(flat.affected).toEqual([slab.id]);
    const squashed = run(slab.doc, 'edit_subdivision_cage', {
      id: slab.id,
      region: { min: [-9, -9, 0.4], max: [9, 9, 0.6] },
      scale: [1, 1, 1e-9],
    });
    expect(squashed.affected).toEqual([slab.id]);
    const sym = run(slab.doc, 'set_cage_symmetry', { id: slab.id, planes: ['x'] });
    const symmetric = sym.document.entities[slab.id] as SubdivisionEntity;
    const skewed = {
      document: {
        ...sym.document,
        entities: {
          [slab.id]: { ...symmetric, vertices: symmetric.vertices.map((p, v): Vec3 => (v === 0 ? [p[0] + 0.2, p[1], p[2]] : p)) },
        },
      },
    };
    const warned = run(skewed.document as CadDocument, 'check_subdivision', { id: slab.id });
    expect(warned.summary).toContain('DIR_CHECK_SYMMETRY_DEVIATION');
  });
  it('reports degenerate cage faces', () => {
    const slab = add({ box: { size: [2, 2, 2] }, levels: 1 });
    const collapsed = run(slab.doc, 'edit_subdivision_cage', {
      id: slab.id,
      region: { min: [-9, -9, 0], max: [9, 9, 9] },
      scale: [1, 1, 1e-14],
    });
    const flatTop = run(collapsed.document, 'edit_subdivision_cage', {
      id: slab.id,
      vertexIndices: [0, 1, 2, 3],
      scale: [1e-14, 1e-14, 1],
    });
    expect(run(flatTop.document, 'check_subdivision', { id: slab.id }).summary).toContain('DIR_CHECK_DEGENERATE_FACE');
  });
  it('adds the exact patch solid volume and seam continuity with a kernel, and survives one that cannot answer', () => {
    const scripted = (answer: boolean): GeometryKernel => {
      const handle = {} as never;
      return {
        name: 'scripted',
        supports: () => true,
        evaluate: () => handle,
        tessellate: () => null,
        topology: () => null,
        exportStep: () => null,
        massProperties: () => (answer ? ({ volume: 2.6, area: 1 } as never) : null),
        faceQuery: {
          faceGraph: () => ({ faces: [], edgeFaces: [[0, 1], [0], [1, 2]], edgeConvexity: [] }),
          edgeContinuity: (_shape: unknown, edge: number) =>
            edge === 2 ? null : [{ t: 0, point: [0, 0, 0], g0: 1e-7, g1: 0.02, normalCurvature: [0, 0] }],
        } as never,
      } as GeometryKernel;
    };
    const exact = run(cube.doc, 'check_subdivision', { id: cube.id, exactSeams: true }, { ...defaultContext(), kernel: scripted(true) });
    expect(dataOf<{ limitPatches: { volume: number; seams: number; maxG1AngleRad: number } }>(exact).limitPatches).toMatchObject({
      volume: 2.6,
      seams: 1,
      maxG1AngleRad: 0.02,
    });
    const optIn = run(cube.doc, 'check_subdivision', { id: cube.id }, { ...defaultContext(), kernel: scripted(true) });
    expect(dataOf<{ limitPatches: unknown }>(optIn).limitPatches).toBeNull();
    const silent = run(cube.doc, 'check_subdivision', { id: cube.id, exactSeams: true }, { ...defaultContext(), kernel: scripted(false) });
    expect(dataOf<{ limitPatches: unknown }>(silent).limitPatches).toBeNull();
    const meshOnly = run(
      cube.doc,
      'check_subdivision',
      { id: cube.id, exactSeams: true },
      { ...defaultContext(), kernel: { ...scripted(true), faceQuery: undefined } as unknown as GeometryKernel },
    );
    expect(dataOf<{ limitPatches: unknown }>(meshOnly).limitPatches).toBeNull();
  });
  it('are pure queries and refuse a missing entity', () => {
    expectPure(cube.doc, () => [
      run(cube.doc, 'evaluate_subdivision', { id: cube.id }),
      run(cube.doc, 'check_subdivision', { id: cube.id }),
    ]);
    expect(code(run(cube.doc, 'check_subdivision', { id: 'nope' }))).toBe('DIR_ENTITY_NOT_FOUND');
    expect(boxCage([1, 1, 1], [1, 1, 1]).faces).toHaveLength(6);
  });
});
