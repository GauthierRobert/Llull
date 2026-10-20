/** Ply stresses and strength ratios of a stack under mechanical and hygrothermal loading (06 CMP §5.3, M6). N, mm, MPa. */

import type { LaminaMaterial } from '@core/model/composites';
import { sig } from '../shared/results';
import {
  type Environment,
  type Laminate,
  type Load6,
  type Matrix,
  type StackPly,
  type Triple,
  environmentResultants,
  freeStrainXy,
  missingHygrothermal,
  plyStressAt,
  strainsFor,
} from '@lib/laminate/clt';
import { type Criterion, DEFAULT_F12_STAR, type Strengths, strengthRatio, strengthsOf } from '@lib/laminate/failure';
import { larc03Constants, larc03Index, larc03Ratio } from './larc03';

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };

interface Ratio {
  readonly R: number;
  readonly mode?: string;
}

const ZERO: Triple = [0, 0, 0];
const isZero = (stress: Triple): boolean => stress.every((component) => component === 0);

/** Why the criteria cannot run on `materials`, or null. */
export function criteriaProblem(materials: readonly LaminaMaterial[], criteria: readonly Criterion[]): string | null {
  if (criteria.length === 0) return null;
  const problems = materials.flatMap((material) => {
    const strengths = strengthsOf(material);
    const lacking = 'missing' in strengths ? [...strengths.missing] : [];
    if (criteria.includes('larc03')) {
      const larc = larc03Constants(material);
      if ('missing' in larc) lacking.push(...larc.missing.filter((name) => !lacking.includes(name)));
    }
    return lacking.length === 0 ? [] : [`"${material.name}" lacks ${lacking.join(', ')}`];
  });
  return problems.length === 0 ? null : `material(s) lack the data the criteria need: ${problems.join('; ')}`;
}

/**
 * Strength ratio of the stress state \`resid + R * mech\` (material axes): the multiplier of the mechanical part at which the criterion fails.
 * @invariant without a residual stress the closed form (or the LaRC03 bisection) of the criterion is used; with one, R is found by bisection and is 0 when the residual state alone fails
 */
function ratioOf(criterion: Criterion, material: LaminaMaterial, resid: Triple, mech: Triple): Ratio {
  const strengths = strengthsOf(material) as Strengths;
  const f12 = material.tsaiWuF12Star ?? DEFAULT_F12_STAR;
  const larc = criterion === 'larc03' ? larc03Constants(material) : null;
  const at = (stress: Triple): Ratio =>
    criterion === 'larc03'
      ? larc03Ratio(larc as Exclude<typeof larc, { missing: readonly string[] } | null>, stress)
      : strengthRatio(criterion, stress, strengths, f12);
  if (isZero(resid)) return at(mech);
  const state = (lambda: number): Triple => [resid[0] + lambda * mech[0], resid[1] + lambda * mech[1], resid[2] + lambda * mech[2]];
  const fails = (lambda: number): boolean =>
    larc !== null && !('missing' in larc) ? larc03Index(larc, state(lambda)) >= 1 : at(state(lambda)).R <= 1;
  if (fails(0)) return { R: 0, mode: 'environment' };
  if (isZero(mech)) return { R: Infinity };
  let upper = 1;
  while (!fails(upper) && upper < 1e9) upper *= 2;
  if (!fails(upper)) return { R: Infinity };
  let lower = upper > 1 ? upper / 2 : 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lower + upper) / 2;
    if (fails(mid)) upper = mid;
    else lower = mid;
  }
  const mode = at(state(upper)).mode;
  return { R: upper, ...(mode === undefined ? {} : { mode }) };
}

export interface Response {
  readonly data: Record<string, unknown>;
}

/**
 * Responses of \`stack\` (thicknesses already in mm) to the mechanical \`load\` plus the hygrothermal state \`env\`.
 * @failure criteria without their material data -> CMP_MATERIAL_ALLOWABLE_MISSING; an environment without alpha / beta -> CMP_MATERIAL_HYGROTHERMAL_MISSING
 */
