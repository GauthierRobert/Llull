/**
 * Numerical homogenisation of a lattice unit cell (05 IMP 14.15, FR-IMP-34): the cell is voxelised at two resolutions (partial volumes from 2 x 2 x 2 samples of the field per
 * voxel), the six periodic load cases are solved on `llull-voxfe` through the field engine's `homogenize`, and the effective stiffness tensor and the engineering moduli along the
 * cell axes come from it. The second resolution gives the convergence. Always unverified and reviewRequired: a voxel model of a thin strut is a screening number, never an allowable.
 * @invariant deterministic (the solver's reductions have a fixed order); the cap on voxels is `MAX_HOMOGENIZATION_VOXELS`
 */

import type { FieldEngine, HomogenizeAnswer } from '@core/geometry/field/engineTypes';
import type { FieldProgram } from '@core/geometry/field/program';
import type { Vec3 } from '@core/model/types';

/** Named cap: voxels of the finer cell (64^3). The solve costs about this many times a few hundred iterations of six load cases. */
const MAX_HOMOGENIZATION_VOXELS = 64 * 64 * 64;
export const DEFAULT_HOMOGENIZATION_RESOLUTION = 32;
const SUBSAMPLES = 2;
const EMIN_RATIO = 1e-6;

export interface HomogenizationOptions {
  /** Voxels along the smallest cell edge of the finer model (the coarser one has half). */
  readonly resolution: number;
  /** Poisson ratio of the solid. */
  readonly poissonRatio: number;
}

/** Voxels per axis for `resolution` along the smallest edge (the voxel is cubic; the other axes are rounded to whole voxels). */
export function cellVoxels(cell: Vec3, resolution: number): { dims: [number, number, number]; h: number } {
  const h = Math.min(...cell) / resolution;
  return { dims: cell.map((edge) => Math.max(2, Math.round(edge / h))) as [number, number, number], h };
}

/** Partial volumes (bytes) of the cell voxels: the share of 2 x 2 x 2 field samples that are inside (field <= 0). Null when the engine cannot evaluate. */
function voxelise(engine: FieldEngine, program: FieldProgram, origin: Vec3, dims: readonly number[], h: number): Uint8Array | null {
  const [nx, ny, nz] = dims as [number, number, number];
  const density = new Uint8Array(nx * ny * nz);
  const perVoxel = SUBSAMPLES ** 3;
  // voxels per batch so that a batch stays under the engine's sample budget
  const batch = Math.max(1, Math.floor(Math.min(engine.limits.maxSamples, 2 ** 21) / perVoxel));
  for (let start = 0; start < density.length; start += batch) {
    const end = Math.min(density.length, start + batch);
    const points = new Float64Array((end - start) * perVoxel * 3);
    let at = 0;
    for (let e = start; e < end; e += 1) {
      const [i, j, k] = [e % nx, Math.floor(e / nx) % ny, Math.floor(e / (nx * ny))];
      for (let c = 0; c < SUBSAMPLES; c += 1)
        for (let b = 0; b < SUBSAMPLES; b += 1)
          for (let a = 0; a < SUBSAMPLES; a += 1) {
            points[at++] = origin[0] + (i + (a + 0.5) / SUBSAMPLES) * h;
            points[at++] = origin[1] + (j + (b + 0.5) / SUBSAMPLES) * h;
            points[at++] = origin[2] + (k + (c + 0.5) / SUBSAMPLES) * h;
          }
    }
    const answer = engine.evaluate(program, points, false);
    if (answer.failure !== undefined) return null;
    for (let e = start; e < end; e += 1) {
      let inside = 0;
      for (let s = 0; s < perVoxel; s += 1) if ((answer.values[(e - start) * perVoxel + s] as number) <= 0) inside += 1;
      density[e] = Math.round((255 * inside) / perVoxel);
    }
  }
  return density;
}

/** Inverse of a 6 x 6 matrix by Gauss-Jordan with partial pivoting, or null when it is singular. */
function invert6(m: readonly number[]): number[] | null {
  const a = Array.from({ length: 6 }, (_, r) => [...m.slice(r * 6, r * 6 + 6), ...Array.from({ length: 6 }, (_, q) => (q === r ? 1 : 0))]);
  const scale = Math.max(...m.map(Math.abs), 1e-300);
  for (let c = 0; c < 6; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < 6; r += 1)
      if (Math.abs((a[r] as number[])[c] as number) > Math.abs((a[pivot] as number[])[c] as number)) pivot = r;
    if (Math.abs((a[pivot] as number[])[c] as number) < 1e-12 * scale) return null;
    [a[c], a[pivot]] = [a[pivot] as number[], a[c] as number[]];
    const p = (a[c] as number[])[c] as number;
    a[c] = (a[c] as number[]).map((v) => v / p);
    for (let r = 0; r < 6; r += 1) {
      if (r === c) continue;
      const f = (a[r] as number[])[c] as number;
      a[r] = (a[r] as number[]).map((v, q) => v - f * ((a[c] as number[])[q] as number));
    }
  }
  return a.flatMap((row) => row.slice(6));
}

