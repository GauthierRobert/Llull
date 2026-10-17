/** thermal_analytic_check: closed-form heat-transfer solutions used to verify thermal models (PHY-03 TR-THM-40). */

import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { commandError, rejection, report } from '../noop';
import { CHECK_SPECS, type CheckSpec, type Domain, type InputSpec } from './analyticChecks';
import { physicalConstants } from './constants';
import { fromSi, siToSystem, siUnitOf, toSi, UNIT_SYSTEMS, type ThermalKind } from '../../lib/thermalUnits';

const CHECKS = [
  'plane_wall',
  'slab_generation',
  'semi_infinite',
  'lumped',
  'fin',
  'parallel_plates',
  'view_factor',
  'stefan',
  'stefan_boltzmann',
  'interface',
] as const;

const CONFIGURATIONS = ['parallel_rectangles', 'perpendicular_rectangles', 'coaxial_discs', 'cube_summation'] as const;

const quantity = z.object({
  value: z.number().describe('Numeric value.'),
  unit: z.string().describe("Unit, e.g. 'W/(m*K)', 'mm', 'degC', '1'."),
});

const specKey = (check: string, configuration: string | undefined): string =>
  check === 'view_factor' ? `view_factor:${configuration ?? ''}` : check;

const inputDoc = (spec: CheckSpec): string =>
  spec.inputs.length === 0
    ? 'no inputs'
    : spec.inputs.map((i) => `${i.name}${i.optional === true ? '?' : ''} (${i.describe}; ${i.kind})`).join(', ');

const CATALOG_TEXT = Object.entries(CHECK_SPECS)
  .map(([key, spec]) => `${key.replace(':', ' / ')}: ${inputDoc(spec)}`)
  .join(' · ');

const DOMAIN_TEXT: Record<Domain, string> = {
  positive: 'must be > 0',
  nonnegative: 'must be >= 0',
  any: '',
  absolute: 'must be an absolute temperature above 0 K',
  emissivity: 'is an emissivity and must satisfy 0 < eps <= 1',
};

const domainViolation = (spec: InputSpec, si: number): boolean => {
  if (spec.domain === 'positive' || spec.domain === 'absolute') return !(si > 0);
  if (spec.domain === 'nonnegative') return !(si >= 0);
  if (spec.domain === 'emissivity') return !(si > 0 && si <= 1);
  return false;
};

const domainCode = (spec: InputSpec): string => {
  if (spec.domain === 'emissivity') return 'THM_EMISSIVITY_INVALID';
  return spec.kind === 'film' ? 'THM_FILM_INVALID' : 'THM_INPUT_INVALID';
};

const refuse = (doc: CadDocument, code: string, why: string, remediation: string, paths: readonly string[]): CommandResult =>
  rejection(doc, `thermal_analytic_check: ${code} — ${why}; no-op.`, commandError(code, remediation, [], paths));

const REMEDIATION_UNITS = 'Give each input as { value, unit } with a unit of the documented dimension (temperatures in degC, K or degF).';
const REMEDIATION_INPUT = 'Fix the listed input; the tool description names every input of each check.';

const formatNumber = (value: number): string => (Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : String(value));

/**
 * @affects nothing — read-only; data { check, configuration?, value, unit, outputs{}, formula, inputs, validity?, physicalConstants?, deckValue?, warnings }
 * @invariant formulas equal generate_thermal_reference.py (1e-12 relative); temperature results in the unit of the first temperature input; sigma and absolute zero are named defaults
 * @failure unknown / missing / extra input or view_factor without configuration -> THM_INPUT_INVALID; wrong dimension -> THM_UNITS_MISMATCH; eps outside (0, 1] ->
 *   THM_EMISSIVITY_INVALID; h <= 0 -> THM_FILM_INVALID; other non-physical values -> THM_INPUT_INVALID (rejections, document unchanged)
 */
