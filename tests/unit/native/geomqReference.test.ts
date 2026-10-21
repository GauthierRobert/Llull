/**
 * TypeScript reference of `llull-compute geomq` (RS1 RS-6; VC-FPR-37 and VC-THM-64 at crate level, RS1 §2 rule 4): seeded noisy meshes with
 * placed distance queries and rays (meshBvh), an obstructed cavity's exchange matrix (viewFactorExchangeReference) and V8 Math.atan samples,
 * written to solver/crates/llull-geomq/tests/fixtures/geomq.json. `cargo test -p llull-geomq` must reproduce every number bit for bit.
 * Infinity bounds and misses are written as null. Regenerate with LLULL_WRITE_NATIVE_FIXTURES=1.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MeshData, Vec3 } from '@core/model/types';
import type { RigidTransform } from '@core/geometry/meshBvh';
import { meshBvhEngine } from '@core/geometry/geometryQueries';
import { planarFacets } from '@cae/thermal/planarFacets';
import type { Facet } from '@cae/thermal/viewFactorContour';
import { viewFactorExchangeReference } from '@cae/thermal/viewFactorExchange';
import { seeded } from '../cae/gridMesh';

const FIXTURE = path.resolve(__dirname, '../../../solver/crates/llull-geomq/tests/fixtures/geomq.json');
const WRITE = process.env['LLULL_WRITE_NATIVE_FIXTURES'] === '1';

/** Closed latitude-longitude sphere of `rings` x `segments` quads, radius jittered per vertex by up to `noise`. */
function noisySphere(random: () => number, center: Vec3, radius: number, rings: number, segments: number, noise: number): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const polar = (Math.PI * i) / rings;
    for (let j = 0; j < segments; j++) {
      const azimuth = (2 * Math.PI * j) / segments;
      const r = radius * (1 + noise * (random() - 0.5));
      positions.push(
        center[0] + r * Math.sin(polar) * Math.cos(azimuth),
        center[1] + r * Math.sin(polar) * Math.sin(azimuth),
        center[2] + r * Math.cos(polar),
      );
    }
  }
  const at = (i: number, j: number): number => i * segments + (j % segments);
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
  }
  return { positions, indices };
}

/** The TS `trianglesOf` layout the native job reads: 9 corners per triangle. */
const cornersOf = (mesh: MeshData): number[] =>
  mesh.indices.flatMap((vertex) => [
    mesh.positions[vertex * 3] ?? 0,
    mesh.positions[vertex * 3 + 1] ?? 0,
    mesh.positions[vertex * 3 + 2] ?? 0,
  ]);

/** Rotation from a random unit quaternion + a random translation in [-span, span]^3. */
function randomPlacement(random: () => number, span: number): RigidTransform {
  const q = [random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5];
  const n = Math.hypot(...q);
  const [w, x, y, z] = q.map((v) => v / n) as [number, number, number, number];
  return {
    rotation: [
      1 - 2 * (y * y + z * z),
      2 * (x * y - w * z),
      2 * (x * z + w * y),
      2 * (x * y + w * z),
      1 - 2 * (x * x + z * z),
      2 * (y * z - w * x),
      2 * (x * z - w * y),
      2 * (y * z + w * x),
      1 - 2 * (x * x + y * y),
    ],
    translation: [(random() - 0.5) * 2 * span, (random() - 0.5) * 2 * span, (random() - 0.5) * 2 * span],
  };
}

const finiteOrNull = (value: number): number | null => (Number.isFinite(value) ? value : null);

function distanceCases(): unknown {
  const random = seeded(606);
  const meshes = [
    noisySphere(random, [0, 0, 0], 10, 12, 18, 0.3),
    noisySphere(random, [4, 1, 0], 6, 8, 14, 0.5),
    noisySphere(random, [0, 0, 0], 3, 4, 6, 0),
  ];
  const queries = Array.from({ length: 60 }, (_, k) => ({
    a: k % 3,
    b: (k * 7 + 1) % 3,
    placement: k % 5 === 0 ? null : randomPlacement(random, 25),
    maxDistance: k % 4 === 0 ? Infinity : random() * 12,
  }));
  const results = meshBvhEngine.placedDistanceBatch(meshes, queries);
  return {
    meshes: meshes.map(cornersOf),
    queries: queries.map((query) => ({ ...query, maxDistance: finiteOrNull(query.maxDistance) })),
    results,
  };
}

