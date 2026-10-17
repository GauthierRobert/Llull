/** thermal_stress_check (PHY-04 §5.5): closed-form thermal stress, distortion, shrink-fit and CTE-conversion checks with units. */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import { CANONICAL_UNIT, CHECKS, INPUT_SPECS, evaluateCheck, type CheckName, type Extras, type InputKind } from './thermalChecks';
import { convertTo, differenceToKelvin, failed, toKelvin, type Quantity } from './thermoUnits';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { codedRejection, report } from '../noop';

const quantity = z.object({
  value: z.number().describe('Value.'),
  unit: z.string().describe("Unit, e.g. 'MPa', 'mm', '1/K', 'K', 'degC', '1' (dimensionless)."),
});

const refusal = (doc: CadDocument, code: string, reason: string, remediation: string, path: string): CommandResult => ({
  ...codedRejection(doc, 'thermal_stress_check', code, reason, remediation, [], [path]),
  data: { code, reason, remediation, path },
});

function convertInput(kind: InputKind, q: Quantity): ReturnType<typeof convertTo> {
  if (kind === 'delta') return differenceToKelvin(q);
  if (kind === 'temperature') return toKelvin(q);
  return convertTo(q, CANONICAL_UNIT[kind]);
}

const describeInputs = (check: CheckName): string =>
  INPUT_SPECS[check]
    .map((spec) => `${spec.key}${spec.optional === true ? '?' : ''} (${CANONICAL_UNIT[spec.kind]}: ${spec.meaning})`)
    .join('; ');

/**
 * @affects nothing — read-only; data { check, results | rows, units, formulas[], inputs (canonical units), assumptions[], defaults[], reviewRequired }
 * @invariant equals docs/physics/04-thermo-mechanical/validation/generate_thermomech_reference.py (same algebra); units checked by dimension;
 *   temperature differences use the unit scale only (65 degC = 65 K)
 * @failure TMC_CHECK_INPUT_MISSING, TMC_CHECK_INPUT_UNKNOWN, TMC_CHECK_INPUT_INVALID, MAT_UNIT_DIMENSION / MAT_UNIT_INVALID -> rejection
 */
