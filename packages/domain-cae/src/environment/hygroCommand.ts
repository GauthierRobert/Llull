/** hygro_strain (PHY-14 FR-ENV-08): hygroscopic strain eps = beta dM and the equivalent-temperature hand-off. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuseEnv, unverifiedItem, type EnvItem } from './codes';
import { equivalentTemperatures, proportional } from './hygro';
import { describeInput, givenInput, isInputProblem, materialInput, type ResolvedInput } from './inputs';
import { materialProperty, type MaterialMissing } from './materialValue';
import { quantitySchema, sourcedQuantity, type UnitProblem } from './units';

const COMMAND = 'hygro_strain';
const MAX_DIRECTIONS = 3;

/**
 * @affects nothing; read-only, data { strain[], equivalentDeltaT?, handOff, inputs, items, unverified }
 * @invariant eps_i = beta_i dM; dT_eq_i = eps_i / alpha_i; one equivalent temperature is offered only when every dT_eq_i agrees within rel 1e-9
 * @failure non-finite or wrong-dimension value, alpha = 0, length mismatch -> ENV_PARAM_INVALID; no beta -> ENV_PROPERTY_MISSING; unequal beta/alpha -> strain still returned, warning ENV_EQUIVALENT_TEMPERATURE_INVALID
 */
export const hygroStrain = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true },
  description:
    'Hygroscopic (swelling) strain eps = beta * dM from a coefficient of moisture expansion beta and a moisture-content change dM, and the equivalent temperature change for a thermal-strain solver: ' +
    'alpha * dT_eq = beta * dM, so dT_eq = beta dM / alpha. beta {value, unit} is strain per unit moisture content, e.g. {value: 0.001, unit: "1/%"} (strain per % moisture) or unit "1" per unit mass fraction; ' +
    'deltaMoisture {value, unit "%" or "1"} is the content change (the moisture_uptake moisturePercent minus the initial content). Give beta as one value (isotropic) or an array of 1 to 3 principal-direction values ' +
    '(with alpha the same length). Or give `material` (properties cme and cte, read at `temperature`, `direction` for orthotropic data). One dT_eq is returned only if beta/alpha is the same in every direction ' +
    '(rel 1e-9); otherwise the strain is still returned with the warning ENV_EQUIVALENT_TEMPERATURE_INVALID and handOff "cmp06_laminate" (use the composites laminate hygrothermal path). ' +
    'Example: beta 0.001 /%, dM 1.2266 %, alpha 30e-6 /K: strain 1.2266e-3, dT_eq 40.887 K. handOff says which downstream tool takes the result: phy04_equivalent_temperature (thermo-mechanical static) | cmp06_laminate | none. ' +
    'Values without a source (or typical data) set unverified. The command applies no load: it hands over strain and an equivalent temperature.',
  params: z.object({
    beta: z
      .union([
        sourcedQuantity('Coefficient of moisture expansion'),
        z.array(sourcedQuantity('Coefficient of moisture expansion')).min(1).max(MAX_DIRECTIONS),
      ])
      .optional()
      .describe('beta {value, unit "1/%" or "1", source} or an array of 1 to 3 principal-direction values. Omit with `material`.'),
    alpha: z
      .union([
        sourcedQuantity('Coefficient of thermal expansion'),
        z.array(sourcedQuantity('Coefficient of thermal expansion')).min(1).max(MAX_DIRECTIONS),
      ])
      .optional()
      .describe('Thermal expansion alpha {value, unit "1/K", source} (same shape as beta): enables the equivalent temperature.'),
    deltaMoisture: sourcedQuantity('Moisture content change').describe('Moisture content change dM {value, unit "%" or "1"}.'),
    material: z.string().optional().describe('Material id: beta from its cme property, alpha from cte (when not given).'),
    direction: z
      .enum(['1', '2', '3', 'L', 'LT', 'ST', 'normal', 'warp', 'fill'])
      .optional()
      .describe('Property direction for the material lookup.'),
    temperature: quantitySchema.optional().describe('Temperature {value, unit} for a temperature-dependent cte.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseEnv(doc, COMMAND, code, message, params.material === undefined ? [] : [params.material], [path]);
    const failFor = (problem: UnitProblem | MaterialMissing, path: string): CommandResult =>
      'path' in problem
        ? fail('ENV_PARAM_INVALID', problem.message, problem.path)
        : fail(problem.code === 'PROP_NO_MODEL_FOR_PROPERTY' ? 'ENV_PROPERTY_MISSING' : problem.code, problem.reason, path);
    const at = params.temperature === undefined ? {} : { T: params.temperature };
    const list = <T>(value: T | readonly T[] | undefined): readonly T[] | undefined =>
      value === undefined ? undefined : Array.isArray(value) ? value : [value as T];

    const delta = givenInput(params.deltaMoisture, '1', 'deltaMoisture');
    if (isInputProblem(delta)) return failFor(delta, 'deltaMoisture');

    const betas: ResolvedInput[] = [];
    const givenBetas = list(params.beta);
    if (givenBetas !== undefined) {
      for (const [index, entry] of givenBetas.entries()) {
        const beta = givenInput(entry, '1', `beta.${index}`);
        if (isInputProblem(beta)) return failFor(beta, `beta.${index}`);
        betas.push(beta);
      }
    } else if (params.material !== undefined) {
      const found = materialProperty(doc, ctx, params.material, 'cme', '1', at, params.direction);
      if ('reason' in found) return failFor(found, 'material');
      betas.push(materialInput(found));
    } else return fail('ENV_PROPERTY_MISSING', 'no beta: give `beta` or a `material` with a cme property', 'beta');

    const alphas: ResolvedInput[] = [];
    const givenAlphas = list(params.alpha);
    if (givenAlphas !== undefined) {
      if (givenAlphas.length !== betas.length)
        return fail('ENV_PARAM_INVALID', `alpha has ${givenAlphas.length} value(s), beta ${betas.length}`, 'alpha');
      for (const [index, entry] of givenAlphas.entries()) {
        const alpha = givenInput(entry, '1/K', `alpha.${index}`);
        if (isInputProblem(alpha)) return failFor(alpha, `alpha.${index}`);
        alphas.push(alpha);
      }
    } else if (params.material !== undefined && betas.length === 1) {
      const found = materialProperty(doc, ctx, params.material, 'cte', '1/K', at, params.direction);
      if (!('reason' in found)) alphas.push(materialInput(found));
    }
    if (alphas.some((alpha) => alpha.value === 0))
      return fail('ENV_PARAM_INVALID', 'alpha must be non-zero to form an equivalent temperature', 'alpha');

    const strains = betas.map((beta) => beta.value * delta.value);
    const temperatures =
      alphas.length === betas.length
        ? equivalentTemperatures(
            strains,
            alphas.map((alpha) => alpha.value),
          )
        : null;
    const items: EnvItem[] = [];
    const equal = temperatures !== null && proportional(temperatures);
    if (temperatures !== null && !equal)
      items.push({
        code: 'ENV_EQUIVALENT_TEMPERATURE_INVALID',
        severity: 'warning',
        message: `beta/alpha differs between directions (dT_eq ${temperatures.map((t) => t.toPrecision(6)).join(', ')} K): one equivalent temperature does not reproduce the strain field`,
      });
    const inputs: Record<string, ReturnType<typeof describeInput>> = { deltaMoisture: describeInput(delta) };
    betas.forEach((beta, index) => (inputs[`beta${betas.length > 1 ? `.${index}` : ''}`] = describeInput(beta)));
    alphas.forEach((alpha, index) => (inputs[`alpha${alphas.length > 1 ? `.${index}` : ''}`] = describeInput(alpha)));
    const unverifiedNames = Object.entries(inputs)
      .filter(([, input]) => input.unverified)
      .map(([name]) => name);
    if (unverifiedNames.length > 0) items.push(unverifiedItem(`input ${unverifiedNames.join(', ')}`));
    const handOff = equal ? 'phy04_equivalent_temperature' : betas.length > 1 || temperatures !== null ? 'cmp06_laminate' : 'none';
    const equivalent = equal && temperatures !== null ? temperatures[0] : undefined;
    const data = {
      strain: strains.length === 1 ? strains[0] : strains,
      strains,
      ...(equivalent === undefined ? {} : { equivalentDeltaT: { value: equivalent, unit: 'K' } }),
      handOff,
      inputs,
      items,
      unverified: unverifiedNames.length > 0,
    };
    const warning =
      temperatures !== null && !equal
        ? ' ENV_EQUIVALENT_TEMPERATURE_INVALID: beta/alpha is not proportional, use the laminate hygrothermal path (strain returned).'
        : '';
    return report(
      doc,
      `${COMMAND}: strain ${strains.map((s) => s.toPrecision(9)).join(', ')} for dM ${delta.value * 100} %${equivalent === undefined ? '' : `; equivalent dT ${equivalent.toPrecision(9)} K`}; hand-off ${handOff}.${warning}${data.unverified ? ` Unverified inputs: ${unverifiedNames.join(', ')}.` : ''}`,
      data,
    );
  },
});