export const thermalAnalyticCheck = defineCommand({
  name: 'thermal_analytic_check',
  annotations: { readOnly: true },
  description:
    'Evaluate a textbook closed-form heat-transfer solution, used as the reference a thermal model must reproduce. Pure and read-only. ' +
    'check: plane_wall (flux q in W/m^2, surface temperatures, heat-balance residual), slab_generation (centre temperature), semi_infinite ' +
    '(erf profile after a surface step), lumped (any body via V and As, or sphere d; returns validity { Bi, ok } with Bi < 0.1), fin (efficiency; with Tb and Tinf also heat rate Q adiabatic / convective-tip / corrected-length and tip temperature), parallel_plates ' +
    '(grey infinite plates, W/m^2), view_factor (needs configuration), stefan (Neumann one-phase melting: root lambda, front position, Stefan ' +
    'number), stefan_boltzmann (sigma from the exact SI constants, no inputs), interface (two slabs with a contact conductance). ' +
    'inputs maps each input name (names marked ? are optional) to { value, unit }; dimensionless inputs use unit "1". Inputs per check: ' +
    CATALOG_TEXT +
    '. Returns data { value, unit, outputs{name:{value,unit}}, formula, inputs, validity?, physicalConstants? }; temperature results use the unit of the first ' +
    'temperature input; radiation checks report sigma and absolute zero as named defaults. unitSystem (N-m-kg-s, N-mm-t-s, lbf-in-slinch-s) adds ' +
    'data.deckValue: the primary result expressed for a CalculiX deck in that system. Refuses a wrong dimension (THM_UNITS_MISMATCH), emissivity ' +
    'outside (0, 1] (THM_EMISSIVITY_INVALID), film coefficient <= 0 (THM_FILM_INVALID) or other non-physical inputs (THM_INPUT_INVALID). ' +
    'Next: compare a solved model against value with compare_to_expected.',
  params: z.object({
    check: z.enum(CHECKS).describe('Which closed form to evaluate.'),
    configuration: z
      .enum(CONFIGURATIONS)
      .optional()
      .describe(
        'Required when check is view_factor: parallel_rectangles (a, b, c), perpendicular_rectangles (l, w, h), coaxial_discs (r1, r2, L) or cube_summation (a).',
      ),
    inputs: z.record(z.string(), quantity).describe('Input name -> { value, unit }. Names per check are listed in the tool description.'),
    unitSystem: z
      .enum(UNIT_SYSTEMS)
      .optional()
      .describe('Optional FEA unit system: adds data.deckValue, the primary result converted to it (not for temperatures).'),
  }),
  run: (doc, params): CommandResult => {
    const key = specKey(params.check, params.configuration);
    const spec = CHECK_SPECS[key];
    if (spec === undefined) {
      return refuse(
        doc,
        'THM_INPUT_INVALID',
        'view_factor needs a configuration',
        'Set configuration to one of: ' + CONFIGURATIONS.join(', '),
        ['configuration'],
      );
    }
    const known = new Set(spec.inputs.map((i) => i.name));
    const extra = Object.keys(params.inputs).filter((name) => !known.has(name));
    const missing = spec.inputs.filter((i) => i.optional !== true && !Object.hasOwn(params.inputs, i.name)).map((i) => i.name);
    if (extra.length > 0 || missing.length > 0) {
      const why = [
        missing.length > 0 ? `missing inputs ${missing.join(', ')}` : '',
        extra.length > 0 ? `unknown inputs ${extra.join(', ')}` : '',
      ]
        .filter((part) => part !== '')
        .join('; ');
      return refuse(doc, 'THM_INPUT_INVALID', `${key}: ${why} (expected ${inputDoc(spec)})`, REMEDIATION_INPUT, ['inputs']);
    }
    const values: Record<string, number> = {};
    let temperatureUnit: string | undefined;
    for (const item of spec.inputs) {
      if (!Object.hasOwn(params.inputs, item.name)) continue;
      const given = params.inputs[item.name] as { value: number; unit: string };
      const path = `inputs.${item.name}`;
      const converted = toSi(item.kind, given);
      if (!converted.ok) return refuse(doc, 'THM_UNITS_MISMATCH', `${path}: ${converted.reason}`, REMEDIATION_UNITS, [path]);
      if (domainViolation(item, converted.value)) {
        return refuse(doc, domainCode(item), `${path} = ${given.value} ${given.unit} ${DOMAIN_TEXT[item.domain]}`, REMEDIATION_INPUT, [
          path,
        ]);
      }
      if (item.kind === 'temperature') temperatureUnit ??= given.unit;
      values[item.name] = converted.value;
    }
    const computed = spec.compute(values);
    if ('code' in computed) return refuse(doc, computed.code, computed.reason, REMEDIATION_INPUT, ['inputs']);

    const displayUnit = (kind: ThermalKind): string => (kind === 'temperature' ? (temperatureUnit ?? 'K') : siUnitOf(kind));
    const outputs = Object.fromEntries(
      Object.entries(computed.outputs).map(([name, o]) => [
        name,
        { value: fromSi(o.kind, o.value, displayUnit(o.kind)), unit: displayUnit(o.kind) },
      ]),
    );
    const primary = computed.outputs[computed.primary];
    const shown = outputs[computed.primary];
    if (primary === undefined || shown === undefined)
      return refuse(doc, 'THM_INPUT_INVALID', 'internal: no primary output', REMEDIATION_INPUT, []);
    const deckable = primary.kind !== 'temperature' && primary.kind !== 'temperatureDifference';
    const data = {
      check: params.check,
      ...(params.configuration !== undefined ? { configuration: params.configuration } : {}),
      value: shown.value,
      unit: shown.unit,
      primary: computed.primary,
      outputs,
      formula: spec.formula,
      inputs: params.inputs,
      ...(computed.validity !== undefined ? { validity: computed.validity } : {}),
      ...(computed.usesConstants === true ? { physicalConstants: physicalConstants() } : {}),
      ...(params.unitSystem !== undefined && deckable
        ? {
            deckValue: {
              unitSystem: params.unitSystem,
              quantity: primary.kind,
              siUnit: siUnitOf(primary.kind),
              value: siToSystem(primary.kind, primary.value, params.unitSystem),
            },
          }
        : {}),
      warnings: computed.warnings ?? [],
    };
    const listing = Object.entries(outputs)
      .map(([name, o]) => `${name} = ${formatNumber(o.value)} ${o.unit}`)
      .join('; ');
    const caution = (computed.warnings ?? []).length > 0 ? ` WARNING: ${(computed.warnings ?? []).join('; ')}.` : '';
    return report(doc, `thermal_analytic_check ${key.replace(':', ' ')}: ${listing}.${caution}`, data);
  },
});