export const thermalStressCheck = defineCommand({
  name: 'thermal_stress_check',
  annotations: { readOnly: true },
  description:
    'Closed-form thermo-mechanical hand calculations with units, for sanity checks and benchmarks (no FE). `check` selects the formula and ' +
    '`inputs` is a record of { value, unit } (any unit of the right dimension; temperature DIFFERENCES in K or degC). ' +
    `restrained: ${describeInputs('restrained')} -> uniaxial, biaxial, triaxial stress in MPa. ` +
    `inclusion: ${describeInputs('inclusion')} -> stresses inside and outside a hot disc in an infinite plate (NAFEMS T1). ` +
    `bimetal: ${describeInputs('bimetal')} -> Timoshenko curvature (1/mm) with an equilibrium cross-check. ` +
    `thick_cylinder: ${describeInputs('thick_cylinder')}; optional \`points\` = radii -> radial/hoop/axial stress rows in MPa. ` +
    `gradient_beam: ${describeInputs('gradient_beam')} -> curvature, mid-span bow, cantilever tip; stress 0. ` +
    `shrink_fit: ${describeInputs('shrink_fit')} -> Lame contact pressure and hub bore hoop stress (MPa); the thermal group adds the interference at temperature. ` +
    `cte_secant: ${describeInputs('cte_secant')}, plus \`points\` = temperatures, and either alpha0/alpha1/lawTemperature or \`table\` = instantaneous ` +
    '[{T, alpha}] rows -> instantaneous and secant CTE, thermal strain and optional re-referencing. Returns the formulas, inputs and assumptions. ' +
    'Compressive stress is negative; a fit across temperatures is fit_at_temperature.',
  params: z.object({
    check: z.enum(CHECKS).describe('Which closed form to evaluate.'),
    inputs: z
      .record(z.string(), quantity)
      .describe('Named inputs of the check, each { value, unit } (names listed in the command description).'),
    points: z.array(quantity).optional().describe('thick_cylinder: radii (length) to evaluate; cte_secant: temperatures (K, degC, degF).'),
    table: z
      .array(z.object({ T: quantity.describe('Temperature.'), alpha: quantity.describe('Instantaneous CTE, unit of 1/K.') }))
      .optional()
      .describe('cte_secant: instantaneous CTE table (piecewise linear, strictly increasing T) instead of alpha0 / alpha1.'),
  }),
  run: (doc, params): CommandResult => {
    const check = params.check;
    const specs = INPUT_SPECS[check];
    const allowed = new Set(specs.map((spec) => spec.key));
    const unknown = Object.keys(params.inputs).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      return refusal(
        doc,
        'TMC_CHECK_INPUT_UNKNOWN',
        `unknown input(s) ${unknown.join(', ')} for ${check}`,
        `${check} takes ${[...allowed].join(', ')}`,
        `inputs.${unknown[0]}`,
      );
    }
    const values: Record<string, number> = {};
    const canonical: Record<string, Quantity> = {};
    for (const spec of specs) {
      const given = Object.hasOwn(params.inputs, spec.key) ? params.inputs[spec.key] : undefined;
      if (given === undefined) {
        if (spec.optional === true) continue;
        return refusal(
          doc,
          'TMC_CHECK_INPUT_MISSING',
          `${check} needs ${spec.key} (${spec.meaning})`,
          `add inputs.${spec.key} = { value, unit: '${CANONICAL_UNIT[spec.kind]}' }`,
          `inputs.${spec.key}`,
        );
      }
      const converted = convertInput(spec.kind, given);
      if (failed(converted)) {
        return refusal(
          doc,
          converted.code,
          `inputs.${spec.key}: ${converted.message}`,
          `give ${spec.key} in a unit of the dimension of '${CANONICAL_UNIT[spec.kind]}'`,
          `inputs.${spec.key}.unit`,
        );
      }
      if (!Number.isFinite(converted))
        return refusal(doc, 'TMC_CHECK_INPUT_INVALID', `inputs.${spec.key} is not finite`, 'give finite numbers', `inputs.${spec.key}`);
      values[spec.key] = converted;
      canonical[spec.key] = { value: converted, unit: CANONICAL_UNIT[spec.kind] };
    }
    const pointKind: InputKind = check === 'cte_secant' ? 'temperature' : 'length';
    const points: number[] = [];
    for (const [i, point] of (params.points ?? []).entries()) {
      const converted = convertInput(pointKind, point);
      if (failed(converted))
        return refusal(
          doc,
          converted.code,
          `points.${i}: ${converted.message}`,
          `give points in a unit of '${CANONICAL_UNIT[pointKind]}'`,
          `points.${i}.unit`,
        );
      points.push(converted);
    }
    const table: (readonly [number, number])[] = [];
    for (const [i, row] of (params.table ?? []).entries()) {
      const temperature = toKelvin(row.T);
      const alpha = convertTo(row.alpha, '1/K');
      if (failed(temperature))
        return refusal(doc, temperature.code, `table.${i}.T: ${temperature.message}`, 'give a temperature unit', `table.${i}.T.unit`);
      if (failed(alpha))
        return refusal(doc, alpha.code, `table.${i}.alpha: ${alpha.message}`, 'give alpha in 1/K', `table.${i}.alpha.unit`);
      table.push([temperature, alpha]);
    }
    const temperatureUnit = check === 'cte_secant' ? (params.points?.[0]?.unit ?? 'K') : 'K';
    const back = convertValue(1, 'K', temperatureUnit);
    if (isUnitFailure(back)) return refusal(doc, back.code, back.message, 'give a temperature unit', 'points.0.unit');
    const extras: Extras = {
      points,
      table,
      temperatureUnit,
      fromKelvin: (kelvin) => {
        const converted = convertValue(kelvin, 'K', temperatureUnit);
        return isUnitFailure(converted) ? Number.NaN : converted.value;
      },
    };
    const output = evaluateCheck(check, values, extras);
    if (typeof output === 'string')
      return refusal(doc, 'TMC_CHECK_INPUT_INVALID', output, `fix the inputs of ${check}: ${describeInputs(check)}`, 'inputs');
    const non = [...Object.values(output.results ?? {}).map((s) => s.value), ...(output.rows ?? []).flatMap((row) => Object.values(row))];
    if (non.some((value) => !Number.isFinite(value))) {
      return refusal(
        doc,
        'TMC_CHECK_INPUT_INVALID',
        'the inputs give a non-finite result (singular geometry or material)',
        `fix the inputs of ${check}`,
        'inputs',
      );
    }
    const headline =
      output.results !== undefined
        ? Object.entries(output.results)
            .map(([name, s]) => `${name} ${s.value.toPrecision(9)} ${s.unit}`)
            .join(', ')
        : `${output.rows?.length ?? 0} row(s)`;
    const summary = `thermal_stress_check ${check}: ${headline}. Closed form with stated assumptions; not a substitute for analysis review.`;
    return report(doc, summary, { check, ...output, inputs: canonical, reviewRequired: true });
  },
});
