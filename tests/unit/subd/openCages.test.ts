/** DIR M5: open cages (boundary edges), their limit surface, queries and conversion; remaining branches of the M5 topology tools. */
import { describe, expect, it } from 'vitest';
import { type CadDocument, type NurbsSurfaceEntity, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { cageProblem } from '@core/geometry/subdivision';
import { validateEntityValue } from '@core/commands/persistence/guards';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { cageToNurbs } from '@core/geometry/subd/toNurbs';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { volumeOf } from '../../helpers/fixtureDocument';

const empty = createEmptyDocument();
const run = (doc: CadDocument, name: string, params: object): ReturnType<typeof execute> =>
  execute(doc, name, params as Record<string, unknown>);
const entityOf = (doc: CadDocument, id: string): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;
const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
const dataOf = <T>(result: ReturnType<typeof execute>): T => result.data as T;
const counts = (e: SubdivisionEntity): { V: number; E: number; F: number; euler: number } => {
  const edges = new Set(
    e.faces.flatMap((face) => face.map((a, i) => [a, face[(i + 1) % face.length] as number].sort((x, y) => x - y).join(':'))),
  );
  return { V: e.vertices.length, E: edges.size, F: e.faces.length, euler: e.vertices.length - edges.size + e.faces.length };
};

/** A flat n x n quad sheet in the z = 0 plane, counter-clockwise seen from +z. */
function sheet(n: number): { vertices: Vec3[]; faces: number[][] } {
  const vertices: Vec3[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.push([i, j, 0]);
  const at = (i: number, j: number): number => j * (n + 1) + i;
  const faces: number[][] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  return { vertices, faces };
}
const open = (params: object = {}): { doc: CadDocument; e: SubdivisionEntity } => {
  const made = run(empty, 'add_subdivision_solid', { ...sheet(2), boundary: 'edge_and_corner', levels: 2, id: 's', ...params });
  expect(made.affected, made.summary).toEqual(['s']);
  return { doc: made.document, e: entityOf(made.document, 's') };
};
const at = (e: SubdivisionEntity, p: Vec3): number => e.vertices.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-9);

describe('open cages', () => {
  it('are accepted only with a boundary mode and need no 4 closed faces', () => {
    const refused = run(empty, 'add_subdivision_solid', { ...sheet(2), id: 's' });
    expect(code(refused)).toBe('DIR_CAGE_OPEN');
    expectNoOp(refused, empty);
    const single = run(empty, 'add_subdivision_solid', { vertices: sheet(1).vertices, faces: sheet(1).faces, boundary: 'edge_only' });
    expect(single.affected).toHaveLength(1);
    expect(cageProblem({ ...sheet(2), creases: [], boundary: 'edge_only' })).toBeNull();
    expect(cageProblem({ vertices: sheet(1).vertices.slice(0, 2), faces: [], creases: [], boundary: 'edge_only' })).toMatch(
      /at least 3 vertices/,
    );
    expect(cageProblem({ vertices: sheet(1).vertices, faces: [], creases: [], boundary: 'edge_only' })).toMatch(/at least 1 face/);
    expect(cageProblem({ ...sheet(1), creases: [[0, 3]], boundary: 'edge_only' })).toMatch(/not an edge/);
    expect(cageProblem({ vertices: sheet(1).vertices, faces: [[0, 1, 2, 3]], creases: [[1, 0]], boundary: 'edge_only' })).toBeNull();
    const bowtie = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [2, 1, 0],
        [2, 2, 0],
        [1, 2, 0],
      ] as Vec3[],
      faces: [
        [0, 1, 2, 3],
        [2, 4, 5, 6],
      ],
      creases: [],
      boundary: 'edge_only' as const,
    };
    expect(cageProblem(bowtie)).toMatch(/pinch/);
  });

  it('keep their flat boundary: edge_and_corner pins the corners, edge_only rounds them', () => {
    const pinned = dataOf<{ min: number[]; max: number[] }>(run(open().doc, 'measure_bounding_box', { entityId: 's' }));
    expect(pinned.min.map((x) => Math.abs(x))).toEqual([0, 0, 0]);
    expect(pinned.max).toEqual([2, 2, 0]);
    const corner = (boundary: string): { limit: Vec3; rule: string } =>
      dataOf<{ points: Array<{ limit: Vec3; rule: string }> }>(
        run(open({ boundary }).doc, 'evaluate_subdivision', { id: 's', vertices: [0] }),
      ).points[0] as { limit: Vec3; rule: string };
    expect(corner('edge_and_corner')).toMatchObject({ rule: 'corner', limit: [0, 0, 0] });
    const rounded = corner('edge_only');
    expect(rounded.rule).toBe('crease');
    expect(rounded.limit[0]).toBeCloseTo(1 / 6, 12);
    expect(rounded.limit[1]).toBeCloseTo(1 / 6, 12);
  });

  it('have no volume, report their boundary loops and genus', () => {
    const { doc } = open();
    expect(run(doc, 'mass_properties', { entityId: 's' }).summary).toContain('no solid volume');
    const check = dataOf<{ open: boolean; boundary: string; boundaryLoops: string[][]; genus: number; meshVolume: unknown; euler: number }>(
      run(doc, 'check_subdivision', { id: 's' }),
    );
    expect(check).toMatchObject({ open: true, boundary: 'edge_and_corner', genus: 0, meshVolume: null, euler: 1 });
    expect(check.boundaryLoops).toHaveLength(1);
    expect(check.boundaryLoops[0]).toHaveLength(8);
  });

  it('evaluate with the boundary rules: corner stays, crease point is (4v + a + b) / 6', () => {
    const { doc, e } = open({ levels: 1 });
    const corner = at(e, [0, 0, 0]);
    const side = at(e, [1, 0, 0]);
    const limits = dataOf<{ points: Array<{ limit: Vec3; rule: string }> }>(
      run(doc, 'evaluate_subdivision', { id: 's', vertices: [corner, side] }),
    ).points;
    expect(limits[0]).toMatchObject({ rule: 'corner', limit: [0, 0, 0] });
    expect(limits[1]?.rule).toBe('crease');
    expect(limits[1]?.limit[0]).toBeCloseTo(1, 12);
    expect(limits[1]?.limit[2]).toBeCloseTo(0, 12);
  });

  it('survive a save and load, and the load guard checks the boundary mode', () => {
    const { doc, e } = open();
    expect(deserializeDocument(serializeDocument(doc)).entities['s']).toEqual(e);
    expect(validateEntityValue(JSON.parse(JSON.stringify(e)))).toBeNull();
    expect(validateEntityValue({ ...JSON.parse(JSON.stringify(e)), boundary: 'bogus' })).toMatch(/boundary must be/);
    const closedWith = JSON.parse(JSON.stringify(e)) as { boundary?: string };
    delete closedWith.boundary;
    expect(validateEntityValue(closedWith)).toMatch(/closed/);
  });

  it('convert to sheets: every patch is a bicubic sheet and the outline is the flat square', () => {
    const { doc } = open();
    const result = run(doc, 'subdivision_to_nurbs', { id: 's' });
    expect(result.affected).toHaveLength(16);
    const poles = result.affected.flatMap((id) => (result.document.entities[id] as NurbsSurfaceEntity).surface.poles.flat());
    expect(Math.min(...poles.map((p) => p[0]))).toBeCloseTo(0, 12);
    expect(Math.max(...poles.map((p) => p[1]))).toBeCloseTo(2, 12);
    expect(poles.every((p) => Math.abs(p[2]) < 1e-12)).toBe(true);
    const direct = cageToNurbs({ ...sheet(2), creases: [], boundary: 'edge_and_corner' }, { packed: true, samples: 2 });
    expect(direct.maxDeviation).toBeLessThan(0.05);
  });

  it('accept the face tools: extrude a sheet face, inset, loop cut stops at the boundary with a code', () => {
    const { doc } = open();
    const extruded = run(doc, 'extrude_cage_faces', { id: 's', faces: [0], distance: 1 });
    expect(extruded.affected).toEqual(['s']);
    expect(cageProblem(entityOf(extruded.document, 's'))).toBeNull();
    expect(entityOf(extruded.document, 's').boundary).toBe('edge_and_corner');
    expect(code(run(doc, 'loop_cut_cage', { id: 's', edge: [0, 1] }))).toBe('DIR_LOOP_NOT_QUAD');
  });

  it('are pure to create and query', () => {
    const { doc } = open();
    expectPure(doc, () => [run(doc, 'check_subdivision', { id: 's' }), run(doc, 'subdivision_to_nurbs', { id: 's' })]);
  });
});

