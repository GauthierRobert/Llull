/** lattice_properties `homogenize` (05 IMP 14.15) without the native solver: the moduli of a stiffness tensor, the symmetry checks, the voxel counts and the command around a stand-in engine. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { tsFieldEngine } from '@core/geometry/field/tsEngine';
import type { FieldEngine, HomogenizeAnswer, HomogenizeRequest } from '@core/geometry/field/engineTypes';
import { createEmptyDocument } from '@core/model/types';
import { cellVoxels, moduliOf, relativeChange, symmetryOf } from '@implicit/homogenization';

/** Isotropic stiffness of E = 1 (Voigt xx yy zz yz zx xy, engineering shear). */
function isotropic(nu: number): number[] {
  const lambda = nu / ((1 + nu) * (1 - 2 * nu));
  const mu = 0.5 / (1 + nu);
  const c = new Array<number>(36).fill(0);
  for (let a = 0; a < 3; a += 1) for (let b = 0; b < 3; b += 1) c[a * 6 + b] = lambda + (a === b ? 2 * mu : 0);
  for (let a = 3; a < 6; a += 1) c[a * 6 + a] = mu;
  return c;
}

interface Block {
  resolution: unknown;
  voxels: unknown;
  youngRatio: number[];
  youngModulusMpa: number[];
  volumeFraction: { fine: number };
  symmetry: unknown;
  convergence: { relativeChange: number | null } & Record<string, unknown>;
}

describe('moduli of a stiffness tensor', () => {
  it('give E = 1, nu and G = 1 / (2 (1 + nu)) for the isotropic solid', () => {
    const m = moduliOf(isotropic(0.3));
    for (const e of m.young) expect(e).toBeCloseTo(1, 12);
    for (const g of m.shear) expect(g).toBeCloseTo(1 / 2.6, 12);
    for (const nu of m.poisson) expect(nu).toBeCloseTo(0.3, 12);
  });

  it('are undefined where the cell is a mechanism (a singular tensor)', () => {
    const m = moduliOf(new Array<number>(36).fill(0));
    expect(m).toEqual({ young: [null, null, null], shear: [null, null, null], poisson: [null, null, null] });
    expect(relativeChange(m, m)).toBeNull();
  });

  it('change by a relative amount between two models', () => {
    const a = moduliOf(isotropic(0.3));
    const b = moduliOf(isotropic(0.3).map((v) => v * 1.1));
    expect(relativeChange(a, b)).toBeCloseTo(0.1 / 1, 10);
  });
});

describe('symmetry checks', () => {
  it('the isotropic tensor is symmetric and cubic; a perturbed one is not', () => {
    const c = isotropic(0.25);
    expect(symmetryOf(c, true)).toEqual({ asymmetry: 0, cubicDeviation: 0 });
    expect(symmetryOf(c, false).cubicDeviation).toBeNull();
    const bent = [...c];
    bent[0] = (bent[0] as number) * 1.2;
    bent[5] = 0.05;
    expect(symmetryOf(bent, true).cubicDeviation).toBeGreaterThan(0.05);
    expect(symmetryOf(bent, true).asymmetry).toBeGreaterThan(0);
  });
});

describe('voxel counts', () => {
  it('a cubic voxel on the smallest edge and whole voxels on the others', () => {
    expect(cellVoxels([10, 10, 10], 16)).toEqual({ dims: [16, 16, 16], h: 10 / 16 });
    expect(cellVoxels([10, 20, 15], 8)).toEqual({ dims: [8, 16, 12], h: 10 / 8 });
    expect(cellVoxels([1, 100, 1], 8).dims[1]).toBe(800);
  });
});

