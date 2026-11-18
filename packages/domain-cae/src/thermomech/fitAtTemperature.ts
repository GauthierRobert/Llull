/** fit_at_temperature (PHY-04, TR-TMC-20/21): hole/shaft clearance of a mixed-material fit at operating temperatures. */

import { clearanceAt, intentOf, type FitIntent } from './fitMath';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { cteProviders, fitReport, fitRows, lameInputOf, limitsOf, temperaturePairs, type FitBasis } from './fitSteps';

const quantity = z.object({
  value: z.number().describe('Value.'),
  unit: z.string().describe("Unit, e.g. 'degC', 'K', 'degF', 'MPa', '1/K'."),
});
const limits = z.object({
  nominal: z.number().positive().describe('Nominal diameter in document units (equal for hole and shaft).'),
  upper: z.number().describe('Upper deviation from nominal in document units (e.g. +0.021 for an H7 hole of 20 mm).'),
  lower: z.number().describe('Lower deviation from nominal in document units (e.g. 0 for H7); must not exceed upper.'),
});
const cte = z.object({
  alpha: quantity.describe("Secant CTE, unit of 1/K (e.g. { value: 23e-6, unit: '1/K' })."),
  referenceTemperature: quantity.describe(
    'Temperature the secant CTE is referenced to (the datasheet statement), e.g. { value: 20, unit: "degC" }.',
  ),
  source: z
    .string()
    .optional()
    .describe('Where the value comes from (recorded in provenance; it stays unverified without a material record).'),
});
const basis = z.object({
  kind: z
    .enum(['secant', 'instantaneous'])
    .describe('secant: alpha(T) is referenced to referenceTemperature; instantaneous: alpha is d(strain)/dT.'),
  referenceTemperature: quantity.optional().describe('Required when kind is secant.'),
});

/**
 * @affects nothing — read-only; data = FitResult { unit, specTemperature, intent, intentSource, rows[{ temperature, holeDiameter, shaftDiameter,
 *   clearance, status, code?, unverified, reviewRequired, disposition, provenance }], provenance { formula, cte[], limits[] }, assumptions, summary }
 * @invariant spec temperature never defaulted; every row reviewRequired; failing rows disposition pending_human (no agent disposition);
 *   unverified = OR of the CTE (and E, nu) flags; negative clearance = interference; 20 degC rows reproduce the limits exactly
 * @failure TMC_SPEC_TEMPERATURE_MISSING, TMC_FIT_LIMITS_MISSING, TMC_FIT_NOT_A_PAIR, TMC_FIT_TEMPERATURES_MISSING, TMC_MATERIAL_NO_CTE,
 *   TMC_CTE_BASIS_UNKNOWN, TMC_CTE_SOURCE_CONFLICT, TMC_PROPERTY_OUT_OF_RANGE (data.cause = PHY-01 refusal), MAT_RECORD_NOT_FOUND, MAT_UNIT_* -> rejection
 */