function rayCases(): unknown {
  const random = seeded(4242);
  const mesh = noisySphere(random, [1, -2, 0.5], 8, 14, 20, 0.4);
  const rays = Array.from({ length: 200 }, (_, k) => {
    const origin: Vec3 = [(random() - 0.5) * 20, (random() - 0.5) * 20, (random() - 0.5) * 20];
    const direction: Vec3 = k % 7 === 0 ? [0, 0, 1] : [random() - 0.5, random() - 0.5, random() - 0.5];
    return { origin, direction, tMin: k % 3 === 0 ? 0 : 1e-6 * k, maxT: k % 2 === 0 ? Infinity : random() * 30 };
  });
  const results = rays.map((ray) => meshBvhEngine.rayCastBatch(mesh, [ray], ray.maxT)[0] ?? null);
  return { mesh: cornersOf(mesh), rays: rays.map((ray) => ({ ...ray, maxT: finiteOrNull(ray.maxT) })), results };
}

/** Unit cube cavity (inward-emitting faces) with a tilted internal baffle: obstruction by facets of other surfaces and by a blocker. */
function viewFactorCase(): unknown {
  const square = (corners: Vec3[]): readonly Facet[] => planarFacets(corners, false, 0.5)?.facets ?? [];
  const surfaces: (readonly Facet[])[] = [
    square([
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ]),
    square([
      [0, 0, 1],
      [0, 1, 1],
      [1, 1, 1],
      [1, 0, 1],
    ]),
    square([
      [0, 0, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 0, 0],
    ]),
    square([
      [0, 1, 0],
      [1, 1, 0],
      [1, 1, 1],
      [0, 1, 1],
    ]),
    square([
      [0.3, 0.2, 0.45],
      [0.8, 0.25, 0.5],
      [0.75, 0.8, 0.55],
      [0.25, 0.75, 0.5],
    ]),
  ];
  const blockers = square([
    [0.1, 0.45, 0.2],
    [0.1, 0.55, 0.8],
    [0.9, 0.5, 0.8],
    [0.9, 0.4, 0.2],
  ]);
  const flat = (facets: readonly Facet[], surface: number): number[][] =>
    facets.map((f) => [surface, ...f.corners.flat(), ...f.normal, ...f.centroid, f.area]);
  return {
    surfaces: surfaces.length,
    facets: [...surfaces.flatMap((facets, surface) => flat(facets, surface)), ...flat(blockers, -1)],
    open: viewFactorExchangeReference(meshBvhEngine, surfaces, null),
    obstructed: viewFactorExchangeReference(meshBvhEngine, surfaces, blockers),
  };
}

function atanCases(): number[][] {
  const random = seeded(31);
  const xs = [0, -0, 1e-30, 1e-8, 0.4375, 0.6875, 1.1875, 2.4375, 1e20, 1e300, -1e300, 0.5, 1, -1, Infinity, -Infinity];
  for (let i = 0; i < 400; i++) xs.push((random() - 0.5) * 6, (random() - 0.5) * 1e3, Math.tan((random() - 0.5) * Math.PI));
  return xs.filter(Number.isFinite).map((x) => [x, Math.atan(x)]);
}

describe('llull-geomq native reference fixture (TS = oracle)', () => {
  it('placed distances, rays, view-factor exchange and atan for llull-geomq', () => {
    const fixture = { distance: distanceCases(), ray: rayCases(), viewFactor: viewFactorCase(), atan: atanCases() };
    const text = `${JSON.stringify(fixture)}\n`;
    if (WRITE) writeFileSync(FIXTURE, text);
    expect(readFileSync(FIXTURE, 'utf8') === text, 'geomq.json is out of date: run with LLULL_WRITE_NATIVE_FIXTURES=1').toBe(true);
  });
});
