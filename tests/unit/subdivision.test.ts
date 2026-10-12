import { describe, it, expect } from 'vitest';
import {
  type CadDocument,
  type Entity,
  type SubdivisionEntity,
  type Vec3,
  createEmptyDocument,
} from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { entityBounds } from '@core/geometry/bounds';
import { solidTriangles } from '@core/geometry/solidTriangles';
import { tessellateEntity } from '@core/commands/render/polygons';
import {
  boxCage,
  cageProblem,
  cylinderCage,
  subdivide,
  subdivisionTriangles,
} from '@core/geometry/subdivision';
import { expectNoOp } from '../helpers/expectNoOp';

const empty = createEmptyDocument();

function run(doc: CadDocument, name: string, params: object): ReturnType<typeof execute> {
  return execute(doc, name, params as Record<string, unknown>);
}

function created(doc: CadDocument, params: object): { doc: CadDocument; e: SubdivisionEntity } {
  const result = run(doc, 'add_subdivision_solid', params);
  expect(result.affected, result.summary).toHaveLength(1);
  const id = result.affected[0] as string;
  return { doc: result.document, e: result.document.entities[id] as SubdivisionEntity };
}

function volumeOf(doc: CadDocument, id: string): number {
  return (run(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
}

function isWatertight(triangles: ReadonlyArray<ReadonlyArray<readonly number[]>>): boolean {
  const key = (p: readonly number[]): string => p.map((v) => v.toFixed(7)).join(',');
  const edges = new Map<string, number>();
  for (const triangle of triangles) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [key(triangle[k] as number[]), key(triangle[(k + 1) % 3] as number[])];
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  return [...edges.values()].every((count) => count === 2);
}

const cubeEdges = (cage: ReturnType<typeof boxCage>): Array<[number, number]> => {
  const keys = new Map<string, [number, number]>();
  for (const face of cage.faces)
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length] as number;
      keys.set(a < b ? `${a}:${b}` : `${b}:${a}`, [a, b]);
    });
  return [...keys.values()];
};

describe('subdivision geometry', () => {
  it('builds closed, valid box and cylinder cages', () => {
    const box = boxCage([2, 4, 6], [2, 3, 1]);
    expect(cageProblem(box)).toBeNull();
    expect(box.faces).toHaveLength(2 * (6 + 2 + 3));
    const cylinder = cylinderCage(1, 2, 6, 2);
    expect(cageProblem(cylinder)).toBeNull();
    expect(cylinder.vertices).toHaveLength(18);
    expect(cylinder.faces).toHaveLength(14);
  });

  it('quadruples faces per level and stays watertight', () => {
    const cage = boxCage([2, 2, 2], [1, 1, 1]);
    expect(subdivide(cage, 1).faces).toHaveLength(24);
    expect(subdivide(cage, 2).faces).toHaveLength(96);
    expect(subdivide(cage, 0)).toBe(cage);
    const triangles = subdivisionTriangles({ ...cage, levels: 2 });
    expect(triangles).toHaveLength(192);
    expect(isWatertight(triangles)).toBe(true);
  });

  it('keeps a fully creased cube a cube and rounds a smooth one inside its cage', () => {
    const cage = boxCage([2, 2, 2], [1, 1, 1]);
    const sharp = subdivide({ ...cage, creases: cubeEdges(cage) }, 3);
    for (const p of sharp.vertices) expect(Math.max(...p.map(Math.abs))).toBeCloseTo(1, 9);
    const smooth = subdivide(cage, 3);
    for (const p of smooth.vertices) expect(Math.max(...p.map(Math.abs))).toBeLessThan(1);
  });

  it('follows a crease curve and keeps corners where three creases meet', () => {
    const cage = boxCage([2, 2, 2], [1, 1, 1]);
    const top = cubeEdges(cage).filter(([a, b]) => {
      const [pa, pb] = [cage.vertices[a] as Vec3, cage.vertices[b] as Vec3];
      return pa[2] > 0 && pb[2] > 0;
    });
    const ringed = subdivide({ ...cage, creases: top }, 2);
    const topZ = Math.max(...ringed.vertices.map((p) => p[2]));
    expect(topZ).toBeCloseTo(1, 9);
    expect(ringed.creases).toHaveLength(top.length * 4);
  });

  it.each([
    [{ vertices: [[0, 0, 0]], faces: [], creases: [] }, 'at least 4 vertices'],
    [
      { ...boxCage([1, 1, 1], [1, 1, 1]), faces: boxCage([1, 1, 1], [1, 1, 1]).faces.slice(1) },
      'borders only one face',
    ],
    [
      {
        ...boxCage([1, 1, 1], [1, 1, 1]),
        faces: [
          [0, 1],
          [0, 1, 2],
          [1, 2, 3],
          [2, 3, 0],
        ],
      },
      'needs 3+',
    ],
    [
      {
        ...boxCage([1, 1, 1], [1, 1, 1]),
        faces: [
          [0, 0, 1],
          [0, 1, 2],
          [1, 2, 3],
          [2, 3, 0],
        ],
      },
      'repeats a vertex',
    ],
    [
      {
        ...boxCage([1, 1, 1], [1, 1, 1]),
        faces: [
          [0, 1, 99],
          [0, 1, 2],
          [1, 2, 3],
          [2, 3, 0],
        ],
      },
      'outside',
    ],
    [
      {
        ...boxCage([1, 1, 1], [1, 1, 1]),
        faces: [
          [0, 1, 2],
          [0, 1, 2],
          [1, 2, 3],
          [2, 3, 0],
        ],
      },
      'same direction',
    ],
    [{ ...boxCage([1, 1, 1], [1, 1, 1]), creases: [[0, 6]] }, 'not an edge'],
    [
      {
        vertices: [...boxCage([1, 1, 1], [1, 1, 1]).vertices, [5, 5, 5]],
        faces: boxCage([1, 1, 1], [1, 1, 1]).faces,
        creases: [],
      },
      'not used by any face',
    ],
    [{ ...boxCage([1, 1, 1], [1, 1, 1]), faces: [[0, 1, 2]] }, 'at least 4 faces'],
    [
      {
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
          [-1, 0, 0],
          [0, -1, 0],
          [0, 0, -1],
        ],
        faces: [
          [0, 2, 1],
          [0, 1, 3],
          [0, 3, 2],
          [1, 2, 3],
          [0, 4, 5],
          [0, 6, 4],
          [0, 5, 6],
          [4, 6, 5],
        ],
        creases: [],
      },
      'a pinch',
    ],
  ])('reports cage problems (%#)', (cage, text) => {
    expect(cageProblem(cage as Parameters<typeof cageProblem>[0])).toContain(text);
  });
});

