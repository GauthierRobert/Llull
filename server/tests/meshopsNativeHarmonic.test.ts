/**
 * DES-7c (TECHNICAL_SPEC 13.26): the native `harmonic_map` of `llull-compute meshops` against the TypeScript engine (`harmonicMap`), which is the oracle. The parameters must be equal
 * bit for bit (the job runs the same operation order and the V8 twins of hypot / atan2), the reports equal, the refusals the same code and text, for the cotangent solve, the mean-value
 * fallback and the starved budget. Native runs need llull-compute (cargo build in solver/) and are skipped otherwise.
 */

import { describe, expect, it } from 'vitest';
import type { HarmonicResult, MeshEngineFailure, MeshOp } from '@core/geometry/mesh/engineTypes';
import { isEngineFailure } from '@core/geometry/mesh/engineTypes';
import { tsMeshEngine } from '@core/geometry/mesh/tsEngine';
import type { MeshData } from '@core/model/types';
import { _clearResultCache, resolveDeferred } from '../src/native/deferredRun';
import { createNativeMeshEngine } from '../src/native/meshProcessingEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { gridMesh, icosphere } from '../../tests/helpers/meshFixtures';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('meshopsNativeHarmonic: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeMeshEngine({ binary: BINARY });
const nativeEngine = (): NonNullable<typeof engine> => engine as NonNullable<typeof engine>;

type HarmonicOp = Extract<MeshOp, { op: 'harmonic_map' }>;
const op = (extra: Partial<HarmonicOp> = {}): HarmonicOp => ({ op: 'harmonic_map', ...extra });

/** The upper hemisphere of an icosphere: a disk with the equator as its boundary. */
function hemisphere(level: number): MeshData {
  const sphere = icosphere(10, level);
  const indices: number[] = [];
  for (let t = 0; t < sphere.indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) => sphere.indices[t + k] as number);
    if (corners.every((v) => (sphere.positions[3 * v + 2] as number) > -1e-9)) indices.push(...corners);
  }
  return { positions: sphere.positions, indices };
}

/** A C-shaped, jittered, uneven grid (a slit from the right edge): a disk whose exact cotangent weights flip triangles (the mean-value fallback). */
function cShape(seed: number): MeshData {
  let state = seed;
  const random = (): number => ((state = (state * 1103515245 + 12345) % 2147483648), state / 2147483648);
  const n = 8;
  const positions: number[] = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) positions.push(i + (random() - 0.5) * 0.9 * (i % 2 ? 1 : 0.2), j * (0.2 + 0.8 * random()), 0);
  const id = (i: number, j: number): number => j * (n + 1) + i;
  const indices: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      if (i >= 2 && j >= 3 && j < 5) continue;
      indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  return { positions, indices };
}

/** A jittered grid with a random-ish uneven spacing, big enough for hundreds of iterations. */
function jittered(n: number): MeshData {
  const base = gridMesh(10, n);
  let state = 7;
  const random = (): number => ((state = (state * 1103515245 + 12345) % 2147483648), state / 2147483648);
  return { positions: base.positions.map((v, i) => (i % 3 === 2 ? v : v + (random() - 0.5) * 0.25 * (10 / n))), indices: base.indices };
}

async function both(
  mesh: MeshData,
  extra: Partial<HarmonicOp> = {},
): Promise<{ ts: HarmonicResult | MeshEngineFailure; nat: HarmonicResult | MeshEngineFailure }> {
  _clearResultCache();
  const [ts, nat] = [tsMeshEngine.run({ mesh }, op(extra)), await resolveDeferred(() => nativeEngine().run({ mesh }, op(extra)))];
  const unwrap = (answer: typeof ts): HarmonicResult | MeshEngineFailure =>
    isEngineFailure(answer) ? answer : (answer.harmonic as HarmonicResult);
  return { ts: unwrap(ts), nat: unwrap(nat) };
}

describe('native harmonic_map is bit-identical to the TypeScript engine (13.26)', () => {
  native('cotangent weights: a jittered grid and a hemisphere give the same parameters bit for bit', async () => {
    for (const [label, mesh] of [
      ['jittered 24', jittered(24)],
      ['hemisphere 4', hemisphere(4)],
      ['grid 12', gridMesh(10, 12)],
    ] as const) {
      const { ts, nat } = await both(mesh);
      expect(isEngineFailure(ts), label).toBe(false);
      expect(nat, label).toEqual(ts);
      expect((ts as HarmonicResult).weights, label).toBe('cotangent');
      expect((ts as HarmonicResult).cgIterations, label).toBeGreaterThan(10);
    }
  });

  native('the mean-value fallback (the exact weights flip a triangle): the same map, weights, flipped count and corners', async () => {
    let fallbacks = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { ts, nat } = await both(cShape(seed));
      expect(nat, `seed ${seed}`).toEqual(ts);
      if (!isEngineFailure(ts) && ts.weights === 'mean_value') {
        fallbacks++;
        expect(ts.flippedFirst).toBeGreaterThan(0);
      }
    }
    expect(fallbacks).toBeGreaterThan(0);
  });

  native(
    'refusals carry the same code and text: closed, holes, pieces, a duplicate triangle, a starved budget, too few boundary vertices',
    async () => {
      const grid = gridMesh(10, 6);
      const cells = (keep: (i: number, j: number) => boolean): number[] =>
        Array.from({ length: grid.indices.length / 6 }, (_, c) => c)
          .filter((c) => keep(c % 6, Math.floor(c / 6)))
          .flatMap((c) => [...grid.indices.slice(6 * c, 6 * c + 6)]);
      const cases: Array<[string, MeshData, Partial<HarmonicOp>]> = [
        ['closed sphere', icosphere(10, 2), {}],
        ['annulus', { positions: grid.positions, indices: cells((i, j) => !(i >= 2 && i < 4 && j >= 2 && j < 4)) }, {}],
        ['two pieces', { positions: grid.positions, indices: cells((i) => i < 2 || i >= 4) }, {}],
        ['duplicate triangle', { positions: grid.positions, indices: [...grid.indices, ...grid.indices.slice(0, 3)] }, {}],
        ['starved budget', cShape(1), { maxIterations: 2 }],
        ['one triangle', { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }, {}],
      ];
      for (const [label, mesh, extra] of cases) {
        const { ts, nat } = await both(mesh, extra);
        expect(isEngineFailure(ts), `${label}: the oracle refuses`).toBe(true);
        expect(nat, label).toEqual(ts);
      }
    },
  );
});
