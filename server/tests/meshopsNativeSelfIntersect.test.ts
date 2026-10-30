/**
 * DES-7c step 7, slice 4: the pair search of the native `analyze` (`selfIntersections: true`) against the TypeScript engine, which is the oracle: the count and the
 * listed pairs must be equal, with the rest of the analysis, for meshes that cross themselves in every way the grid of the oracle treats differently (small faces, large
 * faces among small ones, shared vertices, contacts, degenerate and duplicate faces, unwelded soups). Native runs need llull-compute (cargo build in solver/).
 */

import { describe, expect, it } from 'vitest';
import type { MeshEngineFailure, MeshOp, MeshOpResult } from '@core/geometry/mesh/engineTypes';
import { isEngineFailure } from '@core/geometry/mesh/engineTypes';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import type { MeshData } from '@core/model/types';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { resolveDeferred } from '../src/native/deferredRun';
import { box, grid, icosphere, noisy } from './meshopsNativeSupport';
import { flipFaces, sideBySide, soupOf, stream } from './meshopsRepairSupport';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshopsNativeSelfIntersect: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeMeshEngine({ binary: BINARY });

const nativeRun = (mesh: MeshData, op: MeshOp): Promise<MeshOpResult | MeshEngineFailure> =>
  resolveDeferred(() => (engine as NonNullable<typeof engine>).run({ mesh }, op));

const analyze = (maxListed: number): MeshOp => ({ op: 'analyze', weldTolerance: 0, selfIntersections: true, maxListed });

/** Both engines: the identical analysis (count, pairs and everything else) and report. Returns the number of crossing pairs. */
async function expectSame(mesh: MeshData, maxListed = 20): Promise<number> {
  const op = analyze(maxListed);
  const ts = tsMeshEngine.run({ mesh }, op);
  const nat = await nativeRun(mesh, op);
  if (isEngineFailure(ts) || isEngineFailure(nat))
    throw new Error(`ts: ${JSON.stringify(ts).slice(0, 120)}; native: ${JSON.stringify(nat).slice(0, 120)}`);
  expect(nat.analysis).toEqual(ts.analysis);
  expect(nat.report).toEqual(ts.report);
  expect(nat.provenance).toMatchObject({ engine: 'native', algorithm: ts.provenance.algorithm });
  return nat.analysis?.selfIntersectionPairs ?? -1;
}

/** One big triangle in z = 0 and `count` small stakes through (or, every `touchEvery`-th, only up to) its plane. */
function stakes(count: number, touchEvery: number): MeshData {
  const positions = [-500, -500, 0, 500, -500, 0, 0, 500, 0];
  const indices = [0, 1, 2];
  for (let k = 0; k < count; k++) {
    const [x, y] = [(k % 11) * 2.5 - 12, Math.floor(k / 11) * 2.5 - 8];
    const base = positions.length / 3;
    positions.push(x, y, -1, x + 0.2, y, -1, x, y, k % touchEvery === 0 ? 0 : 1);
    indices.push(base, base + 1, base + 2);
  }
  return { positions, indices };
}