describe('add_subdivision_solid', () => {
  it('creates a smooth box solid with world cage data', () => {
    const result = run(empty, 'add_subdivision_solid', {
      box: { size: [4, 2, 2], segments: [2, 1, 1] },
      position: [10, 0, 0],
      levels: 2,
      name: 'saddle',
    });
    expect(result.summary).toContain('12-vertex / 10-face cage, 2 level(s)');
    const data = result.data as { vertexCount: number; vertices: Vec3[] };
    expect(data.vertexCount).toBe(12);
    expect(data.vertices[0]).toEqual([8, -1, 1]);
    const e = result.document.entities[result.affected[0] as string] as SubdivisionEntity;
    expect(e.name).toBe('saddle');
    const volume = volumeOf(result.document, e.id);
    expect(volume).toBeGreaterThan(6);
    expect(volume).toBeLessThan(16);
    const b = entityBounds(e);
    expect(b.min[0]).toBeGreaterThan(8);
    expect(b.max[0]).toBeLessThan(12);
    expect(isWatertight(solidTriangles(e))).toBe(true);
    expect(tessellateEntity(e).length).toBeGreaterThan(0);
  });

  it('creates a cylinder cage with creased caps (straight walls, flat ends)', () => {
    const cage = cylinderCage(1, 2, 8, 1);
    const capEdges = cubeEdges(cage as ReturnType<typeof boxCage>).filter(
      ([a, b]) => (cage.vertices[a] as Vec3)[2] === (cage.vertices[b] as Vec3)[2],
    );
    const { doc, e } = created(empty, {
      cylinder: { radius: 1, height: 2, sides: 8 },
      creases: capEdges,
      levels: 3,
    });
    const b = entityBounds(e);
    expect(b.max[2]).toBeCloseTo(1, 6);
    expect(b.min[2]).toBeCloseTo(-1, 6);
    expect(volumeOf(doc, e.id)).toBeGreaterThan(4);
    expect(volumeOf(doc, e.id)).toBeLessThan(2 * Math.PI);
  });

  it('accepts a custom cage (tetrahedron) and rotation', () => {
    const { e } = created(empty, {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      faces: [
        [0, 2, 1],
        [0, 1, 3],
        [0, 3, 2],
        [1, 2, 3],
      ],
      levels: 0,
      rotation: [0, 0, Math.PI / 2],
      id: 'tet',
    });
    expect(e.id).toBe('tet');
    expect(e.rotation[2]).toBeCloseTo(Math.PI / 2);
    expect(solidTriangles(e)).toHaveLength(4);
  });

  it.each([
    [{}, 'exactly one of box, cylinder'],
    [{ box: { size: [1, 1, 1] }, cylinder: { radius: 1, height: 1 } }, 'exactly one of'],
    [{ vertices: [[0, 0, 0]] }, 'needs both vertices and faces'],
    [{ box: { size: [1, 0, 1] } }, 'size must be > 0'],
    [{ box: { size: [1, 1, 1], segments: [0, 1, 1] } }, 'segments must be integers'],
    [{ cylinder: { radius: 0, height: 1 } }, 'radius and height must be > 0'],
    [{ cylinder: { radius: 1, height: 1, sides: 2 } }, 'sides must be 3..64'],
    [{ box: { size: [1, 1, 1] }, levels: 5 }, 'levels must be an integer 0..4'],
    [{ box: { size: [1, 1, 1] }, creases: [[0, 7]] }, 'not an edge'],
    [{ box: { size: [1, 1, 1], segments: [32, 32, 32] } }, 'max 2000'],
  ])('rejects bad input (%#)', (params, text) => {
    expectNoOp(run(empty, 'add_subdivision_solid', params), empty, text);
  });

  it('stores each crease once', () => {
    const { e } = created(empty, {
      box: { size: [1, 1, 1] },
      creases: [
        [0, 1],
        [1, 0],
        [0, 1],
      ],
    });
    expect(e.creases).toEqual([[0, 1]]);
  });

  it('rejects a duplicate explicit id and is pure', () => {
    const { doc } = created(empty, { box: { size: [1, 1, 1] }, id: 'S' });
    expectNoOp(
      run(doc, 'add_subdivision_solid', { box: { size: [1, 1, 1] }, id: 'S' }),
      doc,
      'already exists',
    );
    const snapshot = JSON.stringify(doc);
    run(doc, 'add_subdivision_solid', { box: { size: [1, 1, 1] } });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('scales, round-trips and refuses corrupt saved cages', () => {
    const { doc, e } = created(empty, { box: { size: [2, 2, 2] }, levels: 1 });
    const big = run(doc, 'scale_entity', { id: e.id, factor: 2 }).document.entities[
      e.id
    ] as SubdivisionEntity;
    expect(big.vertices[0]).toEqual([-2, -2, 2]);
    const loaded = run(empty, 'load_document', { json: serializeDocument(doc) });
    expect(loaded.document.entities[e.id]).toEqual(e);
    for (const corrupt of [
      { vertices: [[0, 0]] },
      { faces: [[0, 'x']] },
      { creases: [[0]] },
      { levels: 9 },
      { faces: e.faces.slice(1) },
    ]) {
      const bad = { ...doc, entities: { [e.id]: { ...e, ...corrupt } as unknown as Entity } };
      const result = run(empty, 'load_document', { json: serializeDocument(bad) });
      expect(result.summary, JSON.stringify(corrupt)).toContain('subdivision');
      expect(result.document).toBe(empty);
    }
  });
});

describe('edit_subdivision_cage', () => {
  const base = created(empty, { box: { size: [4, 2, 2], segments: [4, 1, 1] }, levels: 2 });

  it('moves a world region with soft falloff', () => {
    const result = run(base.doc, 'edit_subdivision_cage', {
      id: base.e.id,
      region: { min: [1.5, -5, -5], max: [5, 5, 5] },
      falloff: 2.5,
      translate: [0, 0, 1],
    });
    expect(result.affected).toEqual([base.e.id]);
    expect(result.summary).toContain('4 vertex(es) selected (+');
    const e = result.document.entities[base.e.id] as SubdivisionEntity;
    const lift = (x: number): number =>
      Math.max(
        ...e.vertices
          .map((p, v) => [p, base.e.vertices[v] as Vec3] as const)
          .filter(([, q]) => q[0] === x)
          .map(([p, q]) => p[2] - q[2]),
      );
    expect(lift(2)).toBeCloseTo(1);
    expect(lift(1)).toBeGreaterThan(0);
    expect(lift(1)).toBeLessThan(1);
    expect(lift(-2)).toBe(0);
    expect((result.data as { selected: number[] }).selected).toHaveLength(4);
  });

  it('scales indices about their centre, creases and uncreases, changes levels', () => {
    const tail = base.e.vertices.flatMap((p, v) => (p[0] === -2 ? [v] : []));
    const narrowed = run(base.doc, 'edit_subdivision_cage', {
      id: base.e.id,
      vertexIndices: tail,
      scale: [1, 0.5, 0.5],
      crease: true,
      levels: 3,
    });
    const e = narrowed.document.entities[base.e.id] as SubdivisionEntity;
    expect(e.levels).toBe(3);
    expect(e.creases).toHaveLength(4);
    for (const v of tail) expect(Math.abs((e.vertices[v] as Vec3)[1])).toBeCloseTo(0.5);
    const smooth = run(narrowed.document, 'edit_subdivision_cage', {
      id: base.e.id,
      vertexIndices: tail,
      crease: false,
    });
    expect((smooth.document.entities[base.e.id] as SubdivisionEntity).creases).toHaveLength(0);
  });

  it('leaves the cage vertices untouched when only levels or creases change', () => {
    const turned = created(empty, { box: { size: [1.7, 0.3, 0.1] }, rotation: [0.3, 0.2, 0.1] });
    const result = run(turned.doc, 'edit_subdivision_cage', {
      id: turned.e.id,
      levels: 1,
      crease: true,
    });
    const e = result.document.entities[turned.e.id] as SubdivisionEntity;
    expect(e.vertices).toBe(turned.e.vertices);
    expect(e.levels).toBe(1);
    expect(e.creases).toHaveLength(12);
  });

  it('selects everything by default, honours a pivot and a rotated solid', () => {
    const turned = created(empty, {
      box: { size: [2, 2, 2] },
      rotation: [0, 0, Math.PI / 2],
      position: [5, 0, 0],
    });
    const moved = run(turned.doc, 'edit_subdivision_cage', {
      id: turned.e.id,
      translate: [1, 0, 0],
      scale: [2, 1, 1],
      pivot: [5, 0, 0],
    });
    const data = moved.data as { vertices: Vec3[]; selected: number[] };
    expect(data.selected).toHaveLength(8);
    const xs = data.vertices.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(5);
    expect(Math.max(...xs)).toBeCloseTo(7);
    const ys = data.vertices.map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(2);
  });

  it('grows the selection by falloff from picked vertices', () => {
    const result = run(base.doc, 'edit_subdivision_cage', {
      id: base.e.id,
      vertexIndices: [0],
      falloff: 1.5,
      translate: [0, 0, -1],
    });
    expect(result.summary).toMatch(/1 vertex\(es\) selected \(\+\d+ by falloff\)/);
  });

  it.each([
    [{ id: 'nope', levels: 1 }, "no entity 'nope'"],
    [{ levels: 1 }, 'not a subdivision solid'],
    [{}, 'give at least one of'],
    [{ vertexIndices: [0], region: { min: [0, 0, 0], max: [1, 1, 1] }, levels: 1 }, 'not both'],
    [{ vertexIndices: [99], translate: [0, 0, 1] }, 'outside 0..'],
    [{ falloff: -1, translate: [0, 0, 1] }, 'falloff must be >= 0'],
    [{ scale: [1, 0, 1] }, 'scale factors must be > 0'],
    [{ levels: 7 }, 'levels must be an integer'],
    [
      { region: { min: [50, 50, 50], max: [60, 60, 60] }, translate: [0, 0, 1] },
      'selection is empty',
    ],
  ])('rejects bad edits (%#)', (params, text) => {
    const withBox = run(base.doc, 'add_box', { size: [1, 1, 1] });
    const boxId = withBox.affected[0] as string;
    const id = text === 'not a subdivision solid' ? boxId : base.e.id;
    expectNoOp(
      run(withBox.document, 'edit_subdivision_cage', { id, ...params }),
      withBox.document,
      text,
    );
  });

  it('is pure', () => {
    const snapshot = JSON.stringify(base.doc);
    run(base.doc, 'edit_subdivision_cage', { id: base.e.id, translate: [1, 1, 1], crease: true });
    expect(JSON.stringify(base.doc)).toBe(snapshot);
  });
});
