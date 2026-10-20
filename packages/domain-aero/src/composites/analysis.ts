/** Laminate analysis of a stack (06 CMP §5.2-5.3): ABD, constants, ply stresses and first-ply failure, with the AF-31..35 result conventions. */

import type { LaminaMaterial } from '@core/model/composites';
import { MM_PER_UNIT } from '@core/model/units';
import type { DocumentUnit } from '@core/model/types';
import { sig } from '../shared/results';
import {
  type Laminate,
  type Load6,
  type Matrix,
  type StackPly,
  engineeringConstants,
  laminateStiffness,
  plyStressAt,
  reducedStiffness,
  strainsFor,
} from './clt';
import { CRITERIA, type Criterion, DEFAULT_F12_STAR, strengthRatio, strengthsOf } from './failure';
import { isUnverified } from './provenance';

export interface Loads {
  readonly Nx?: number | undefined;
  readonly Ny?: number | undefined;
  readonly Nxy?: number | undefined;
  readonly Mx?: number | undefined;
  readonly My?: number | undefined;
  readonly Mxy?: number | undefined;
}

export interface NamedDefault {
  readonly value: number;
  readonly unit: string;
  readonly source: string;
  readonly defaulted: boolean;
}

const rounded = (m: Matrix): number[][] => m.map((row) => row.map(sig));

/** The stack with every ply thickness converted from document units to millimetres (CLT runs in N-mm-MPa). */
export const toMillimetres = (stack: readonly StackPly[], units: DocumentUnit): StackPly[] =>
  stack.map((ply) => ({ ...ply, material: { ...ply.material, plyThickness: ply.material.plyThickness * MM_PER_UNIT[units] } }));

export type AnalysisOutcome =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Analysis of `stack` (bottom to top) under `loads` (N/mm, N*mm/mm).
 * @failure singular ABD -> CMP_LAMINATE_SINGULAR; loads with a material lacking a strength -> CMP_MATERIAL_ALLOWABLE_MISSING
 */