export const fitAtTemperature = defineCommand({
  name: 'fit_at_temperature',
  annotations: { readOnly: true },
  description:
    'Clearance of a hole/shaft fit at operating temperatures. Give explicit limits for the hole and the shaft (nominal diameter and ' +
    "upper/lower deviations in document units, valid at specTemperature) and each part's CTE: a document material (holeMaterial / " +
    'shaftMaterial = create_material name; a thermalStrain model is preferred, a cte model needs cteBasis[material] = secant with a ' +
    'reference temperature, or instantaneous) or an explicit secant CTE (holeCte / shaftCte with its reference temperature). ' +
    'specTemperature is the temperature the limits apply at and has NO default. Temperatures: `temperatures` (both parts), `range` ' +
    '{min, max, steps}, or per-part `holeTemperatures` + `shaftTemperatures` (same length), each with a unit. D(T) = D_spec (1 + a_sec (T - T_spec)) ' +
    'is applied to every limit diameter. Returns per row min/max clearance in document length units (negative = interference), a status ' +
    '(clearance, interference, interference_possible, clearance_possible), code TMC_FIT_INTERFERENCE / TMC_FIT_LOOSE against the fit intent ' +
    '(derived from the limits at specTemperature unless given), `unverified`, and the formula and CTE sources; every row needs review by a ' +
    'qualified engineer (disposition pending_human on failing rows). Optional `lame` adds contact pressure and hub bore hoop stress ' +
    '(elastic, constant E and nu). Use before approving a mixed-material fit; next: change materials / tolerances, or hand a failing row to a human reviewer.',
  params: z.object({
    hole: limits.optional().describe('Hole limits (REQUIRED; missing -> TMC_FIT_LIMITS_MISSING).'),
    shaft: limits.optional().describe('Shaft limits (REQUIRED; missing -> TMC_FIT_LIMITS_MISSING).'),
    specTemperature: quantity
      .optional()
      .describe('REQUIRED, never defaulted: temperature the limits apply at, e.g. { value: 20, unit: "degC" }.'),
    holeMaterial: z
      .string()
      .optional()
      .describe('Hole part material (create_material name) whose thermalStrain / cte property model gives the CTE.'),
    shaftMaterial: z.string().optional().describe('Shaft part material (create_material name).'),
    holeCte: cte.optional().describe('Explicit CTE of the hole part (alternative to holeMaterial).'),
    shaftCte: cte.optional().describe('Explicit CTE of the shaft part (alternative to shaftMaterial).'),
    cteBasis: z
      .record(z.string(), basis)
      .optional()
      .describe('Basis of the cte model per material name (PHY-01 models carry no basis field).'),
    temperatures: z.array(quantity).optional().describe('Operating temperatures applied to hole and shaft together.'),
    range: z
      .object({
        min: quantity.describe('First temperature.'),
        max: quantity.describe('Last temperature (same dimension).'),
        steps: z.number().int().min(2).max(200).describe('Number of temperatures, ends included (2 to 200).'),
      })
      .optional()
      .describe('Evenly spaced operating temperatures (both parts).'),
    holeTemperatures: z
      .array(quantity)
      .optional()
      .describe('Hole temperatures, paired by index with shaftTemperatures (different part temperatures).'),
    shaftTemperatures: z.array(quantity).optional().describe('Shaft temperatures, paired by index with holeTemperatures.'),
    intent: z
      .enum(['clearance', 'interference', 'transition'])
      .optional()
      .describe('Intended fit; default derived from the limits at specTemperature.'),
    lame: z
      .object({
        hubOuterDiameter: z.number().positive().describe('Hub outer diameter in document units (> nominal).'),
        hubE: quantity.describe("Hub Young's modulus, pressure unit, e.g. { value: 70000, unit: 'MPa' }."),
        hubNu: z.number().describe("Hub Poisson's ratio."),
        shaftE: quantity.describe("Solid shaft Young's modulus."),
        shaftNu: z.number().describe("Shaft Poisson's ratio."),
      })
      .optional()
      .describe('Adds Lame contact pressure (solid shaft in a hub) and hub bore hoop stress per row.'),
  }),
  run: (doc, params): CommandResult => {
    const limitsPhase = limitsOf(doc, params);
    if (!limitsPhase.ok) return limitsPhase.result;
    const { specKelvin, hole, shaft } = limitsPhase.value;
    const pairs = temperaturePairs(doc, params);
    if (!pairs.ok) return pairs.result;
    const providers = cteProviders(doc, params);
    if (!providers.ok) return providers.result;
    const lame = lameInputOf(doc, params, hole.nominal);
    if (!lame.ok) return lame.result;
    const atSpec = clearanceAt(hole, shaft, 0, 0).clearance;
    const intent: FitIntent = params.intent ?? intentOf(atSpec);
    const basis: FitBasis = { doc, specKelvin, hole, shaft, providers: providers.value, lame: lame.value, intent };
    const rows = fitRows(basis, pairs.value);
    if (!rows.ok) return rows.result;
    return fitReport(basis, params, rows.value);
  },
});