describe('native pair search is bit-identical to the TypeScript engine (DES-7c step 7, slice 4)', () => {
  const ball = icosphere(10, 3);

  native('interpenetrating spheres: the count and the lowest pairs, for every list length', async () => {
    const two = sideBySide([ball, noisy(icosphere(10, 3), 0.03)], 7);
    for (const maxListed of [0, 1, 5, 20, 1000]) expect(await expectSame(two, maxListed), `list ${maxListed}`).toBeGreaterThan(100);
    expect(await expectSame(sideBySide([ball, icosphere(6, 2), icosphere(3, 4)], 4), 7)).toBeGreaterThan(50);
  });

  native('a mesh that does not cross itself, shared edges and touching corners count none', async () => {
    expect(await expectSame(ball)).toBe(0);
    expect(await expectSame(box(10, 4))).toBe(0);
    expect(await expectSame(grid(10, 12, (x, y) => Math.sin(x) * Math.cos(y)))).toBe(0);
    expect(await expectSame(sideBySide([ball, ball], 20.0))).toBe(0);
    // two spheres touching at one point (the poles meet): a contact is not a crossing
    expect(await expectSame(sideBySide([icosphere(10, 2), icosphere(10, 2)], 20))).toBe(0);
  });

  native('a noisy sphere crosses itself near its vertices: many pairs found with the same ones listed', async () => {
    expect(await expectSame(noisy(icosphere(10, 4), 0.35), 50)).toBeGreaterThan(20);
    expect(await expectSame(noisy(icosphere(10, 5), 0.15), 10)).toBeGreaterThan(0);
  });

  native('large faces among small ones: stakes through one big triangle, contacts among them, two big triangles', async () => {
    expect(await expectSame(stakes(66, 11), 12)).toBe(60);
    expect(await expectSame(stakes(66, 1))).toBe(0);
    const bigPair: MeshData = {
      positions: [...stakes(40, 7).positions, -400, 0, -400, 400, 0, -400, 0, 0, 450],
      indices: [...stakes(40, 7).indices, 123, 124, 125],
    };
    expect(await expectSame(bigPair, 30)).toBeGreaterThan(30);
  });

  native('degenerate and duplicate faces, repeated corners, unused vertices, flipped faces and a soup of crossing shells', async () => {
    const two = sideBySide([ball, ball], 6);
    const faces = two.indices.length / 3;
    const damaged: MeshData = {
      positions: [...two.positions, 3, 3, 3, 4, 4, 4],
      indices: [...two.indices, 0, 0, 5, 7, 7, 7, ...two.indices.slice(60, 66), 1, 2, 2],
    };
    expect(faces).toBeGreaterThan(0);
    expect(await expectSame(damaged, 50)).toBeGreaterThan(0);
    expect(await expectSame(flipFaces(two, new Set([3, 4, 5, 700, 701])), 10)).toBeGreaterThan(0);
    // the soup: every copy of a vertex is welded back before the search
    expect(await expectSame(soupOf(two, 0, 3), 10)).toBeGreaterThan(0);
    expect(await expectSame(soupOf(two, 1e-3, 3), 10)).toBeGreaterThanOrEqual(0);
  });

  native('random triangle soups: boxes of every size overlapping, 20 cases', async () => {
    const next = stream(11);
    for (let c = 0; c < 20; c++) {
      const faces = 20 + Math.floor(next() * 200);
      const spread = [0.5, 2, 20][c % 3] as number;
      const positions: number[] = [];
      for (let f = 0; f < faces; f++) {
        const size = c % 4 === 0 && f % 17 === 0 ? 30 : 0.3 + next();
        const [cx, cy, cz] = [next() * spread, next() * spread, next() * spread];
        for (let k = 0; k < 3; k++) positions.push(cx + (next() - 0.5) * size, cy + (next() - 0.5) * size, cz + (next() - 0.5) * size);
      }
      await expectSame({ positions, indices: Array.from({ length: faces * 3 }, (_, i) => i) }, 25);
    }
  });

  native(
    'cells past 2^53: tiny faces beside faces far away end, and the count is the same (the oracle looped forever on them)',
    async () => {
      const next = stream(5);
      for (const far of [1e11, 1e15, 1e17, 1e20, 1e30]) {
        const positions: number[] = [];
        for (let k = 0; k < 60; k++) {
          const [x, y, z] = [next(), next(), next()];
          positions.push(x, y, z, x + 1e-3, y, z, x, y + 1e-3, z + 1e-3 * next());
        }
        // far faces large enough to be resolved at that magnitude, and one pair crossing like a plus
        const size = far * 1e-14;
        for (let k = 0; k < 6; k++) {
          const [x, y, z] = [far * (1 + next()), far * next(), far * next()];
          positions.push(x, y, z, x + size, y, z, x, y + size, z + size * next());
        }
        const [x, s] = [far * 3, far * 1e-13];
        positions.push(x, 0, 0, x + 2 * s, 0, 0, x + s, 0, 2 * s, x + s, -s, s / 2, x + s, s, s / 2, x + s, 0, 3 * s);
        const indices = Array.from({ length: positions.length / 3 }, (_, i) => i);
        expect(await expectSame({ positions, indices }, 10), `far ${far}`).toBe(1);
      }
    },
    120_000,
  );

  native(
    '81,920 triangles: a noisy sphere beside a copy of itself',
    async () => {
      const [a, b] = [noisy(icosphere(10, 6), 0.05), noisy(icosphere(10, 5), 0.05)];
      const offset = a.positions.length / 3;
      const mesh: MeshData = {
        positions: a.positions.concat(b.positions.map((v, i) => (i % 3 === 0 ? v + 9 : v))),
        indices: a.indices.concat(b.indices.map((v) => v + offset)),
      };
      expect(await expectSame(mesh, 20)).toBeGreaterThan(1000);
    },
    120_000,
  );
});