export function analyzeStack(
  stack: readonly StackPly[],
  units: DocumentUnit,
  loads: Loads | undefined,
  criteria: readonly Criterion[] = CRITERIA,
  inputs: Record<string, unknown> = {},
): AnalysisOutcome {
  const mm = toMillimetres(stack, units);
  const laminate: Laminate = laminateStiffness(mm);
  const constants = engineeringConstants(laminate);
  if (constants === null)
    return {
      ok: false,
      code: 'CMP_LAMINATE_SINGULAR',
      message: 'the ABD matrix is singular or ill-conditioned (condition number above 1e12)',
    };
  const materials = [...new Map(stack.map((ply) => [ply.material.name, ply.material])).values()];
  const unverified = materials.some(isUnverified);
  const first = stack[0]?.material as LaminaMaterial;
  const f12Defaulted = materials.some((material) => material.tsaiWuF12Star === undefined);
  const base: Record<string, unknown> = {
    unit: 'N-mm-MPa',
    plyCount: stack.length,
    anglesDeg: stack.map((ply) => ply.angle),
    thicknessMm: sig(laminate.thickness),
    Q: Object.fromEntries(Object.entries(reducedStiffness(first)).map(([k, v]) => [k, sig(v)])),
    QMaterial: first.name,
    QUnit: 'MPa',
    A: rounded(laminate.A),
    AUnit: 'N/mm',
    B: rounded(laminate.B),
    BUnit: 'N',
    D: rounded(laminate.D),
    DUnit: 'N*mm',
    abdInverse: constants.abdInverse.map((row) => row.map((v) => Number(v.toPrecision(10)))),
    constantsMembrane: {
      ...Object.fromEntries(Object.entries(constants.membrane).map(([k, v]) => [k, sig(v)])),
      unit: 'MPa (nuxy dimensionless)',
      definition: 'A inverse',
    },
    constantsFreeBending: {
      ...Object.fromEntries(Object.entries(constants.freeBending).map(([k, v]) => [k, sig(v)])),
      unit: 'MPa (nuxy dimensionless)',
      definition: 'in-plane constants with bending unrestrained: top-left 3x3 of the ABD inverse',
    },
    constantsFlexural:
      constants.flexural === null
        ? null
        : {
            ...Object.fromEntries(Object.entries(constants.flexural).map(([k, v]) => [k, sig(v)])),
            unit: 'MPa (nuxy dimensionless)',
            definition: 'equivalent homogeneous plate in bending: E = 12 / (h^3 d), d = D inverse',
          },
    unverified,
    unverifiedMaterials: materials.filter(isUnverified).map((material) => material.name),
    defaults: f12Defaulted
      ? ({
          tsaiWuF12Star: {
            value: DEFAULT_F12_STAR,
            unit: '-',
            source: 'common Tsai-Wu default without biaxial data (S36)',
            defaulted: true,
          },
        } satisfies Record<string, NamedDefault>)
      : {},
    provenance: {
      method: 'CLT, first-ply failure, linear, no hygrothermal',
      reference: 'NASA RP-1351; Jones, Mechanics of Composite Materials (1999)',
      inputs: {
        materials: materials.map((material) => ({ name: material.name, basis: material.basis, source: material.source })),
        ...inputs,
      },
    },
  };
  if (loads === undefined) return { ok: true, data: base };
  const missing = materials.filter((material) => !('Xt' in strengthsOf(material)) && criteria.length > 0);
  if (missing.length > 0)
    return {
      ok: false,
      code: 'CMP_MATERIAL_ALLOWABLE_MISSING',
      message: `material(s) ${missing.map((material) => `"${material.name}"`).join(', ')} lack strengths (${[...new Set(missing.flatMap((m) => (strengthsOf(m) as { missing: readonly string[] }).missing))].join(', ')})`,
    };
  const load: Load6 = [loads.Nx ?? 0, loads.Ny ?? 0, loads.Nxy ?? 0, loads.Mx ?? 0, loads.My ?? 0, loads.Mxy ?? 0];
  const { strain, curvature } = strainsFor(constants.abdInverse, load);
  type Best = { R: number; ply: number; angleDeg: number; position: 'bottom' | 'top'; mode?: string };
  const best = new Map<Criterion, Best>();
  const plies = mm.map((ply, index) => {
    const z0 = laminate.z[index] as number;
    const z1 = laminate.z[index + 1] as number;
    const strengths = strengthsOf(ply.material) as Exclude<ReturnType<typeof strengthsOf>, { missing: readonly string[] }>;
    const f12 = ply.material.tsaiWuF12Star ?? DEFAULT_F12_STAR;
    const at = (z: number, position: 'bottom' | 'top'): Record<string, unknown> => {
      const stress = plyStressAt(ply.material, ply.angle, strain, curvature, z);
      const ratios: Record<string, number | null> = {};
      for (const criterion of criteria) {
        const ratio = strengthRatio(criterion, stress.material, strengths, f12);
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
      return { zMm: sig(z), stressXyMpa: stress.xy.map(sig), stress12Mpa: stress.material.map(sig), strengthRatios: ratios };
    };
    return { index, angleDeg: ply.angle, material: ply.material.name, bottom: at(z0, 'bottom'), top: at(z1, 'top') };
  });
  const failure = Object.fromEntries(
    criteria.map((criterion) => {
      const hit = best.get(criterion);
      return [
        criterion,
        hit === undefined
          ? { R: null, note: 'no stress: the load does not stress any ply' }
          : { ...hit, R: sig(hit.R), unit: 'load multiplier' },
      ];
    }),
  );
  return {
    ok: true,
    data: {
      ...base,
      loads: { Nx: load[0], Ny: load[1], Nxy: load[2], Mx: load[3], My: load[4], Mxy: load[5], forceUnit: 'N/mm', momentUnit: 'N*mm/mm' },
      midplane: { strain: strain.map(Number), curvature: curvature.map(Number), curvatureUnit: '1/mm' },
      plies,
      firstPlyFailure: failure,
      reviewRequired: true,
      reviewReason: 'computed by llull, not approved: first-ply failure margins need a qualified engineer',
    },
  };
}