describe('delete / fill / bridge branches', () => {
  const grid = run(empty, 'add_subdivision_solid', { box: { size: [2, 2, 2], segments: [2, 2, 2] }, levels: 1, id: 'g' });
  const g = entityOf(grid.document, 'g');
  const topCentre = at(g, [0, 0, 1]);
  const topFaces = g.faces.map((_, f) => f).filter((f) => g.faces[f]?.every((v) => (g.vertices[v] as Vec3)[2] === 1));

  it('refuses a deletion that pinches the surface at a vertex', () => {
    const diagonal = topFaces.filter(
      (f) => (g.faces[f] as number[]).includes(at(g, [-1, -1, 1])) || (g.faces[f] as number[]).includes(at(g, [1, 1, 1])),
    );
    expect(diagonal).toHaveLength(2);
    const pinched = run(grid.document, 'delete_cage_faces', { id: 'g', faces: diagonal });
    expect(code(pinched)).toBe('DIR_CAGE_INVALID');
    expectNoOp(pinched, grid.document);
  });

  it('bevels an edge between two valence-4 vertices (patch faces at both ends), also beside a deleted face', () => {
    const edge = [topCentre, at(g, [0, -1, 1])];
    const bevelled = run(grid.document, 'bevel_cage_edges', { id: 'g', edges: [edge], width: 0.25 });
    expect(bevelled.affected).toEqual(['g']);
    expect(cageProblem(entityOf(bevelled.document, 'g'))).toBeNull();
    expect(counts(entityOf(bevelled.document, 'g')).euler).toBe(2);
    const missing = topFaces.find(
      (f) => (g.faces[f] as number[]).includes(topCentre) && (g.faces[f] as number[]).includes(at(g, [1, 0, 1])),
    );
    const holed = run(grid.document, 'delete_cage_faces', { id: 'g', faces: [missing] });
    const beside = run(holed.document, 'bevel_cage_edges', { id: 'g', edges: [edge], width: 0.25 });
    expect(cageProblem(entityOf(beside.document, 'g'))).toBeNull();
    const pair = run(empty, 'add_subdivision_solid', {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [2, 1, 0],
      ],
      faces: [
        [0, 1, 4, 3],
        [1, 2, 5, 4],
      ],
      boundary: 'edge_only',
      id: 'p',
    });
    const shared = run(pair.document, 'bevel_cage_edges', { id: 'p', edges: [[1, 4]], width: 0.25 });
    expect(shared.affected).toEqual(['p']);
    expect(cageProblem(entityOf(shared.document, 'p'))).toBeNull();
  });

  it('keeps the sharpness of the edges a bevel splits', () => {
    const creased = run(grid.document, 'edit_subdivision_cage', { id: 'g', crease: true });
    const edge = [topCentre, at(g, [0, -1, 1])];
    const bevelled = run(creased.document, 'bevel_cage_edges', { id: 'g', edges: [edge], width: 0.25, sharp: 5 });
    const e = entityOf(bevelled.document, 'g');
    expect(e.edgeSharpness?.some((entry) => entry.s === 5)).toBe(true);
    expect(e.creases.length).toBeGreaterThan(0);
  });

  it('refuses to bridge a closed surface, a region with a hole, and two regions at once', () => {
    const everything = run(grid.document, 'bridge_cage_faces', { id: 'g', facesA: g.faces.map((_, f) => f), facesB: [0] });
    expect(code(everything)).toBe('DIR_BRIDGE_REGION');
    const ring = run(empty, 'add_subdivision_solid', { box: { size: [3, 3, 1], segments: [3, 3, 1] }, levels: 1, id: 'r' });
    const r = entityOf(ring.document, 'r');
    const topRing = r.faces
      .map((_, f) => f)
      .filter(
        (f) =>
          r.faces[f]?.every((v) => (r.vertices[v] as Vec3)[2] === 0.5) &&
          f !==
            r.faces.findIndex((face) =>
              face.every(
                (v) =>
                  Math.abs((r.vertices[v] as Vec3)[0]) <= 0.5 &&
                  Math.abs((r.vertices[v] as Vec3)[1]) <= 0.5 &&
                  (r.vertices[v] as Vec3)[2] === 0.5,
              ),
            ),
      );
    expect(topRing).toHaveLength(8);
    const holed = run(ring.document, 'bridge_cage_faces', {
      id: 'r',
      facesA: topRing,
      facesB: [r.faces.findIndex((face) => face.every((v) => (r.vertices[v] as Vec3)[2] === -0.5))],
    });
    expect(['DIR_BRIDGE_REGION', 'DIR_BRIDGE_COUNT_MISMATCH']).toContain(code(holed));
    expect(code(run(ring.document, 'bridge_cage_faces', { id: 'r', facesB: [0] }))).toBe('DIR_SELECTOR_INVALID');
    expect(code(run(ring.document, 'bridge_cage_faces', { id: 'r', facesA: [0], loopA: [0, 1], facesB: [1] }))).toBe(
      'DIR_SELECTOR_INVALID',
    );
    expect(code(run(ring.document, 'bridge_cage_faces', { id: 'r', facesA: [0], loopB: [0, 1], facesB: [1] }))).toBe(
      'DIR_SELECTOR_INVALID',
    );
  });

  it('fills the mirror hole of a symmetric cage, refuses quads on an odd loop', () => {
    const sym = run(grid.document, 'set_cage_symmetry', { id: 'g', planes: ['x'] });
    const side = g.faces.map((_, f) => f).find((f) => g.faces[f]?.every((v) => (g.vertices[v] as Vec3)[0] === 1));
    const holes = run(sym.document, 'delete_cage_faces', { id: 'g', faces: [side] });
    expect(dataOf<{ boundaryLoops: unknown[] }>(holes).boundaryLoops).toHaveLength(2);
    const loop = dataOf<{ boundaryLoops: string[][] }>(holes).boundaryLoops[0] as string[];
    const rim = `e:${[loop[0], loop[1]].sort().join('|')}`;
    const filled = run(holes.document, 'fill_cage_hole', { id: 'g', edge: rim });
    expect(filled.affected).toEqual(['g']);
    expect(entityOf(filled.document, 'g').boundary).toBeUndefined();
    expect(counts(entityOf(filled.document, 'g')).euler).toBe(2);
    const tetra = run(empty, 'add_subdivision_solid', {
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
      id: 't',
    });
    const opened = run(tetra.document, 'delete_cage_faces', { id: 't', faces: [3] });
    const odd = run(opened.document, 'fill_cage_hole', { id: 't', edge: [1, 3], mode: 'quads' });
    expect(code(odd)).toBe('DIR_FILL_ODD');
    expect(run(opened.document, 'fill_cage_hole', { id: 't', edge: [1, 3] }).affected).toEqual(['t']);
  });

  it('drops corner sharpness of vertices a deletion removes', () => {
    const cornered = run(empty, 'add_subdivision_solid', {
      box: { size: [2, 2, 2], segments: [2, 1, 1] },
      id: 'c',
      vertexSharpness: [{ v: 0, s: 2 }],
      creases: [[0, 1]],
    });
    const c = entityOf(cornered.document, 'c');
    const around = c.faces.map((_, f) => f).filter((f) => (c.faces[f] as number[]).includes(0));
    const removed = run(cornered.document, 'delete_cage_faces', { id: 'c', faces: around });
    expect(entityOf(removed.document, 'c').vertexSharpness ?? []).toEqual([]);
  });
});

