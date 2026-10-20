import { describe, expect, it } from 'vitest';
import type { CompositePart } from '@core/model/composites';
import type { MeshSolidEntity, Vec2 } from '@core/model/types';
import { chartMesh } from '@aero/composites/chartMesh';
import { autoStepLength, interiorPoint } from '@aero/composites/drape/plyDrape';
import { meshVolume } from '@aero/composites/plySolid';
import { polygonArea } from '@lib/polygon';
import { apply, ok } from '../../../helpers/commandAssertions';
import { WOVEN, spherePart } from './drapeFixtures';

const square = (size: number, origin = 0): Vec2[] => [
  [origin, origin],
  [origin + size, origin],
  [origin + size, origin + size],
  [origin, origin + size],
];

/** Every directed edge of a closed mesh appears once and its reverse once. */
const isClosed = (triangles: readonly (readonly number[])[], boundaryAllowed: boolean): boolean => {
  const edges = new Map<string, number>();
  for (const [a, b, c] of triangles as [number, number, number][])
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const)
      edges.set(`${p}:${q}`, (edges.get(`${p}:${q}`) ?? 0) + 1);
  const unmatched = [...edges.keys()].filter((key) => !edges.has(key.split(':').reverse().join(':')));
  return [...edges.values()].every((count) => count === 1) && (boundaryAllowed || unmatched.length === 0);
};

const areaOf = (mesh: { uv: Vec2[]; triangles: [number, number, number][] }): number =>
  mesh.triangles.reduce((sum, [a, b, c]) => sum + polygonArea([mesh.uv[a] as Vec2, mesh.uv[b] as Vec2, mesh.uv[c] as Vec2]), 0);

describe('chartMesh', () => {
  it('meshes a polygon with a grid (conforming, area-exact) when refined, plainly otherwise', () => {
    const plain = chartMesh(square(100), [], 10, false);
    expect(plain?.triangles).toHaveLength(2);
    const fine = chartMesh(square(100), [], 10, true);
    expect(fine).not.toBeNull();
    expect(areaOf(fine as NonNullable<typeof fine>)).toBeCloseTo(10000, 6);
    expect(isClosed(fine?.triangles ?? [], true)).toBe(true);
    expect(fine?.triangles.length).toBeGreaterThan(100);
    const triangle = chartMesh(
      [
        [0, 0],
        [60, 0],
        [20, 50],
      ],
      [],
      8,
      true,
    );
    expect(areaOf(triangle as NonNullable<typeof triangle>)).toBeCloseTo(1500, 6);
  });

  it('clips cells to a concave outline', () => {
    const ell: Vec2[] = [
      [0, 0],
      [60, 0],
      [60, 20],
      [20, 20],
      [20, 60],
      [0, 60],
    ];
    const mesh = chartMesh(ell, [], 6, true);
    expect(areaOf(mesh as NonNullable<typeof mesh>)).toBeCloseTo(polygonArea(ell), 4);
  });

  it('refines a polygon with a hole by longest-edge bisection into a conforming mesh of the annulus', () => {
    const hole = square(40, 30).reverse();
    const mesh = chartMesh(square(100), [hole], 12, true);
    expect(mesh).not.toBeNull();
    expect(areaOf(mesh as NonNullable<typeof mesh>)).toBeCloseTo(10000 - 1600, 4);
    expect(isClosed(mesh?.triangles ?? [], true)).toBe(true);
    const longest = Math.max(
      ...(mesh?.triangles ?? []).flatMap(([a, b, c]) =>
        [
          [a, b],
          [b, c],
          [c, a],
        ].map(([p, q]) =>
          Math.hypot(
            (mesh?.uv[p as number] as Vec2)[0] - (mesh?.uv[q as number] as Vec2)[0],
            (mesh?.uv[p as number] as Vec2)[1] - (mesh?.uv[q as number] as Vec2)[1],
          ),
        ),
      ),
    );
    expect(longest).toBeLessThanOrEqual(12 + 1e-9);
    const unrefined = chartMesh(square(100), [hole], 12, false);
    expect(areaOf(unrefined as NonNullable<typeof unrefined>)).toBeCloseTo(8400, 6);
  });

  it('gives up on a polygon the ear clipper cannot triangulate', () => {
    expect(
      chartMesh(
        [
          [0, 0],
          [10, 0],
          [0, 0],
        ],
        [],
        5,
        false,
      ),
    ).toBeNull();
  });
});

describe('seed points and steps', () => {
  it('finds an interior point of a concave polygon whose centroid lies outside', () => {
    const horseshoe: Vec2[] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [80, 100],
      [80, 20],
      [20, 20],
      [20, 100],
      [0, 100],
    ];
    const point = interiorPoint(horseshoe);
    const inside = (p: Vec2): boolean =>
      (p[0] > 0 && p[0] < 20 && p[1] < 100) || (p[0] > 80 && p[0] < 100 && p[1] < 100) || (p[1] > 0 && p[1] < 20);
    expect(inside(point)).toBe(true);
    expect(interiorPoint(square(10))).toEqual([5, 5]);
  });

  it('takes the outline diagonal over 200 as the automatic fishnet step', () => {
    expect(autoStepLength({ outline: square(200) } as unknown as CompositePart)).toBeCloseTo(Math.hypot(200, 200) / 200, 12);
  });
});

describe('ply solids over holes on a curved face', () => {
  it('splits an upper ply over a smaller lower ply into the covered disc and the surrounding annulus', () => {
    const base = spherePart();
    const cap = (polar: number): [number, number][] =>
      Array.from({ length: 40 }, (_, k): [number, number] => [
        100 * ((polar * Math.PI) / 180) * Math.cos((2 * Math.PI * k) / 40),
        100 * ((polar * Math.PI) / 180) * Math.sin((2 * Math.PI * k) / 40),
      ]);
    let doc = apply(base.doc, 'add_ply', {
      part: base.part,
      name: 'Small',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'polygon', polygons: [cap(20)] },
    });
    doc = apply(doc, 'add_ply', {
      part: base.part,
      name: 'Large',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'polygon', polygons: [cap(40)] },
    });
    const result = ok(doc, 'create_ply_solids', { part: base.part, maxEdge: 6 });
    const solids = result.affected.map((id) => result.document.entities[id] as MeshSolidEntity);
    expect(solids.map((solid) => solid.name)).toEqual(['Small piece 1', 'Large piece 1.1', 'Large piece 1.2']);
    const volume = (solid: MeshSolidEntity): number => meshVolume(solid.mesh);
    const capArea = (polar: number): number => 2 * Math.PI * 100 * 100 * (1 - Math.cos((polar * Math.PI) / 180));
    expect(Math.abs(volume(solids[0] as MeshSolidEntity) / (capArea(20) * 0.25) - 1)).toBeLessThan(0.05);
    const large = volume(solids[1] as MeshSolidEntity) + volume(solids[2] as MeshSolidEntity);
    expect(Math.abs(large / (capArea(40) * 0.25) - 1)).toBeLessThan(0.05);
  });
});
