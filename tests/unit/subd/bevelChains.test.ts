/** 04 DIR §5.3.1: bevel_cage_edges across vertex chains and corners: closed forms, the vertex patch, symmetry, sharpness, every subset of the cube's edges, refusals. */

import { describe, expect, it } from 'vitest';
import { type CadDocument, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { cageProblem } from '@core/geometry/subdivision';
import { cageState } from '@core/geometry/subd/cageState';
import { bevelEdges, isBevelProblem } from '@core/geometry/subd/bevel';
import { buildTopology } from '@core/geometry/subd/topology';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const run = (doc: CadDocument, name: string, params: object): ReturnType<typeof execute> =>
  execute(doc, name, params as Record<string, unknown>);
const entityOf = (doc: CadDocument, id: string): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;
const add = (params: object): { doc: CadDocument; id: string; e: SubdivisionEntity } => {
  const result = run(createEmptyDocument(), 'add_subdivision_solid', params);
  expect(result.affected, result.summary).toHaveLength(1);
  const id = result.affected[0] as string;
  return { doc: result.document, id, e: entityOf(result.document, id) };
};
const at = (e: SubdivisionEntity, p: Vec3): number => e.vertices.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-9);
const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;

/** Euler characteristic and whether every directed edge has exactly one face and a reverse (a closed, consistently wound manifold, no vertex used twice by a face). */
function shape(
  faces: ReadonlyArray<ReadonlyArray<number>>,
  vertexCount: number,
): { V: number; E: number; F: number; euler: number; closed: boolean; used: number } {
  const directed = new Map<string, number>();
  let closed = true;
  for (const face of faces) {
    if (new Set(face).size !== face.length) closed = false;
    face.forEach((a, i) => {
      const key = `${a}>${face[(i + 1) % face.length]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    });
  }
  for (const [key, count] of directed) {
    const [a, b] = key.split('>');
    if (count !== 1 || !directed.has(`${b}>${a}`)) closed = false;
  }
  const edges = directed.size / 2;
  return { V: vertexCount, E: edges, F: faces.length, euler: vertexCount - edges + faces.length, closed, used: new Set(faces.flat()).size };
}
const shapeOf = (e: SubdivisionEntity): ReturnType<typeof shape> => shape(e.faces, e.vertices.length);

const cube = add({ box: { size: [2, 2, 2] }, levels: 2 });
const corner = at(cube.e, [1, 1, 1]);
const neighbours = [at(cube.e, [-1, 1, 1]), at(cube.e, [1, -1, 1]), at(cube.e, [1, 1, -1])];
const bevel = (doc: CadDocument, id: string, edges: Array<[number, number]>, extra: object = {}): ReturnType<typeof execute> =>
  run(doc, 'bevel_cage_edges', { id, edges, width: 0.25, ...extra });

describe('bevel_cage_edges across vertex chains', () => {
  it('a cube corner with all three edges bevelled: a triangle patch, closed and manifold, V 13 E 21 F 10', () => {
    const result = bevel(
      cube.doc,
      cube.id,
      neighbours.map((n): [number, number] => [corner, n]),
    );
    expect(result.error, result.summary).toBeUndefined();
    const e = entityOf(result.document, cube.id);
    // closed form: the corner (-1), one point per face at it (+3), and the far ends of the three edges (valence 3: -1 + 2 each); 3 strips + 1 triangle
    expect(shapeOf(e)).toEqual({ V: 13, E: 21, F: 10, euler: 2, closed: true, used: 13 });
    expect(cageProblem(e)).toBeNull();
    // the corner points are the parallelogram completions, and they are the corners of the one triangle patch
    const points: Vec3[] = [
      [0.5, 0.5, 1],
      [0.5, 1, 0.5],
      [1, 0.5, 0.5],
    ];
    const ids = points.map((p) => at(e, p));
    expect(ids.every((id) => id >= 0)).toBe(true);
    const triangles = e.faces.filter((face) => face.length === 3 && ids.every((id) => face.includes(id)));
    expect(triangles).toHaveLength(1);
    expect(at(e, [1, 1, 1])).toBe(-1);
    expect(result.summary).toContain('3 edge(s) bevelled');
  });

  it('segments 2 at the corner: a hexagon patch, still closed with Euler 2', () => {
    const result = bevel(
      cube.doc,
      cube.id,
      neighbours.map((n): [number, number] => [corner, n]),
      { segments: 2 },
    );
    const e = entityOf(result.document, cube.id);
    const cornerPoints: Vec3[] = [
      [0.5, 0.5, 1],
      [0.5, 1, 0.5],
      [1, 0.5, 0.5],
    ];
    const ids = cornerPoints.map((p) => at(e, p));
    expect(ids.every((id) => id >= 0)).toBe(true);
    const patch = e.faces.filter((face) => face.length === 6 && ids.every((id) => face.includes(id)));
    expect(patch).toHaveLength(1);
    expect(shapeOf(e)).toMatchObject({ euler: 2, closed: true });
    expect(cageProblem(e)).toBeNull();
  });

  it('a chain of two edges through a valence-3 vertex: no patch face (the two strips meet), V 11 E 17 F 8', () => {
    const b = at(cube.e, [1, 1, 1]);
    const result = bevel(cube.doc, cube.id, [
      [b, neighbours[0] as number],
      [b, neighbours[1] as number],
    ]);
    const e = entityOf(result.document, cube.id);
    expect(shapeOf(e)).toEqual({ V: 11, E: 17, F: 8, euler: 2, closed: true, used: 11 });
    expect(cageProblem(e)).toBeNull();
  });

  it('the three edges of the top face (a loop around it): closed manifold, the face shrinks inside the strips', () => {
    const top = [at(cube.e, [-1, -1, 1]), at(cube.e, [1, -1, 1]), at(cube.e, [1, 1, 1]), at(cube.e, [-1, 1, 1])];
    const ring = top.map((v, i): [number, number] => [v, top[(i + 1) % 4] as number]);
    const result = bevel(cube.doc, cube.id, ring);
    expect(result.error, result.summary).toBeUndefined();
    const e = entityOf(result.document, cube.id);
    expect(shapeOf(e)).toMatchObject({ euler: 2, closed: true });
    expect(cageProblem(e)).toBeNull();
    expect(e.vertices.every((p) => p.every(Number.isFinite))).toBe(true);
  });

  it('every subset of the 12 cube edges (4095 of them) gives a closed consistently wound manifold of Euler characteristic 2 with every vertex used', () => {
    const state0 = cageState(cube.e);
    const topology = buildTopology(state0.vertices.length, state0.faces);
    const edges = topology.edges.map((edge): [number, number] => [edge.a, edge.b]);
    expect(edges).toHaveLength(12);
    let failures = 0;
    let first = '';
    for (let mask = 1; mask < 1 << 12; mask++) {
      const state = cageState(cube.e);
      const chosen = edges.filter((_, i) => (mask >> i) & 1);
      const result = bevelEdges(state, topology, chosen, 0.25, 1 + (mask % 3), 0);
      if (isBevelProblem(result)) {
        failures++;
        first ||= `mask ${mask}: ${result.code} ${result.message}`;
        continue;
      }
      const s = shape(state.faces, state.vertices.length);
      if (!s.closed || s.euler !== 2 || s.used !== s.V) {
        failures++;
        first ||= `mask ${mask}: ${JSON.stringify(s)}`;
      }
    }
    expect(failures, first).toBe(0);
  });

  it('a valence-4 vertex of a grid: four bevelled edges give a quad patch, two adjacent ones a corner, two opposite ones a straight crossing; all stay closed', () => {
    const grid = add({ box: { size: [2, 2, 2], segments: [2, 2, 2] }, levels: 1 });
    const centre = at(grid.e, [0, 0, 1]);
    const around = [at(grid.e, [1, 0, 1]), at(grid.e, [0, 1, 1]), at(grid.e, [-1, 0, 1]), at(grid.e, [0, -1, 1])];
    const spokes = around.map((w): [number, number] => [centre, w]);
    for (const [label, chosen] of [
      ['four spokes', spokes],
      ['three spokes', spokes.slice(0, 3)],
      ['two adjacent', spokes.slice(0, 2)],
      ['two opposite', [spokes[0], spokes[2]] as Array<[number, number]>],
    ] as const) {
      const result = bevel(grid.doc, grid.id, [...chosen]);
      expect(result.error, `${label}: ${result.summary}`).toBeUndefined();
      const e = entityOf(result.document, grid.id);
      expect(shapeOf(e), label).toMatchObject({ euler: 2, closed: true });
      expect(cageProblem(e), label).toBeNull();
    }
    const four = shapeOf(entityOf(bevel(grid.doc, grid.id, spokes).document, grid.id));
    const base = shapeOf(grid.e);
    // 4 strips, the quad patch at the centre and a patch at each far end (valence 4), the centre gone and 4 corner points added, each far end split in two and kept
    expect(four.F - base.F).toBe(4 + 1 + 4);
    expect(four.V - base.V).toBe(-1 + 4 + 4 * 2);
  });

  it('keeps the sharpness of the edges it splits and gives the long edges of every strip `sharp`', () => {
    const creased = run(cube.doc, 'edit_subdivision_cage', { id: cube.id, crease: true });
    const result = bevel(
      creased.document,
      cube.id,
      neighbours.map((n): [number, number] => [corner, n]),
      { sharp: 6 },
    );
    const e = entityOf(result.document, cube.id);
    expect(e.edgeSharpness?.filter((entry) => entry.s === 6).length).toBe(6);
    expect(e.creases.length).toBeGreaterThan(0);
    expect(cageProblem(e)).toBeNull();
  });

  it('a symmetric cage bevels the mirror corner too: both corners of the +x face get their patch', () => {
    const sym = run(cube.doc, 'set_cage_symmetry', { id: cube.id, planes: ['x'] });
    const result = bevel(
      sym.document,
      cube.id,
      neighbours.map((n): [number, number] => [corner, n]),
    );
    expect(result.error, result.summary).toBeUndefined();
    const e = entityOf(result.document, cube.id);
    expect(e.symmetry).toBeDefined();
    expect(shapeOf(e)).toMatchObject({ euler: 2, closed: true });
    // two corners: V 8 - 2 + 6 + 2 x 3 (the edge between the two corners is bevelled once: its two ends are the corners)
    expect(e.faces.filter((face) => face.length === 3)).toHaveLength(2);
    expect(at(e, [-0.5, 0.5, 1])).toBeGreaterThanOrEqual(0);
  });

  it('is pure; refuses by name a corner it cannot patch: valence over 4, the boundary of an open cage', () => {
    expectPure(cube.doc, () =>
      bevel(cube.doc, cube.id, [
        [corner, neighbours[0] as number],
        [corner, neighbours[1] as number],
      ]),
    );
    // a pentagonal pyramid: the apex has valence 5
    const ring = Array.from({ length: 5 }, (_, i): Vec3 => [Math.cos((2 * Math.PI * i) / 5), Math.sin((2 * Math.PI * i) / 5), 0]);
    const pyramid = add({
      vertices: [...ring, [0, 0, 1]],
      faces: [...ring.map((_, i) => [i, (i + 1) % 5, 5]), [4, 3, 2, 1, 0]],
      creases: [],
      levels: 1,
    });
    const apex = 5;
    const tall = bevel(pyramid.doc, pyramid.id, [
      [apex, 0],
      [apex, 1],
    ]);
    expect(code(tall)).toBe('DIR_BEVEL_CORNER_UNSUPPORTED');
    expect(tall.summary).toContain('valence 5');
    expectNoOp(tall, pyramid.doc);
    // one bevelled edge at the valence-5 apex is the old single-edge case and still works
    expect(bevel(pyramid.doc, pyramid.id, [[apex, 0]]).error).toBeUndefined();
    // a vertex of valence 4 on the rim of a deleted face: two interior spokes cannot cross it
    const grid = add({ box: { size: [2, 2, 2], segments: [2, 2, 2] }, levels: 1 });
    const centre = at(grid.e, [0, 0, 1]);
    const spokes = [at(grid.e, [1, 0, 1]), at(grid.e, [0, 1, 1]), at(grid.e, [-1, 0, 1]), at(grid.e, [0, -1, 1])];
    const deleted = run(grid.doc, 'delete_cage_faces', { id: grid.id, faces: [grid.e.faces.findIndex((face) => face.includes(centre))] });
    const codes = new Set<string | undefined>();
    for (const [i, w] of spokes.entries())
      for (const x of spokes.slice(i + 1))
        codes.add(
          code(
            bevel(deleted.document, grid.id, [
              [centre, w],
              [centre, x],
            ]),
          ),
        );
    expect(codes.has('DIR_BEVEL_CORNER_UNSUPPORTED')).toBe(true);
    expect([...codes].every((c) => c === 'DIR_BEVEL_CORNER_UNSUPPORTED' || c === 'DIR_BEVEL_BOUNDARY')).toBe(true);
  });
});