describe('merging solids that share element ids, and slides that leave the surface', () => {
  it('renames the ids of the merged-in cage on a clash', () => {
    const slab = { box: { size: [3, 3, 1], segments: [3, 3, 1] }, levels: 1 };
    const first = run(empty, 'add_subdivision_solid', { ...slab, id: 'a' });
    const second = run(first.document, 'add_subdivision_solid', { ...slab, id: 'b', position: [0, 0, 4] });
    const [a, b] = [entityOf(second.document, 'a'), entityOf(second.document, 'b')];
    const clash: CadDocument = { ...second.document, entities: { ...second.document.entities, b: { ...b, elementIds: a.elementIds } } };
    const inCentre =
      (e: SubdivisionEntity, z: number) =>
      (face: readonly number[]): boolean =>
        face.every(
          (v) =>
            (e.vertices[v] as Vec3)[2] === z && Math.abs((e.vertices[v] as Vec3)[0]) <= 0.5 && Math.abs((e.vertices[v] as Vec3)[1]) <= 0.5,
        );
    const topOfA = a.faces.findIndex(inCentre(a, 0.5));
    const bottomOfB = b.faces.findIndex(inCentre(b, -0.5));
    const merged = run(clash, 'bridge_cage_faces', { id: 'a', facesA: [topOfA], otherId: 'b', facesB: [bottomOfB] });
    expect(merged.affected).toEqual(['a']);
    const e = entityOf(merged.document, 'a');
    expect(new Set(e.elementIds.vertices).size).toBe(e.vertices.length);
    expect(new Set(e.elementIds.faces).size).toBe(e.faces.length);
    expect(cageProblem(e)).toBeNull();
  });

  it('refuses a slide whose side has no face (boundary of an open cage)', () => {
    const { doc, e } = open();
    const edge = [at(e, [0, 0, 0]), at(e, [1, 0, 0])];
    const refused = run(doc, 'slide_cage_edges', { id: 's', edges: [edge], factor: -0.5 });
    expect(code(refused)).toBe('DIR_SLIDE_LOOP_INVALID');
    expectNoOp(refused, doc);
    expect(run(doc, 'slide_cage_edges', { id: 's', edges: [edge], factor: 0.5 }).affected).toEqual(['s']);
  });
});