export interface Moduli {
  /** E / Es along x, y, z. */
  readonly young: readonly (number | null)[];
  /** G / Es: yz, zx, xy. */
  readonly shear: readonly (number | null)[];
  /** nu_xy, nu_yz, nu_zx (strain along the second axis per strain along the first, loading along the first). */
  readonly poisson: readonly (number | null)[];
}

/** Engineering moduli of the stiffness `c` from its compliance (null where the cell is a mechanism). */
export function moduliOf(c: readonly number[]): Moduli {
  const s = invert6(c);
  if (s === null) return { young: [null, null, null], shear: [null, null, null], poisson: [null, null, null] };
  const at = (r: number, q: number): number => s[r * 6 + q] as number;
  const inverse = (v: number): number | null => (v > 0 ? 1 / v : null);
  return {
    young: [0, 1, 2].map((i) => inverse(at(i, i))),
    shear: [3, 4, 5].map((i) => inverse(at(i, i))),
    poisson: [
      [0, 1],
      [1, 2],
      [2, 0],
    ].map(([i, j]) => -at(j as number, i as number) / at(i as number, i as number)),
  };
}

/** Largest asymmetry |C - C^T| over the largest entry, and for a cubic cell the largest deviation from cubic symmetry over the largest entry. */
export function symmetryOf(c: readonly number[], cubic: boolean): { asymmetry: number; cubicDeviation: number | null } {
  const at = (r: number, q: number): number => c[r * 6 + q] as number;
  const top = Math.max(...c.map(Math.abs), 1e-300);
  let asymmetry = 0;
  for (let r = 0; r < 6; r += 1) for (let q = 0; q < r; q += 1) asymmetry = Math.max(asymmetry, Math.abs(at(r, q) - at(q, r)));
  if (!cubic) return { asymmetry: asymmetry / top, cubicDeviation: null };
  const diagonal = [at(0, 0), at(1, 1), at(2, 2)];
  const coupling = [at(0, 1), at(1, 2), at(2, 0)];
  const shear = [at(3, 3), at(4, 4), at(5, 5)];
  const spread = (values: number[]): number => Math.max(...values) - Math.min(...values);
  let off = 0;
  for (let r = 0; r < 6; r += 1) for (let q = 0; q < 6; q += 1) if (!(r < 3 && q < 3) && r !== q) off = Math.max(off, Math.abs(at(r, q)));
  return { asymmetry: asymmetry / top, cubicDeviation: Math.max(spread(diagonal), spread(coupling), spread(shear), off) / top };
}

interface HomogenizedLevel {
  readonly resolution: number;
  readonly voxels: number;
  readonly dims: readonly number[];
  readonly volumeFraction: number;
  readonly c: readonly number[];
  readonly moduli: Moduli;
  readonly iterations: readonly number[];
  readonly converged: boolean;
}

