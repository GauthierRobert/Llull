/** stress_intensity / crack_growth_rate (PHY-08 FR-FRC-01, 02, 04): read-only K and da/dN queries. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CrackGeometry } from '@core/model/durability';
import type { CadDocument } from '@core/model/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { quantitySchema } from '../shared/schemas';
import { crackOf } from '../fatigue/store';
import { item, REVIEW_NOTE, type Item } from '../fatigue/items';
import { refuseFracture } from './codes';
import { crackGeometrySchema } from './crackCommands';
import { growthRate, rateModelOf } from './growthLaws';
import { betaOf, solvedGeometry, validityOf } from './kSolutions';

const SOURCE = 'handbook K solutions (secant / Tada / Newman-Raju)';

/**
 * @affects nothing; read-only, data { KMPaSqrtM, beta, validity { inRange, limits, accuracy, source }, items, unverified, reviewRequired: true }
 * @invariant K = beta sigma sqrt(pi a); surface crack beta = F / sqrt(Q) at phiDeg (default 90, deepest point) and carries FRC_K_SOLUTION_UNCONFIRMED
 * @failure neither / both of crackId and geometry, unknown crack, bad geometry, stress not a stress -> FRC_PARAMS_INVALID / FRC_CRACK_NOT_FOUND / FRC_CRACK_INVALID;
 *   crack size outside the solution's validity -> FRC_K_SOLUTION_OUT_OF_RANGE (all refusals leave the document unchanged)
 */
