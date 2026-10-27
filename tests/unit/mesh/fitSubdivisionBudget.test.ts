/** 07 MSH M6: the closest-point work cap stops a fit between rounds and keeps the best cage (stubs `SurfaceIndex.closest`, so the suite is isolated). */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORK_PER_QUERY, fitSubdivision } from '@core/geometry/mesh/subdFit';
import { SurfaceIndex } from '@core/geometry/mesh/surfaceIndex';
import { buildFitOperator } from '@core/geometry/subd/fitOperator';
import type { Vec3 } from '@core/model/types';
import { icosphere } from '../../helpers/meshFixtures';
import { quadSphere } from '../../helpers/quadFixtures';

afterEach(() => vi.restoreAllMocks());

describe('fitSubdivision work cap', () => {
  it('stops with stop "budget" when a later round exceeds the cap, keeps the best cage and still verifies it', () => {
    const q = quadSphere(10, 4);
    const cage = {
      vertices: Array.from(
        { length: q.positions.length / 3 },
        (_, i): Vec3 => [
          (q.positions[3 * i] as number) * 0.95,
          (q.positions[3 * i + 1] as number) * 0.95,
          (q.positions[3 * i + 2] as number) * 0.95,
        ],
      ),
      faces: Array.from({ length: q.quads.length / 4 }, (_, f) => q.quads.slice(4 * f, 4 * f + 4)),
      creases: [],
    };
    const target = icosphere(10, 4);
    const rows = buildFitOperator(cage, 2).rows;
    const original = SurfaceIndex.prototype.closest;
    let calls = 0;
    vi.spyOn(SurfaceIndex.prototype, 'closest').mockImplementation(function (this: SurfaceIndex, p: Vec3) {
      const hit = original.call(this, p);
      // the target index answers one limit row per call: the first `rows` calls are round 0, afterwards every query costs a million tests
      if (this.faceCount === target.indices.length / 3 && ++calls > rows) this.tests += 1_000_000;
      return hit;
    });
    const result = fitSubdivision(cage, target, {
      level: 2,
      maxDeviation: 1e-9,
      iterations: 10,
      interpolate: false,
      smoothing: 1e-3,
      targetClosed: false,
    });
    if ('code' in result) throw new Error(result.message);
    expect(result.stop).toBe('budget');
    expect(result.converged).toBe(false);
    expect(result.rounds).toBe(1);
    expect(result.final.max).toBeLessThan(result.initial.max);
  });

  it('counts the forward and the backward half against one budget: neither half alone is over it, together they are', () => {
    const q = quadSphere(10, 4);
    const cage = {
      vertices: Array.from(
        { length: q.positions.length / 3 },
        (_, i): Vec3 => [
          (q.positions[3 * i] as number) * 0.95,
          (q.positions[3 * i + 1] as number) * 0.95,
          (q.positions[3 * i + 2] as number) * 0.95,
        ],
      ),
      faces: Array.from({ length: q.quads.length / 4 }, (_, f) => q.quads.slice(4 * f, 4 * f + 4)),
      creases: [],
    };
    const target = icosphere(10, 4);
    const rows = buildFitOperator(cage, 2).rows;
    const samples = target.positions.length / 3;
    const budget = WORK_PER_QUERY * (rows + samples);
    const original = SurfaceIndex.prototype.closest;
    let targetCalls = 0;
    vi.spyOn(SurfaceIndex.prototype, 'closest').mockImplementation(function (this: SurfaceIndex, p: Vec3) {
      const hit = original.call(this, p);
      const isTarget = this.faceCount === target.indices.length / 3;
      if (isTarget) targetCalls++;
      // from the second round on the forward half costs 60 % of the budget and the backward half 60 %: 120 % together, each under 100 %
      if (targetCalls > rows) this.tests += isTarget ? (0.6 * budget) / rows : (0.6 * budget) / samples;
      return hit;
    });
    const result = fitSubdivision(cage, target, {
      level: 2,
      maxDeviation: 1e-9,
      iterations: 10,
      interpolate: false,
      smoothing: 1e-3,
      targetClosed: false,
    });
    if ('code' in result) throw new Error(result.message);
    expect(result.stop).toBe('budget');
    expect(result.rounds).toBe(1);
  });

  it('puts only the answered forward rows into the rms of the refusal message, not the backward distances', () => {
    const q = quadSphere(1.2, 6);
    const cage = {
      vertices: Array.from(
        { length: q.positions.length / 3 },
        (_, i): Vec3 => [q.positions[3 * i] as number, q.positions[3 * i + 1] as number, q.positions[3 * i + 2] as number],
      ),
      faces: Array.from({ length: q.quads.length / 4 }, (_, f) => q.quads.slice(4 * f, 4 * f + 4)),
      creases: [],
    };
    const result = fitSubdivision(cage, icosphere(10, 5), {
      level: 2,
      maxDeviation: 0.05,
      iterations: 3,
      interpolate: false,
      smoothing: 1e-3,
      targetClosed: false,
    });
    expect(result).toMatchObject({ code: 'MESH_FIT_CAGE_FAR' });
    // the cage points are all 10 - 1.2 = 8.8 inside the sphere, so the rms of the answered rows is 8.8 (backward distances would have lowered or raised it)
    const rms = Number(/rms distance to the target is ([0-9.]+)/.exec((result as { message: string }).message)?.[1]);
    expect(rms).toBeGreaterThan(8.4);
    expect(rms).toBeLessThan(9.2);
  });
});
