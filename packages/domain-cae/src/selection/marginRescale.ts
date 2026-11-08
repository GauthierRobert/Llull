/** Margin re-scaling of a material swap (PHY-12 §5.4): exact only for one homogeneous isotropic material under loads that do not depend on it. */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument, Material } from '@core/model/types';
import { elasticConstants, isElasticRefusal, propertyTemperatureK } from '../decks/elastic';
import { stateOf } from '../shared/state';

const MARGIN_CONDITIONS = [
  'single_material',
  'same_poisson',
  'no_body_force',
  'no_thermal_load',
  'no_prescribed_displacement',
  'same_allowable_basis',
  'results_current',
] as const;

type MarginCondition = (typeof MARGIN_CONDITIONS)[number];

export interface ConditionResult {
  readonly condition: MarginCondition;
  readonly ok: boolean;
  /** A failing blocking condition forbids the re-scaling (SEL_MARGINS_NEED_RESOLVE); same_allowable_basis only flags SEL_BASIS_MIXED. */
  readonly blocking: boolean;
  readonly detail: string;
}

/** MS2 = (1 + MS1) A2 / A1 - 1: the applied stress, factors and everything else of MS = A / (sigma FoS) - 1 are unchanged. */
export const rescaleMargin = (ms1: number, allowable1: number, allowable2: number): number => ((1 + ms1) * allowable2) / allowable1 - 1;

/** The named default of the Poisson-ratio tolerance (FR-SEL-20, OQ-SEL-02): identical values only. */
export const NU_TOLERANCE_DEFAULT = {
  value: 0,
  source: 'exact rescaling needs the same Poisson ratio (TECHNICAL_SPEC 5.4, OQ-SEL-02); a band needs a sourced error bound',
} as const;

const result = (condition: MarginCondition, ok: boolean, detail: string, blocking = true): ConditionResult => ({
  condition,
  ok,
  blocking,
  detail,
});

const partMaterials = (doc: CadDocument, analysis: AnalysisCase): string[] =>
  Object.keys(analysis.parts).map((id) => (Object.hasOwn(doc.entities, id) ? (doc.entities[id]?.materialId ?? '(none)') : '(missing)'));

/** Poisson ratio as the FEA deck reads it (constitutive set, else the property models) at the case temperature. */
function poisson(material: Material, id: string, analysis: AnalysisCase): number | string {
  const constants = elasticConstants(material, id, propertyTemperatureK(analysis));
  return isElasticRefusal(constants) ? `${constants.code}: ${constants.message}` : constants.nu;
}

/**
 * The exactness conditions of §5.4 that can be read from the document before any row is rescaled (all but same_allowable_basis, which is per row).
 * @invariant a condition that cannot be evaluated (no E / nu, no results) fails: nothing is assumed
 */
export function marginConditions(
  doc: CadDocument,
  analysis: AnalysisCase,
  swap: { readonly from: string; readonly to: string; readonly nuTolerance: number; readonly entityIds: readonly string[] },
): ConditionResult[] {
  const used = [...new Set(partMaterials(doc, analysis))].sort();
  const analysed = Object.keys(analysis.parts).sort();
  const swapped = [...new Set(swap.entityIds)].sort();
  const partial = analysed.filter((id) => !swapped.includes(id));
  const single = used.length === 1 && used[0] === swap.from && partial.length === 0;
  const fromMaterial = Object.hasOwn(doc.materials, swap.from) ? doc.materials[swap.from] : undefined;
  const toMaterial = Object.hasOwn(doc.materials, swap.to) ? doc.materials[swap.to] : undefined;
  const nuFrom = fromMaterial === undefined ? 'no material' : poisson(fromMaterial, swap.from, analysis);
  const nuTo = toMaterial === undefined ? 'no material' : poisson(toMaterial, swap.to, analysis);
  const gravity = analysis.loadOrder.filter((id) => analysis.loads[id]?.kind === 'gravity');
  const prescribed = analysis.constraintOrder.filter((id) =>
    Object.values(analysis.constraints[id]?.dofs ?? {}).some((value) => value !== 0 && value !== undefined),
  );
  const state = stateOf(doc, analysis);
  return [
    result(
      'single_material',
      single,
      `analysed parts are made of ${used.map((id) => `'${id}'`).join(', ')}${partial.length === 0 ? '' : `; part(s) ${partial.join(', ')} are not swapped, so the model would mix two materials`}${single ? '' : `; the swap needs every analysed part made of '${swap.from}' and swapped (load sharing depends on the stiffness ratio)`}`,
    ),
    result(
      'same_poisson',
      typeof nuFrom === 'number' && typeof nuTo === 'number' && Math.abs(nuTo - nuFrom) <= swap.nuTolerance,
      typeof nuFrom === 'number' && typeof nuTo === 'number'
        ? `nu ${nuFrom} -> ${nuTo}, tolerance ${swap.nuTolerance}`
        : `nu not readable: ${typeof nuFrom === 'string' ? `'${swap.from}' ${nuFrom}` : ''} ${typeof nuTo === 'string' ? `'${swap.to}' ${nuTo}` : ''}`.trim(),
    ),
    result(
      'no_body_force',
      gravity.length === 0,
      gravity.length === 0 ? 'no gravity / inertia load' : `gravity load(s) ${gravity.join(', ')} depend on the density`,
    ),
    result(
      'no_thermal_load',
      analysis.type !== 'thermo_static' && analysis.thermal === undefined && analysis.thermomech === undefined,
      analysis.type === 'thermo_static' || analysis.thermomech !== undefined
        ? `case type ${analysis.type} carries thermal strain (depends on CTE)`
        : 'no thermal load',
    ),
    result(
      'no_prescribed_displacement',
      prescribed.length === 0,
      prescribed.length === 0
        ? 'no non-zero prescribed displacement'
        : `non-zero prescribed displacement in ${prescribed.join(', ')} (stress then scales with E)`,
    ),
    result(
      'results_current',
      state === 'solved',
      `analysis state ${state}${state === 'solved' ? '' : ': solve it again before rescaling'}`,
    ),
  ];
}

/** The plan (data, AF-05) that re-solves the case with the swap applied, for `llull run --dry-run` on a copy. */
export function resolvePlan(
  analysisId: string,
  to: string,
  entityIds: readonly string[],
): { command: string; params: Record<string, unknown> }[] {
  return [
    { command: 'assign_material', params: { materialName: to, entityIds } },
    { command: 'fea_mesh', params: { analysisId } },
    { command: 'fea_solve', params: { analysisId } },
    { command: 'compute_margins', params: { analysisId } },
  ];
}