export const stressIntensity = defineCommand({
  name: 'stress_intensity',
  annotations: { readOnly: true },
  description:
    'Mode-I stress intensity factor K = beta sigma sqrt(pi a) for a crack (crackId from define_crack, OR an inline `geometry`) under a remote tensile `stress` { value, unit }. ' +
    'Centre crack: beta = sqrt(sec(pi a / W)) (a = half-length, W = width, valid a/W <= 0.4); edge crack: Tada or polynomial; surface crack: Newman-Raju at phiDeg ' +
    '(indicative, FRC_K_SOLUTION_UNCONFIRMED). Returns data { KMPaSqrtM, beta, validity { inRange, limits, accuracy, source }, items[], reviewRequired }. ' +
    'Example: centre crack a 10 mm, W 100 mm, 100 MPa gives K = 18.1749 MPa sqrt(m).',
  params: z.object({
    crackId: z.string().optional().describe('Id of a defined crack. Exclusive with `geometry`.'),
    geometry: crackGeometrySchema.optional().describe('Inline crack geometry (same as define_crack). Exclusive with `crackId`.'),
    stress: quantitySchema.describe('Remote gross tensile stress { value, unit } (MPa, ksi, ...).'),
    phiDeg: z
      .number()
      .optional()
      .describe('Surface cracks only: angle on the crack front in degrees, 0 = surface point, 90 = deepest point (default 90).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, ids: string[] = [], paths: string[] = []): CommandResult =>
      refuseFracture(doc, 'stress_intensity', code, message, ids, paths);
    if ((params.crackId === undefined) === (params.geometry === undefined))
      return fail('FRC_PARAMS_INVALID', 'give exactly one of crackId and geometry', [], ['crackId']);
    const stored = params.crackId === undefined ? undefined : crackOf(doc, params.crackId);
    if (params.crackId !== undefined && stored === undefined)
      return fail('FRC_CRACK_NOT_FOUND', `no crack '${params.crackId}'`, [params.crackId], ['crackId']);
    const geometry: CrackGeometry | undefined = stored?.geometry ?? params.geometry;
    const solved = geometry === undefined ? 'no geometry' : solvedGeometry(geometry);
    if (typeof solved === 'string')
      return fail('FRC_CRACK_INVALID', solved, params.crackId === undefined ? [] : [params.crackId], ['geometry']);
    const stress = convertValue(params.stress.value, params.stress.unit, 'MPa');
    if (isUnitFailure(stress) || !Number.isFinite(stress.value))
      return fail('FRC_PARAMS_INVALID', `stress unit '${params.stress.unit}' is not a stress`, [], ['stress']);
    const validity = validityOf(solved);
    const ids = params.crackId === undefined ? [] : [params.crackId];
    if (!validity.inRange)
      return fail('FRC_K_SOLUTION_OUT_OF_RANGE', `size ratio outside the validity (${validity.limits})`, ids, ['geometry']);
    const beta = betaOf(solved, ((params.phiDeg ?? 90) * Math.PI) / 180);
    const K = beta * stress.value * Math.sqrt(Math.PI * solved.a);
    const items: Item[] = [];
    if (solved.kind === 'surface_semi_elliptical')
      items.push(
        item('FRC_K_SOLUTION_UNCONFIRMED', 'warning', 'Newman-Raju transcription is unconfirmed (grade C)', 'treat as indicative', ids),
      );
    return report(
      doc,
      `stress_intensity: K = ${K.toPrecision(8)} MPa sqrt(m) (beta ${beta.toPrecision(8)}, ${solved.kind}, a = ${(solved.a * 1000).toPrecision(5)} mm, ${stress.value} MPa). ${REVIEW_NOTE}`,
      {
        KMPaSqrtM: K,
        beta,
        validity,
        items,
        unverified: items.length > 0,
        provenance: { solution: solved.kind, source: SOURCE, a_m: solved.a },
        reviewRequired: true,
      },
    );
  },
});

function growthLawOf(doc: CadDocument, recordId: string, modelId: string): ReturnType<typeof rateModelOf> {
  const material = Object.hasOwn(doc.materials, recordId) ? doc.materials[recordId] : undefined;
  const entry = material?.materialModels?.find((candidate) => candidate.id === modelId);
  if (entry === undefined) return `no model '${modelId}' on material '${recordId}'`;
  return entry.model.kind.startsWith('da_dn_')
    ? rateModelOf(entry.model as Parameters<typeof rateModelOf>[0])
    : `model '${modelId}' is a ${entry.model.kind}, not a growth law`;
}

/**
 * @affects nothing; read-only, data { dadNMPerCycle, dK, R, extrapolated, convention }
 * @invariant 0 below the threshold dKth; Infinity at Kmax >= Kc (Forman / NASGRO); units of the model (m/cycle|MPa*m^0.5 or in/cycle|ksi*in^0.5) are converted
 * @failure unknown material / model -> FRC_MODEL_MISSING; unsupported units / variant -> FRC_UNITS_MISMATCH; R outside [-1, 1) or dK <= 0 -> FRC_PARAMS_INVALID (unchanged doc)
 */
export const crackGrowthRate = defineCommand({
  name: 'crack_growth_rate',
  annotations: { readOnly: true },
  description:
    'Crack growth rate da/dN [m/cycle] of a material growth law (da_dn_paris, walker, forman, nasgro, table) at a stress-intensity range dK { value, unit } (MPa*m^0.5 or ksi*in^0.5) and stress ratio R = Kmin/Kmax. ' +
    'Example: Paris C 1e-11, m 3 at dK 10 MPa sqrt(m) gives 1e-8 m/cycle. extrapolated is true when dK is outside the model data range.',
  params: z.object({
    material: z.string().describe('Material record id.'),
    growthModelId: z.string().describe('Id of the growth law on that record.'),
    dK: quantitySchema.describe('Stress-intensity range { value > 0, unit } with unit MPa*m^0.5 or ksi*in^0.5.'),
    R: z.number().optional().describe('Stress ratio Kmin/Kmax in [-1, 1) (default 0).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseFracture(doc, 'crack_growth_rate', code, message, [params.material], paths);
    const model = growthLawOf(doc, params.material, params.growthModelId);
    if (typeof model === 'string')
      return fail(model.startsWith('no model') || model.includes('not a growth') ? 'FRC_MODEL_MISSING' : 'FRC_UNITS_MISMATCH', model, [
        'growthModelId',
      ]);
    const dK = convertValue(params.dK.value, params.dK.unit, 'MPa*m^0.5');
    if (isUnitFailure(dK) || !(dK.value > 0))
      return fail('FRC_PARAMS_INVALID', `dK must be > 0 in a stress-intensity unit (got ${params.dK.value} ${params.dK.unit})`, ['dK']);
    const R = params.R ?? 0;
    if (!(R >= -1 && R < 1)) return fail('FRC_PARAMS_INVALID', 'R must be in [-1, 1)', ['R']);
    const found = growthRate(model, dK.value, R);
    return report(
      doc,
      `crack_growth_rate: da/dN = ${found.rate.toExponential(6)} m/cycle at dK ${dK.value.toPrecision(6)} MPa sqrt(m), R ${R}${found.extrapolated ? ' (EXTRAPOLATED)' : ''}.`,
      { dadNMPerCycle: found.rate, dK_MPaSqrtM: dK.value, R, extrapolated: found.extrapolated, convention: model.kind },
    );
  },
});