export function respond(
  stack: readonly StackPly<LaminaMaterial>[],
  laminate: Laminate,
  abdInverse: Matrix,
  load: Load6,
  env: Environment | undefined,
  criteria: readonly Criterion[],
): Outcome<Response> {
  const materials = [...new Map(stack.map((ply) => [ply.material.name, ply.material])).values()];
  const problem = criteriaProblem(materials, criteria);
  if (problem !== null) return { ok: false, code: 'CMP_MATERIAL_ALLOWABLE_MISSING', message: problem };
  if (env !== undefined) {
    const lacking = materials.flatMap((material) => missingHygrothermal(material, env).map((name) => `${material.name}.${name}`));
    if (lacking.length > 0) return { ok: false, code: 'CMP_MATERIAL_HYGROTHERMAL_MISSING', message: `missing ${lacking.join(', ')}` };
  }
  const envLoad: Load6 = env === undefined ? [0, 0, 0, 0, 0, 0] : environmentResultants(stack, laminate, env);
  const mech = strainsFor(abdInverse, load);
  const hygro = strainsFor(abdInverse, envLoad);
  const best = new Map<Criterion, { R: number; ply: number; angleDeg: number; position: 'bottom' | 'top'; mode?: string }>();
  const plies = stack.map((ply, index) => {
    const free = env === undefined ? ZERO : freeStrainXy(ply.material, ply.angle, env);
    const at = (z: number, position: 'bottom' | 'top'): Record<string, unknown> => {
      const resid = plyStressAt(ply.material, ply.angle, hygro.strain, hygro.curvature, z, free).material;
      const loaded = plyStressAt(ply.material, ply.angle, mech.strain, mech.curvature, z).material;
      const total = plyStressAt(
        ply.material,
        ply.angle,
        mech.strain.map((v, i) => v + (hygro.strain[i] as number)) as unknown as Triple,
        mech.curvature.map((v, i) => v + (hygro.curvature[i] as number)) as unknown as Triple,
        z,
        free,
      );
      const ratios: Record<string, number | null> = {};
      for (const criterion of criteria) {
        const ratio = ratioOf(criterion, ply.material, resid, loaded);
        ratios[criterion] = Number.isFinite(ratio.R) ? sig(ratio.R) : null;
        const current = best.get(criterion);
        if (Number.isFinite(ratio.R) && (current === undefined || ratio.R < current.R))
          best.set(criterion, {
            R: ratio.R,
            ply: index,
            angleDeg: ply.angle,
            position,
            ...(ratio.mode === undefined ? {} : { mode: ratio.mode }),
          });
      }
      return { zMm: sig(z), stressXyMpa: total.xy.map(sig), stress12Mpa: total.material.map(sig), strengthRatios: ratios };
    };
    return {
      index,
      angleDeg: ply.angle,
      material: ply.material.name,
      bottom: at(laminate.z[index] as number, 'bottom'),
      top: at(laminate.z[index + 1] as number, 'top'),
    };
  });
  const failure = Object.fromEntries(
    criteria.map((criterion) => {
      const hit = best.get(criterion);
      return [
        criterion,
        hit === undefined
          ? {
              R: null,
              note:
                env !== undefined && load.every((component) => component === 0)
                  ? 'the residual hygrothermal state does not fail; no mechanical load to scale'
                  : 'no stress: the load does not stress any ply',
            }
          : { ...hit, R: sig(hit.R), unit: 'load multiplier of the mechanical loads' },
      ];
    }),
  );
  return {
    ok: true,
    value: {
      data: {
        loads: { Nx: load[0], Ny: load[1], Nxy: load[2], Mx: load[3], My: load[4], Mxy: load[5], forceUnit: 'N/mm', momentUnit: 'N*mm/mm' },
        midplane: {
          strain: mech.strain.map((v, i) => v + (hygro.strain[i] as number)),
          curvature: mech.curvature.map((v, i) => v + (hygro.curvature[i] as number)),
          curvatureUnit: '1/mm',
        },
        ...(env === undefined
          ? {}
          : {
              environment: {
                deltaT: env.deltaT,
                deltaMoisture: env.deltaMoisture,
                temperatureUnit: 'K',
                resultants: { N: envLoad.slice(0, 3).map(sig), M: envLoad.slice(3).map(sig), forceUnit: 'N/mm', momentUnit: 'N*mm/mm' },
                freeStrain: hygro.strain.map(sig),
                freeCurvature: hygro.curvature.map(sig),
                curvatureUnit: '1/mm',
              },
            }),
        plies,
        firstPlyFailure: failure,
      },
    },
  };
}

/** Effective laminate expansion per kelvin (unrestrained, no moisture): mid-plane strain and curvature, or null without alpha data. */
export function thermalExpansion(
  stack: readonly StackPly<LaminaMaterial>[],
  laminate: Laminate,
  abdInverse: Matrix,
): { strain: number[]; curvature: number[] } | null {
  const unit: Environment = { deltaT: 1, deltaMoisture: 0 };
  if (stack.some((ply) => missingHygrothermal(ply.material, unit).length > 0)) return null;
  const response = strainsFor(abdInverse, environmentResultants(stack, laminate, unit));
  return { strain: response.strain.map(Number), curvature: response.curvature.map(Number) };
}
