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
  reducedStiffness,
  type Environment,
} from '@lib/laminate/clt';
import { CRITERIA, type Criterion, DEFAULT_F12_STAR } from '@lib/laminate/failure';
import { respond, thermalExpansion } from './plyResponse';
import { isUnverified } from '@lib/laminate/provenance';

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
export const toMillimetres = (stack: readonly StackPly<LaminaMaterial>[], units: DocumentUnit): StackPly<LaminaMaterial>[] =>
  stack.map((ply) => ({ ...ply, material: { ...ply.material, plyThickness: ply.material.plyThickness * MM_PER_UNIT[units] } }));

export type AnalysisOutcome =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Analysis of `stack` (bottom to top) under `loads` (N/mm, N*mm/mm).
 * @failure singular ABD -> CMP_LAMINATE_SINGULAR; loads with a material lacking a strength -> CMP_MATERIAL_ALLOWABLE_MISSING
 */
export function analyzeStack(
  stack: readonly StackPly<LaminaMaterial>[],
  units: DocumentUnit,
  loads: Loads | undefined,
  criteria: readonly Criterion[] = CRITERIA,
  inputs: Record<string, unknown> = {},
  environment?: Environment,
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
      method: 'CLT, first-ply failure, linear (hygrothermal as uniform free strains when an environment is given)',
      reference: 'NASA RP-1351; Jones, Mechanics of Composite Materials (1999)',
      inputs: {
        materials: materials.map((material) => ({ name: material.name, basis: material.basis, source: material.source })),
        ...inputs,
      },
    },
  };
  const expansion = thermalExpansion(mm, laminate, constants.abdInverse);
  if (expansion !== null)
    base['thermalExpansion'] = {
      perKelvin: { strain: expansion.strain.map(sig), curvature: expansion.curvature.map(sig) },
      unit: '1/K (strain), 1/(mm K) (curvature)',
      note: 'unrestrained laminate, mid-plane',
    };
  if (loads === undefined && environment === undefined) return { ok: true, data: base };
  const load: Load6 = [loads?.Nx ?? 0, loads?.Ny ?? 0, loads?.Nxy ?? 0, loads?.Mx ?? 0, loads?.My ?? 0, loads?.Mxy ?? 0];
  const outcome = respond(mm, laminate, constants.abdInverse, load, environment, criteria);
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    data: {
      ...base,
      ...outcome.value.data,
      reviewRequired: true,
      reviewReason: 'computed by llull, not approved: first-ply failure margins need a qualified engineer',
    },
  };
}