export type Homogenized =
  | { readonly ok: true; readonly fine: HomogenizedLevel; readonly coarse: HomogenizedLevel; readonly engine: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

function level(
  engine: FieldEngine,
  program: FieldProgram,
  origin: Vec3,
  cell: Vec3,
  resolution: number,
  nu: number,
): { ok: true; level: HomogenizedLevel; engine: string } | { ok: false; code: string; message: string } {
  const { dims, h } = cellVoxels(cell, resolution);
  const voxels = dims[0] * dims[1] * dims[2];
  if (voxels > MAX_HOMOGENIZATION_VOXELS)
    return {
      ok: false,
      code: 'IMP_HOMOGENIZATION_TOO_LARGE',
      message: `${dims.join(' x ')} = ${voxels} voxels exceed the cap of ${MAX_HOMOGENIZATION_VOXELS} (resolution ${resolution} along the smallest edge of a cell of ${cell.join(' x ')}): lower the resolution`,
    };
  const density = voxelise(engine, program, origin, dims, h);
  if (density === null) return { ok: false, code: 'IMP_ENGINE_FAILED', message: 'the field engine could not sample the cell' };
  const answer: HomogenizeAnswer | undefined = engine.homogenize?.({
    dims,
    h,
    density,
    nu,
    eminRatio: EMIN_RATIO,
    maxVoxels: MAX_HOMOGENIZATION_VOXELS,
  });
  if (answer === undefined)
    return {
      ok: false,
      code: 'IMP_HOMOGENIZATION_NEEDS_NATIVE',
      message: `the ${engine.name} field engine has no homogenisation: it runs on the native engine (llull-compute, the desktop app and the CLI with a backend)`,
    };
  if (!answer.ok) return { ok: false, code: answer.code, message: answer.message };
  const fraction = density.reduce((sum, b) => sum + b, 0) / (255 * density.length);
  return {
    ok: true,
    engine: answer.provenance.engine,
    level: {
      resolution,
      voxels,
      dims,
      volumeFraction: fraction,
      c: answer.c,
      moduli: moduliOf(answer.c),
      iterations: answer.iterations,
      converged: answer.converged,
    },
  };
}

/** Homogenise the cell of `program` that starts at `origin` with edges `cell`, at the resolution of `options` and at half of it. */
export function homogenizeCell(
  engine: FieldEngine,
  program: FieldProgram,
  origin: Vec3,
  cell: Vec3,
  options: HomogenizationOptions,
): Homogenized {
  const fine = level(engine, program, origin, cell, options.resolution, options.poissonRatio);
  if (!fine.ok) return fine;
  const coarse = level(engine, program, origin, cell, Math.max(4, Math.round(options.resolution / 2)), options.poissonRatio);
  if (!coarse.ok) return coarse;
  return { ok: true, fine: fine.level, coarse: coarse.level, engine: fine.engine };
}

/** Largest relative change of the axis moduli (Young and shear) from the coarse to the fine model, or null when one is a mechanism. */
export function relativeChange(fine: Moduli, coarse: Moduli): number | null {
  const pairs = [...fine.young, ...fine.shear].map((value, i) => [value, [...coarse.young, ...coarse.shear][i]] as const);
  if (pairs.some(([a, b]) => a === null || b === null || a === undefined || b === undefined)) return null;
  return Math.max(...pairs.map(([a, b]) => Math.abs((a as number) - (b as number)) / Math.max(Math.abs(a as number), 1e-300)));
}

const SOURCE =
  'periodic numerical homogenisation on trilinear voxel elements (llull-voxfe), after Andreassen & Andreasen 2014 (Basic Optimization 5): six unit macro strains on the periodic cell, C = energy of the cell problem; screening estimate, not an allowable';

const rounded = (values: readonly (number | null)[]): (number | null)[] => values.map((v) => (v === null ? null : v));

/** The `homogenization` block of lattice_properties for a finished model pair. */
export function homogenizationBlock(
  result: Extract<Homogenized, { ok: true }>,
  cell: Vec3,
  options: HomogenizationOptions,
  baseMaterial: { youngModulusMpa: number; source: string } | undefined,
): Record<string, unknown> {
  const { fine, coarse } = result;
  const cubic = Math.max(...cell) - Math.min(...cell) <= 1e-9 * Math.max(...cell);
  const change = relativeChange(fine.moduli, coarse.moduli);
  const mpa = (values: readonly (number | null)[]): (number | null)[] | null =>
    baseMaterial === undefined ? null : values.map((v) => (v === null ? null : v * baseMaterial.youngModulusMpa));
  return {
    method: 'periodic homogenisation, voxel H8',
    source: SOURCE,
    engine: result.engine,
    resolution: { fine: fine.resolution, coarse: coarse.resolution },
    voxels: { fine: fine.voxels, coarse: coarse.voxels, dimsFine: fine.dims, cap: MAX_HOMOGENIZATION_VOXELS },
    volumeFraction: { fine: fine.volumeFraction, coarse: coarse.volumeFraction },
    poissonRatioOfSolid: options.poissonRatio,
    stiffnessRatio: { voigtOrder: 'xx yy zz yz zx xy (engineering shear)', c: fine.c },
    youngRatio: rounded(fine.moduli.young),
    shearRatio: rounded(fine.moduli.shear),
    poisson: rounded(fine.moduli.poisson),
    youngModulusMpa: mpa(fine.moduli.young),
    shearModulusMpa: mpa(fine.moduli.shear),
    symmetry: { cubicCell: cubic, ...symmetryOf(fine.c, cubic) },
    convergence: {
      coarse: { resolution: coarse.resolution, youngRatio: rounded(coarse.moduli.young), shearRatio: rounded(coarse.moduli.shear) },
      relativeChange: change,
      solverConverged: fine.converged && coarse.converged,
      iterations: { fine: fine.iterations, coarse: coarse.iterations },
      note:
        change === null
          ? 'a mechanism in one of the models: the moduli along some axis are undefined'
          : 'largest relative change of E and G along the axes from the coarse to the fine model; a value above a few percent says the fine model is not converged either',
    },
    note: 'voxel model of one unrotated rectangular cell (rotation and any cell map ignored); partial volumes from 2 x 2 x 2 samples; void voxels carry 1e-6 of the solid stiffness',
    unverified: true,
    reviewRequired: true,
    warning: 'IMP_MECHANICS_UNVERIFIED',
  };
}