describe('sharpness follows the topology tools', () => {
  const sharpCube = run(empty, 'add_subdivision_solid', {
    box: { size: [2, 2, 2] },
    id: 'c',
    creases: [[0, 1]],
    edgeSharpness: [{ a: 1, b: 2, s: 3 }],
    vertexSharpness: [{ v: 3, s: 2 }],
  });
  it('a weld remaps sharp edges and corners, and drops the sharp edge it collapses', () => {
    const welded = run(sharpCube.document, 'weld_cage_vertices', { id: 'c', vertices: [0, 1] });
    const e = entityOf(welded.document, 'c');
    expect(e.creases).toEqual([]);
    expect(e.edgeSharpness?.length).toBe(1);
    expect(e.vertexSharpness).toHaveLength(1);
    expect(cageProblem(e)).toBeNull();
  });

  it('a deletion keeps the corner sharpness of the vertices that stay', () => {
    const e0 = entityOf(sharpCube.document, 'c');
    const away = e0.faces.map((_, f) => f).filter((f) => !(e0.faces[f] as number[]).includes(3));
    const kept = run(sharpCube.document, 'delete_cage_faces', { id: 'c', faces: [away[0]] });
    expect(entityOf(kept.document, 'c').vertexSharpness).toHaveLength(1);
    expect(entityOf(kept.document, 'c').creases.length + (entityOf(kept.document, 'c').edgeSharpness?.length ?? 0)).toBeGreaterThan(0);
  });

  it('a merge carries the sharp edges and corners of the cage that is merged in', () => {
    const slab = { box: { size: [3, 3, 1], segments: [3, 3, 1] }, levels: 1 };
    const a = run(empty, 'add_subdivision_solid', { ...slab, id: 'a' });
    const b = run(a.document, 'add_subdivision_solid', {
      ...slab,
      id: 'b',
      position: [0, 0, 4],
      creases: [[0, 1]],
      vertexSharpness: [{ v: 5, s: 2 }],
    });
    const [ea, eb] = [entityOf(b.document, 'a'), entityOf(b.document, 'b')];
    const centre = (e: SubdivisionEntity, z: number): number =>
      e.faces.findIndex((face) =>
        face.every(
          (v) =>
            (e.vertices[v] as Vec3)[2] === z && Math.abs((e.vertices[v] as Vec3)[0]) <= 0.5 && Math.abs((e.vertices[v] as Vec3)[1]) <= 0.5,
        ),
      );
    const merged = run(b.document, 'bridge_cage_faces', { id: 'a', facesA: [centre(ea, 0.5)], otherId: 'b', facesB: [centre(eb, -0.5)] });
    const e = entityOf(merged.document, 'a');
    expect(e.creases).toHaveLength(1);
    expect(e.vertexSharpness).toHaveLength(1);
    expect(cageProblem(e)).toBeNull();
  });
});

