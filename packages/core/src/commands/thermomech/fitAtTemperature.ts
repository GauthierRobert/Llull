/** fit_at_temperature (PHY-04, TR-TMC-20/21): hole/shaft clearance of a mixed-material fit at operating temperatures. */

import { codeOf, clearanceAt, intentOf, lameAt, statusOf, type FitIntent, type LameInput } from './fitMath';
import { explicitCteProvider, isCteRefusal, materialCteProvider, type CteBasis, type CteProvider, type CteRefusal } from './materialCte';
import { convertTo, failed, toKelvin, type Quantity } from './thermoUnits';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { commandError, rejection, report } from '../noop';

const FORMULA = 'D(T) = D_spec (1 + a_sec (T - T_spec))';
const MAX_ROWS = 200;
const PAIR_TOLERANCE = 1e-6;

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

type CteSide = 'hole' | 'shaft';

const refusal = (doc: CadDocument, code: string, reason: string, remediation: string, path: string, cause?: unknown): CommandResult => ({
  ...rejection(doc, `fit_at_temperature: ${code} — ${reason}; no-op.`, commandError(code, remediation, [], [path])),
  data: { code, reason, remediation, path, ...(cause !== undefined ? { cause } : {}) },
});

const refusalOf = (doc: CadDocument, refused: CteRefusal): CommandResult =>
  refusal(doc, refused.code, refused.reason, refused.remediation, refused.path, refused.cause);

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
    if (params.specTemperature === undefined) {
      return refusal(
        doc,
        'TMC_SPEC_TEMPERATURE_MISSING',
        'specTemperature is required (the temperature the limits apply at)',
        'give the temperature the drawing limits apply at, e.g. specTemperature = { value: 20, unit: "degC" }',
        'specTemperature',
      );
    }
    const specKelvin = toKelvin(params.specTemperature);
    if (failed(specKelvin))
      return refusal(doc, specKelvin.code, specKelvin.message, 'give specTemperature in K, degC or degF', 'specTemperature.unit');
    if (params.hole === undefined || params.shaft === undefined) {
      return refusal(
        doc,
        'TMC_FIT_LIMITS_MISSING',
        `${params.hole === undefined ? 'hole' : 'shaft'} limits are missing`,
        'give hole and shaft as { nominal, upper, lower } in document units (basic or untoleranced sizes have no limits)',
        params.hole === undefined ? 'hole' : 'shaft',
      );
    }
    const { hole, shaft } = params;
    for (const [side, part] of [
      ['hole', hole],
      ['shaft', shaft],
    ] as const) {
      if (!(part.upper >= part.lower)) {
        return refusal(
          doc,
          'TMC_FIT_LIMITS_MISSING',
          `${side}.upper ${part.upper} is below ${side}.lower ${part.lower}`,
          'upper must be >= lower deviation',
          `${side}.upper`,
        );
      }
    }
    if (Math.abs(hole.nominal - shaft.nominal) > PAIR_TOLERANCE * Math.max(hole.nominal, shaft.nominal)) {
      return refusal(
        doc,
        'TMC_FIT_NOT_A_PAIR',
        `hole nominal ${hole.nominal} and shaft nominal ${shaft.nominal} ${doc.units} differ by more than ${PAIR_TOLERANCE} relative`,
        'pick the mating hole and shaft features (equal nominal size)',
        'shaft.nominal',
      );
    }

    const requested = (params.temperatures?.length ?? 0) + (params.range?.steps ?? 0) + (params.holeTemperatures?.length ?? 0);
    if (requested > MAX_ROWS) {
      return refusal(
        doc,
        'TMC_FIT_TEMPERATURES_MISSING',
        `${requested} rows requested, the limit is ${MAX_ROWS}`,
        'give at most 200 temperatures in total (temperatures + range.steps + holeTemperatures)',
        'temperatures',
      );
    }
    const pairs: { hole: Quantity; shaft: Quantity }[] = [];
    for (const temperature of params.temperatures ?? []) pairs.push({ hole: temperature, shaft: temperature });
    if (params.range !== undefined) {
      const top = convertTo(params.range.max, params.range.min.unit);
      if (failed(top)) return refusal(doc, top.code, top.message, 'give range.min and range.max in the same dimension', 'range.max.unit');
      for (let i = 0; i < params.range.steps; i += 1) {
        const value = params.range.min.value + ((top - params.range.min.value) * i) / (params.range.steps - 1);
        pairs.push({ hole: { value, unit: params.range.min.unit }, shaft: { value, unit: params.range.min.unit } });
      }
    }
    const holeTemperatures = params.holeTemperatures ?? [];
    const shaftTemperatures = params.shaftTemperatures ?? [];
    if (holeTemperatures.length !== shaftTemperatures.length) {
      return refusal(
        doc,
        'TMC_FIT_TEMPERATURES_MISSING',
        'holeTemperatures and shaftTemperatures differ in length',
        'give one shaft temperature per hole temperature',
        'shaftTemperatures',
      );
    }
    holeTemperatures.forEach((temperature, i) => pairs.push({ hole: temperature, shaft: shaftTemperatures[i] ?? temperature }));
    if (pairs.length === 0 || pairs.length > MAX_ROWS) {
      return refusal(
        doc,
        'TMC_FIT_TEMPERATURES_MISSING',
        pairs.length === 0 ? 'no operating temperature given' : `${pairs.length} rows exceed the limit of ${MAX_ROWS}`,
        'give temperatures, range or holeTemperatures + shaftTemperatures (at most 200 rows)',
        'temperatures',
      );
    }

    const bases = new Map<string, CteBasis>();
    for (const [name, given] of Object.entries(params.cteBasis ?? {})) {
      if (given.kind === 'instantaneous') bases.set(name, { kind: 'instantaneous' });
      else if (given.referenceTemperature === undefined) bases.set(name, { kind: 'unstated' });
      else {
        const referenceKelvin = toKelvin(given.referenceTemperature);
        if (failed(referenceKelvin))
          return refusal(
            doc,
            referenceKelvin.code,
            referenceKelvin.message,
            'give the reference temperature in K, degC or degF',
            `cteBasis.${name}.referenceTemperature.unit`,
          );
        bases.set(name, { kind: 'secant', referenceKelvin });
      }
    }
    const providerFor = (side: CteSide): CteProvider | CteRefusal => {
      const material = side === 'hole' ? params.holeMaterial : params.shaftMaterial;
      const explicit = side === 'hole' ? params.holeCte : params.shaftCte;
      if (material !== undefined && explicit !== undefined) {
        return {
          code: 'TMC_CTE_SOURCE_CONFLICT',
          reason: `${side}Material and ${side}Cte are both given`,
          remediation: `give either ${side}Material or ${side}Cte`,
          path: `${side}Cte`,
        };
      }
      if (explicit !== undefined) {
        const alpha = convertTo(explicit.alpha, '1/K');
        const reference = toKelvin(explicit.referenceTemperature);
        if (failed(alpha))
          return { code: alpha.code, reason: alpha.message, remediation: 'give alpha in 1/K', path: `${side}Cte.alpha.unit` };
        if (failed(reference))
          return {
            code: reference.code,
            reason: reference.message,
            remediation: 'give a temperature unit',
            path: `${side}Cte.referenceTemperature.unit`,
          };
        return explicitCteProvider(alpha, reference, explicit.source ?? '');
      }
      if (material === undefined) {
        return {
          code: 'TMC_MATERIAL_NO_CTE',
          reason: `the ${side} has neither a material nor an explicit CTE`,
          remediation: `give ${side}Material (with a thermalStrain or cte property model) or ${side}Cte`,
          path: `${side}Material`,
        };
      }
      return materialCteProvider(doc.materials, material, bases.get(material) ?? { kind: 'unstated' }, `${side}Material`);
    };
    const holeProvider = providerFor('hole');
    if (isCteRefusal(holeProvider)) return refusalOf(doc, holeProvider);
    const shaftProvider = providerFor('shaft');
    if (isCteRefusal(shaftProvider)) return refusalOf(doc, shaftProvider);

    let lame: LameInput | undefined;
    if (params.lame !== undefined) {
      const hubE = convertTo(params.lame.hubE, 'MPa');
      const shaftE = convertTo(params.lame.shaftE, 'MPa');
      if (failed(hubE) || failed(shaftE)) {
        const failure = failed(hubE) ? hubE : (shaftE as Exclude<typeof shaftE, number>);
        return refusal(doc, failure.code, failure.message, "give E in a pressure unit, e.g. 'MPa'", 'lame.hubE.unit');
      }
      if (!(params.lame.hubOuterDiameter > hole.nominal) || !(hubE > 0) || !(shaftE > 0)) {
        return refusal(
          doc,
          'TMC_FIT_LIMITS_MISSING',
          'lame needs hubOuterDiameter > nominal and positive moduli',
          'fix the lame inputs',
          'lame',
        );
      }
      lame = { hubOuterRadius: params.lame.hubOuterDiameter / 2, hubE, hubNu: params.lame.hubNu, shaftE, shaftNu: params.lame.shaftNu };
    }

    const atSpec = clearanceAt(hole, shaft, 0, 0).clearance;
    const intent: FitIntent = params.intent ?? intentOf(atSpec);
    const rows = [];
    for (const pair of pairs) {
      const holeKelvin = toKelvin(pair.hole);
      const shaftKelvin = toKelvin(pair.shaft);
      if (failed(holeKelvin))
        return refusal(doc, holeKelvin.code, holeKelvin.message, 'give temperatures in K, degC or degF', 'temperatures.unit');
      if (failed(shaftKelvin))
        return refusal(doc, shaftKelvin.code, shaftKelvin.message, 'give temperatures in K, degC or degF', 'temperatures.unit');
      const holeStrain = holeProvider.strainAt(holeKelvin, specKelvin);
      if (isCteRefusal(holeStrain)) return refusalOf(doc, holeStrain);
      const shaftStrain = shaftProvider.strainAt(shaftKelvin, specKelvin);
      if (isCteRefusal(shaftStrain)) return refusalOf(doc, shaftStrain);
      const fit = clearanceAt(hole, shaft, holeStrain.strain, shaftStrain.strain);
      const code = codeOf(fit.clearance, intent);
      const reasons = [
        ...new Set([
          ...holeStrain.unverifiedReasons,
          ...shaftStrain.unverifiedReasons,
          ...(lame !== undefined ? ['explicit E, nu without a sourced material record'] : []),
        ]),
      ];
      const elastic = lame !== undefined ? lameAt(fit.clearance, hole.nominal, lame) : undefined;
      const samplingError = Math.max(holeStrain.samplingError ?? 0, shaftStrain.samplingError ?? 0);
      rows.push({
        rowKey: `hole ${pair.hole.value} ${pair.hole.unit} | shaft ${pair.shaft.value} ${pair.shaft.unit}`,
        temperature: { hole: pair.hole, shaft: pair.shaft },
        ...fit,
        status: statusOf(fit.clearance, intent),
        ...(code !== undefined ? { code } : {}),
        ...(elastic !== undefined ? { interferencePressureMPa: elastic.pressure, hubHoopStressMPa: { max: elastic.hubHoopMax } } : {}),
        unverified: reasons.length > 0,
        unverifiedReasons: reasons,
        reviewRequired: true as const,
        reviewReason: 'a fit verdict is an engineering disposition; the formula is linear thermal expansion only (see assumptions)',
        disposition: code !== undefined ? ('pending_human' as const) : ('none' as const),
        provenance: {
          formula: FORMULA,
          thermalStrain: { hole: holeStrain.strain, shaft: shaftStrain.strain },
          ...(samplingError > 0 ? { samplingError } : {}),
        },
      });
    }
    const failing = rows.filter((row) => row.code !== undefined);
    const summary =
      `fit_at_temperature: ${rows.length} row(s), nominal ${hole.nominal} ${doc.units}, intent ${intent}${params.intent === undefined ? ' (derived from the limits)' : ''}, ` +
      `clearance ${Math.min(...rows.map((row) => row.clearance.min)).toPrecision(6)} … ${Math.max(...rows.map((row) => row.clearance.max)).toPrecision(6)} ${doc.units}; ` +
      `${failing.length === 0 ? 'no row violates the intent' : `${failing.length} row(s) flagged ${[...new Set(failing.map((row) => row.code))].join(', ')} (pending human disposition)`}` +
      `${rows.some((row) => row.unverified) ? '; unverified CTE inputs' : ''}; every row needs review by a qualified engineer.`;
    const data = {
      unit: doc.units,
      specTemperature: params.specTemperature,
      intent,
      intentSource: params.intent === undefined ? 'derived_from_limits_at_spec_temperature' : 'given',
      rows,
      provenance: {
        formula: FORMULA,
        cte: [
          { part: 'hole', source: holeProvider.source, basis: holeProvider.basis, conversion: holeProvider.conversion },
          { part: 'shaft', source: shaftProvider.source, basis: shaftProvider.basis, conversion: shaftProvider.conversion },
        ],
        limits: [
          { part: 'hole', ...hole },
          { part: 'shaft', ...shaft },
        ],
      },
      assumptions: [
        'linear thermal expansion applied to every limit diameter, from the specification temperature',
        'uniform temperature inside each part; no elastic deformation, form error or gradient',
        'PMI size dimensions are not available: limits are explicit inputs',
        ...(lame !== undefined
          ? ['Lame: elastic, constant E and nu, solid shaft, hub outer diameter fixed, interference from the row clearance']
          : []),
      ],
      summary,
    };
    return report(doc, summary, data);
  },
});