/** A stand-in for the native solver: answers the stiffness of an isotropic solid scaled by the volume fraction of the density it is given. */
function standIn(options: { fail?: string; mechanism?: boolean } = {}): FieldEngine {
  const homogenize = (request: HomogenizeRequest): HomogenizeAnswer => {
    if (options.fail !== undefined) return { ok: false, code: 'IMP_ENGINE_FAILED', message: options.fail };
    const fraction = request.density.reduce((sum, b) => sum + b, 0) / (255 * request.density.length);
    const voxels = request.dims[0] * request.dims[1] * request.dims[2];
    return {
      ok: true,
      c: options.mechanism === true ? new Array<number>(36).fill(0) : isotropic(request.nu).map((v) => v * fraction),
      iterations: [10, 10, 10, 12, 12, 12],
      residuals: [1e-10, 1e-10, 1e-10, 1e-10, 1e-10, 1e-10],
      converged: true,
      voxels,
      provenance: { engine: 'stand-in', device: 'cpu', deterministic: true, voxel: request.h },
    };
  };
  return { ...tsFieldEngine, name: 'stand-in', homogenize };
}

describe('lattice_properties homogenize through a stand-in engine', () => {
  const made = execute(createEmptyDocument(), 'add_strut_lattice', { cell: 'octet', cellSize: 10, radius: 1 });
  const id = made.affected[0] as string;
  const ask = (engine: FieldEngine | undefined, params: object = {}): ReturnType<typeof execute> =>
    execute(
      made.document,
      'lattice_properties',
      { id, resolution: 16, homogenize: { resolution: 8 }, ...params },
      { ...defaultContext(), ...(engine === undefined ? {} : { fieldEngine: engine }) },
    );

  it('reports the tensor, the moduli, the symmetry and the convergence between the two resolutions, unverified', () => {
    const result = ask(standIn(), { baseMaterial: { youngModulusMpa: 1000, source: 'test' } });
    expect(result.error).toBeUndefined();
    const data = result.data as Record<string, Block>;
    const h = data['homogenization'] as Block;
    expect(h.resolution).toEqual({ fine: 8, coarse: 4 });
    expect(h.voxels).toMatchObject({ fine: 512, coarse: 64, cap: 262144 });
    expect(h.youngRatio[0]).toBeCloseTo(h.volumeFraction.fine, 10);
    expect(h.youngModulusMpa[0] as number).toBeCloseTo((h.youngRatio[0] as number) * 1000, 8);
    expect(h.symmetry).toMatchObject({ cubicCell: true, asymmetry: 0, cubicDeviation: 0 });
    expect(h.convergence).toMatchObject({ solverConverged: true, coarse: { resolution: 4 } });
    expect(h).toMatchObject({ unverified: true, reviewRequired: true, warning: 'IMP_MECHANICS_UNVERIFIED', engine: 'stand-in' });
    expect(data['unverified']).toBe(true);
    expect(ask(standIn(), {}).data).toBeDefined();
    expect((ask(standIn(), { homogenize: undefined }).data as Record<string, unknown>)['homogenization']).toBeUndefined();
  });

  it('a mechanism has no moduli and says so; a failing engine and an engine without a solver are refused by name', () => {
    const mechanism = (ask(standIn({ mechanism: true })).data as Record<string, Block>)['homogenization'] as Block;
    expect(mechanism.youngRatio).toEqual([null, null, null]);
    expect(mechanism.convergence.relativeChange).toBeNull();
    expect(ask(standIn({ fail: 'the job crashed' })).error?.code).toBe('IMP_ENGINE_FAILED');
    expect(ask(tsFieldEngine).error?.code).toBe('IMP_HOMOGENIZATION_NEEDS_NATIVE');
    expect(ask(undefined).error?.code).toBe('IMP_HOMOGENIZATION_NEEDS_NATIVE');
  });

  it('refuses a finer model than the cap, and a resolution out of range', () => {
    const tall = execute(createEmptyDocument(), 'add_strut_lattice', { cell: 'cubic', cellSize: [10, 10, 80], radius: 1 });
    const refused = execute(
      tall.document,
      'lattice_properties',
      { id: tall.affected[0], homogenize: { resolution: 64 } },
      { ...defaultContext(), fieldEngine: standIn() },
    );
    expect(refused.error?.code).toBe('IMP_HOMOGENIZATION_TOO_LARGE');
    expect(ask(standIn(), { homogenize: { resolution: 4 } }).error?.code).toBe('CMD_INVALID_PARAMS');
  });
});