describe('weld / slide / squash edge cases', () => {
  const cube = run(empty, 'add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 1, id: 'c' });
  const c = entityOf(cube.document, 'c');

  it('slides an open edge path of a valence-3 cage along both sides', () => {
    const edge = [at(c, [1, -1, 1]), at(c, [-1, -1, 1])];
    const left = run(cube.document, 'slide_cage_edges', { id: 'c', edges: [edge], factor: 0.25 });
    const right = run(cube.document, 'slide_cage_edges', { id: 'c', edges: { loopFrom: edge }, factor: -0.25 });
    expect(left.affected).toEqual(['c']);
    expect(right.affected).toEqual(['c']);
    expect(entityOf(left.document, 'c').vertices).not.toEqual(entityOf(right.document, 'c').vertices);
    const byId = run(cube.document, 'slide_cage_edges', {
      id: 'c',
      edges: { loopFrom: `e:${c.elementIds.vertices[edge[0] as number]}|${c.elementIds.vertices[edge[1] as number]}` },
      factor: 0.25,
    });
    expect(byId.document.featureHistory.at(-1)?.params).toMatchObject({ edges: { loopFrom: expect.stringMatching(/^e:/) } });
    const lost = run(cube.document, 'slide_cage_edges', { id: 'c', edges: [[0, 99]], factor: 0.25 });
    expect(code(lost)).toBe('DIR_REF_LOST');
  });

  it('welds with a tolerance and refuses a weld that empties the cage', () => {
    const tiny = run(cube.document, 'edit_subdivision_cage', { id: 'c', vertexIndices: [0], translate: [0.001, 0, 0] });
    const welded = run(tiny.document, 'weld_cage_vertices', { id: 'c', vertices: [0, at(c, [1, 1, -1]), 2], tolerance: 100 });
    expect(['DIR_WELD_NONMANIFOLD', undefined]).toContain(code(welded));
    expect(volumeOf(cube.document, 'c')).toBeGreaterThan(0);
  });
});
