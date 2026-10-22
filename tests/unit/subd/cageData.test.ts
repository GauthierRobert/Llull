import { describe, expect, it } from 'vitest';
import { type CadDocument, type Entity, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { boxCage, type Cage } from '@core/geometry/subdivision';
import { type Ray, pickCage } from '@core/geometry/subd/pick';
import { mirrorGroup, pairVertices, projectToPlane, symmetrize, symmetryDeviation } from '@core/geometry/subd/symmetry';
import { edgeLoop, isRingProblem, walkRing } from '@core/geometry/subd/loops';
import { buildTopology } from '@core/geometry/subd/topology';
import { surfaceEvaluator } from '@core/geometry/subd/limit';
import { subdivisionFieldsProblem } from '@core/geometry/subd/validate';

const empty = createEmptyDocument();
const run = (doc: CadDocument, name: string, params: object): ReturnType<typeof execute> =>
  execute(doc, name, params as Record<string, unknown>);
const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
function cube(params: object = {}): { doc: CadDocument; id: string; e: SubdivisionEntity } {
  const result = run(empty, 'add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 2, ...params });
  const id = result.affected[0] as string;
  return { doc: result.document, id, e: result.document.entities[id] as SubdivisionEntity };
}

describe('persisted v2 subdivision data', () => {
  const full = (() => {
    const { doc, id } = cube();
    let next = run(doc, 'set_cage_crease', { id, edges: [[0, 1]], vertices: [2], sharpness: 2, method: 'chaikin' }).document;
    next = run(next, 'set_cage_symmetry', { id, planes: ['x'] }).document;
    return { doc: next, id };
  })();
  it('round-trips semi-sharp creases, symmetry and element ids through save and load', () => {
    const loaded = run(empty, 'load_document', { json: serializeDocument(full.doc) });
    expect(loaded.document.entities[full.id]).toEqual(full.doc.entities[full.id]);
  });
  it.each([
    ['edgeSharpness', [1]],
    ['edgeSharpness', [{ a: 0, b: 1 }]],
    ['vertexSharpness', [{ v: 1 }]],
    ['vertexSharpness', 'x'],
    ['creaseMethod', 'bezier'],
    ['elementIds', undefined],
    ['elementIds', { vertices: ['a'], faces: [] }],
    ['elementIds', { vertices: Array.from({ length: 8 }, () => 'v'), faces: Array.from({ length: 6 }, (_, i) => `f${i}`) }],
    ['symmetry', { planes: [], partners: [], tolerance: 1 }],
    ['symmetry', { planes: ['w'], partners: [[0]], tolerance: 1 }],
    ['symmetry', { planes: ['x'], partners: [[0, 1]], tolerance: 1 }],
    ['symmetry', { planes: ['x'], partners: [[0, 1, 2, 3, 4, 5, 6, 99]], tolerance: 1 }],
    ['symmetry', 'x'],
  ])('refuses a corrupt %s (%j)', (key, value) => {
    const corrupt = { ...(full.doc.entities[full.id] as object), [key as string]: value } as unknown as Entity;
    const json = serializeDocument({ ...full.doc, entities: { [full.id]: corrupt } });
    const loaded = run(empty, 'load_document', { json });
    expect(loaded.document).toBe(empty);
    expect(loaded.summary).toContain('subdivision');
  });
  it('refuses semi-sharp data that is not on the cage', () => {
    const entity = full.doc.entities[full.id] as SubdivisionEntity;
    const bad = { ...entity, edgeSharpness: [{ a: 0, b: 6, s: 1 }] } as unknown as Entity;
    const loaded = run(empty, 'load_document', { json: serializeDocument({ ...full.doc, entities: { [full.id]: bad } }) });
    expect(loaded.document).toBe(empty);
  });
  it('reports each malformed field directly', () => {
    const base = full.doc.entities[full.id] as unknown as Record<string, unknown>;
    expect(subdivisionFieldsProblem(base)).toBeNull();
    expect(subdivisionFieldsProblem({ ...base, vertices: undefined, faces: undefined })).toContain('one unique id');
  });
});

describe('symmetry helpers', () => {
  it('pairs only mutual nearest mirror images', () => {
    const points: Vec3[] = [
      [1, 0, 0],
      [1.01, 0, 0],
      [-1, 0, 0],
    ];
    const pairing = pairVertices(points, ['x'], 0.05);
    expect(pairing.unpaired.length).toBeGreaterThan(0);
    expect(pairVertices(points.slice(1), ['x'], 0.05).partners[0]).toEqual([1, 0]);
  });
  it('builds the mirror group of several planes and reflects deltas', () => {
    const planes = cube().e.vertices;
    const pairing = pairVertices(planes, ['x', 'y', 'z'], 1e-9);
    const symmetry = { planes: ['x', 'y', 'z'] as Array<'x' | 'y' | 'z'>, partners: pairing.partners, tolerance: 1e-9 };
    expect(mirrorGroup(symmetry)).toHaveLength(8);
    const edited = planes.map((p, v): Vec3 => (v === 0 ? [p[0] + 0.1, p[1] + 0.2, p[2] + 0.3] : p));
    const sym = symmetrize(
      planes,
      edited,
      planes.map((_, v) => (v === 0 ? 1 : 0)),
      symmetry,
    );
    const mirror = sym[planes.findIndex((p) => p[0] === 1 && p[1] === 1 && p[2] === -1)] as Vec3;
    expect(mirror[0]).toBeCloseTo(1 - 0.1, 12);
    expect(mirror[1]).toBeCloseTo(1 - 0.2, 12);
    expect(mirror[2]).toBeCloseTo(-1 - 0.3, 12);
    expect(symmetryDeviation(sym, symmetry)).toBeLessThan(1e-12);
    expect(projectToPlane([1, 2, 3], 'y')).toEqual([1, 0, 3]);
    expect(projectToPlane([1, 2, 3], 'z')).toEqual([1, 2, 0]);
  });
  it('keeps y and z symmetric cages symmetric through commands', () => {
    const { doc, id, e } = cube();
    const sym = run(doc, 'set_cage_symmetry', { id, planes: ['y', 'z'] });
    const top = e.vertices.findIndex((p) => p[0] === 1 && p[1] === 1 && p[2] === 1);
    const edit = run(sym.document, 'edit_subdivision_cage', { id, vertexIndices: [top], translate: [0.2, 0.3, 0.4] });
    const vertices = (edit.document.entities[id] as SubdivisionEntity).vertices;
    const twin = e.vertices.findIndex((p) => p[0] === 1 && p[1] === -1 && p[2] === -1);
    expect(vertices[twin]?.[1]).toBeCloseTo(-1 - 0.3, 12);
    expect(vertices[twin]?.[2]).toBeCloseTo(-1 - 0.4, 12);
  });
  it('refuses a cage whose faces have no mirror face (DIR_SYMMETRY_TOPOLOGY)', () => {
    const box = boxCage([2, 2, 2], [1, 1, 1]);
    const side = (x: number): [number, number, number, number] =>
      box.faces.find((face) => face.every((v) => (box.vertices[v] as Vec3)[0] === x)) as [number, number, number, number];
    const [left, right] = [side(-1), side(1)];
    const split = (face: readonly [number, number, number, number], diagonal: 0 | 1): number[][] =>
      diagonal === 0
        ? [
            [face[0], face[1], face[2]],
            [face[0], face[2], face[3]],
          ]
        : [
            [face[1], face[2], face[3]],
            [face[1], face[3], face[0]],
          ];
    const outcomes = ([0, 1] as const).map((rightDiagonal) => {
      const faces = [...box.faces.filter((face) => face !== left && face !== right), ...split(left, 0), ...split(right, rightDiagonal)];
      const triangulated = run(empty, 'add_subdivision_solid', { vertices: box.vertices, faces });
      expect(triangulated.affected).toHaveLength(1);
      return code(run(triangulated.document, 'set_cage_symmetry', { id: triangulated.affected[0], planes: ['x'] }));
    });
    expect(outcomes.filter((outcome) => outcome === 'DIR_SYMMETRY_TOPOLOGY')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1);
  });
});

describe('quad rings, loops and evaluation edge cases', () => {
  const box = boxCage([2, 2, 2], [2, 2, 2]);
  const topology = buildTopology(box.vertices.length, box.faces);
  it('rejects an edge without a face on that side', () => {
    const [a, b] = [topology.edges[0]?.a as number, topology.edges[0]?.b as number];
    const problem = walkRing(topology, 999, b);
    expect(isRingProblem(problem)).toBe(true);
    expect(isRingProblem(walkRing(topology, a, b))).toBe(false);
  });
  it('ends an edge loop at valence-3 vertices of a cube and closes on a seg-2 box', () => {
    const corner = buildTopology(8, boxCage([2, 2, 2], [1, 1, 1]).faces);
    expect(edgeLoop(corner, 0, 1)).toHaveLength(1);
    const e = topology.edges.find(({ a, b }) => (box.vertices[a] as Vec3)[2] === 0 && (box.vertices[b] as Vec3)[2] === 0);
    expect(edgeLoop(topology, e?.a as number, e?.b as number)).toHaveLength(8);
  });
  it('cuts a ring while sharp edges outside the ring stay untouched', () => {
    const { doc, id } = cube();
    const sharp = run(doc, 'set_cage_crease', { id, edges: [[0, 1]], sharpness: 4 });
    const cut = run(sharp.document, 'loop_cut_cage', { id, edge: [0, 4] });
    expect((cut.document.entities[id] as SubdivisionEntity).edgeSharpness).toEqual([{ a: 0, b: 1, s: 4 }]);
  });
  it('refuses regions whose normals cancel unless a direction is given', () => {
    const { doc, id, e } = cube();
    const ring = e.faces.flatMap((face, f) =>
      face.every((v) => (e.vertices[v] as Vec3)[2] !== 1) || face.every((v) => (e.vertices[v] as Vec3)[2] !== -1) ? [] : [f],
    );
    expect(ring).toHaveLength(4);
    expect(code(run(doc, 'extrude_cage_faces', { id, faces: ring, distance: 1 }))).toBe('DIR_REGION_DEGENERATE');
    expect(code(run(doc, 'inset_cage_faces', { id, faces: ring, thickness: 0.1 }))).toBe('DIR_REGION_DEGENERATE');
    expect(run(doc, 'extrude_cage_faces', { id, faces: ring, distance: 1, direction: [0, 0, 1] }).affected).toEqual([id]);
  });
  it('moves interior sharp edges with a swept region and copies corners that belong to it', () => {
    const slab = cube({ box: { size: [4, 4, 2], segments: [2, 2, 1] }, levels: 1 });
    const centre = slab.e.vertices.findIndex((p) => p[0] === 0 && p[1] === 0 && p[2] === 1);
    const mid = slab.e.vertices.findIndex((p) => p[0] === 2 && p[1] === 0 && p[2] === 1);
    const bottom = slab.e.vertices.findIndex((p) => p[2] === -1);
    const marked = run(slab.doc, 'set_cage_crease', { id: slab.id, edges: [[centre, mid]], vertices: [centre, bottom], sharpness: 3 });
    const top = slab.e.faces.flatMap((face, f) => (face.every((v) => (slab.e.vertices[v] as Vec3)[2] === 1) ? [f] : []));
    const lifted = run(marked.document, 'extrude_cage_faces', { id: slab.id, faces: top, distance: 1 });
    const e = lifted.document.entities[slab.id] as SubdivisionEntity;
    const lifts = e.edgeSharpness?.find((edge) => edge.a === centre || edge.b === centre);
    expect(lifts).toBeDefined();
    const other = (lifts?.a === centre ? lifts?.b : lifts?.a) as number;
    expect(other).toBeGreaterThanOrEqual(slab.e.vertices.length);
    expect(e.vertexSharpness?.some((c) => c.v === bottom)).toBe(true);
    expect(e.vertexSharpness?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('surface samples near creases and extraordinary vertices', () => {
  const torusLike: Cage = (() => {
    const [nu, nv] = [6, 4];
    const vertices: Vec3[] = [];
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const [theta, phi] = [(2 * Math.PI * i) / nu, (2 * Math.PI * j) / nv];
        vertices.push([(3 + Math.cos(phi)) * Math.cos(theta), (3 + Math.cos(phi)) * Math.sin(theta), Math.sin(phi)]);
      }
    const at = (i: number, j: number): number => (i % nu) * nv + (j % nv);
    const faces = vertices.map((_, k) => [
      at(Math.floor(k / nv), k % nv),
      at(Math.floor(k / nv) + 1, k % nv),
      at(Math.floor(k / nv) + 1, (k % nv) + 1),
      at(Math.floor(k / nv), (k % nv) + 1),
    ]);
    return { vertices, faces, creases: [[0, 4]] };
  })();
  it('falls back to the limit point of the nearest corner when a crease keeps the patch irregular', () => {
    const sample = surfaceEvaluator(torusLike, 2)(0, 0.1, 0.1);
    expect(sample?.approximate).toBe(true);
    expect(sample?.point.every(Number.isFinite)).toBe(true);
  });
  it.each([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ])('uses the nearest corner of an extraordinary quad at (%s, %s)', (u, v) => {
    const sample = surfaceEvaluator(boxCage([2, 2, 2], [1, 1, 1]), 2)(0, u, v);
    expect(sample?.approximate).toBe(true);
    const expected = [
      [-0.5, -0.5, 0.5],
      [0.5, -0.5, 0.5],
      [0.5, 0.5, 0.5],
      [-0.5, 0.5, 0.5],
    ][[0, 1, 2, 3][u === 0 ? (v === 0 ? 0 : 3) : v === 0 ? 1 : 2] as number] as [number, number, number, number];
    expected.forEach((value, i) => expect((sample?.point as Vec3)[i]).toBeCloseTo(value, 12));
  });
  it('picking misses an edge parallel to the ray and reports the nearest vertex of a crowded ray', () => {
    const { e } = cube();
    const ray: Ray = { origin: [-1, -1, 5], direction: [0, 0, -1] };
    expect(pickCage(e, ray, 0.01).vertex?.index).toBe(0);
  });
});
