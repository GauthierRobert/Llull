/** moisture_uptake (PHY-14 FR-ENV-06, 07): Fickian moisture uptake or dry-out of a plate. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { refuseEnv, unverifiedItem, type EnvItem } from './codes';
import { contentAt, effectiveThickness, fractionalUptake, logSpaced, TAU_99, timeToFraction } from './fick';
import { describeInput, givenInput, isInputProblem } from './inputs';
import type { MaterialMissing } from './materialValue';
import { spaceEnvironmentOf } from './model';
import { boundaryInput, diffusivityInput, initialInput, type UptakeInputs } from './uptakeInputs';
import { quantitySchema, sourcedQuantity, type UnitProblem } from './units';

const COMMAND = 'moisture_uptake';
const CURVE_SAMPLES = 50;
const DEFAULT_TIME_UNIT = 'd';

const DESCRIPTION =
  'Fickian moisture uptake (absorption) or dry-out (desorption) of a flat plate, 1D through the thickness: edges ignored (assumption stated in the result). ' +
  'G(tau) = (M - Mi)/(Mb - Mi) = 1 - 8/pi^2 sum_j exp(-(2j+1)^2 pi^2 tau)/(2j+1)^2, tau = D t / h^2; Mb is the boundary content (the saturation, or the dry value for desorption). ' +
  'faces "one" = the other face sealed (equivalent to both faces of a plate twice as thick). Give `thickness` and the diffusivity as `diffusivity` {value, unit} (e.g. mm^2/s) or take it ' +
  'from a material (`material` with a moistureDiffusivity property, at `temperature` when it depends on T). Absorption needs the saturation M_inf: `saturation` {value, unit "%"}, or `saturationLaw` ' +
  '{a, b, relativeHumidity} (M_inf[%] = a * RH[%]^b, Shen & Springer form), or the material property moistureSaturation; `initial` defaults to 0 % (named default, reported). Desorption needs `initial` ' +
  'and uses `saturation` (default 0 % = vacuum dry-out) as the boundary. Give `exposure` {value, unit} for the content at that time and/or `targets` (fractions in (0,1), e.g. [0.5, 0.9, 0.99]) for the ' +
  'time to reach each; the times come back in `timeUnit` (default the exposure unit, else d). Returns tau, fraction, moisturePercent, timesToFraction[{fraction, tau, time}] and a 50-point log-spaced ' +
  'curve[{t, fraction, moisturePercent}] (t in the time unit). Example: h 2 mm, D 1e-6 mm^2/s, M_inf 1.5 %, 7 d: tau 0.1512, M 1.2266 %, t50 2.277 d. ' +
  'Inputs without a source (or from typical / supplier data) set unverified and the ENV_VALUE_UNVERIFIED warning. A screening model: not a moisture-knockdown or non-Fickian prediction.';

/**
 * @affects nothing; read-only, data { model, faces, mode, tau, fraction?, moisturePercent?, timesToFraction[], curve[], inputs, defaults, items, assumption, unverified }
 * @invariant G(tau) = 1 - 8/pi^2 sum exp(-(2j+1)^2 pi^2 tau)/(2j+1)^2, tau = D t / h^2 (h doubled when one face is sealed); M = Mi + G (Mb - Mi); inverse by bisection (rel 1e-14 in tau)
 * @failure thickness / D <= 0, fraction outside (0, 1), wrong unit, no exposure and no targets -> ENV_PARAM_INVALID; no D or saturation (param or material) -> ENV_PROPERTY_MISSING; model out of range -> the PHY-01 code (PROP_OUT_OF_RANGE)
 */
export const moistureUptake = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true },
  description: DESCRIPTION,
  params: z.object({
    thickness: quantitySchema.describe('Plate thickness h, a length (e.g. {value: 2, unit: "mm"}); > 0.'),
    faces: z
      .enum(['both', 'one'])
      .optional()
      .describe('Exposed faces: both, or one with the other face sealed. Required unless useMissionExposure supplies it.'),
    mode: z.enum(['absorption', 'desorption']).optional().describe('absorption (default) or desorption.'),
    diffusivity: sourcedQuantity('Moisture diffusivity D through the thickness, length^2/time')
      .optional()
      .describe('D {value, unit (e.g. mm^2/s, in^2/h), source}; > 0. Omit to read it from `material`.'),
    saturation: sourcedQuantity('Equilibrium (boundary) moisture content')
      .optional()
      .describe('Equilibrium content M_inf, mass fraction {value, unit "%" or "1"}. Omit to use `saturationLaw` or the material.'),
    saturationLaw: z
      .object({
        a: z.number().describe('Coefficient a: M_inf[%] = a * RH[%]^b.'),
        b: z.number().describe('Exponent b.'),
        relativeHumidity: z
          .number()
          .optional()
          .describe('Relative humidity in % (0 to 100); default: the mission humidityExposure when useMissionExposure.'),
        source: z.string().optional().describe('Where a and b come from.'),
      })
      .optional()
      .describe('Equilibrium content from relative humidity: M_inf[%] = a * RH[%]^b.'),
    initial: sourcedQuantity('Initial moisture content')
      .optional()
      .describe('Initial content {value, unit "%" or "1"}; default 0 % for absorption; REQUIRED for desorption.'),
    exposure: quantitySchema.optional().describe('Exposure time {value, unit (s, h, d)}: the result carries the content at this time.'),
    targets: z
      .array(z.number())
      .max(50)
      .optional()
      .describe('Fractions of the way to the boundary content, each strictly between 0 and 1: the time to reach each is returned.'),
    material: z
      .string()
      .optional()
      .describe('Material id whose moistureDiffusivity / moistureSaturation properties fill what is not given.'),
    temperature: quantitySchema
      .optional()
      .describe('Operating temperature {value, unit K | degC | degF} for temperature-dependent material properties.'),
    timeUnit: z.string().optional().describe('Unit of the returned times (default: the exposure unit, else "d").'),
    useMissionExposure: z
      .boolean()
      .optional()
      .describe(
        'true: take exposure duration, faces, temperature and relative humidity from the mission humidityExposure (set_mission_environment) where not given.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, path: string, ids: readonly string[] = []): CommandResult =>
      refuseEnv(doc, COMMAND, code, message, ids, [path]);
    const failFor = (problem: UnitProblem | MaterialMissing, path: string): CommandResult =>
      'path' in problem
        ? fail('ENV_PARAM_INVALID', problem.message, problem.path)
        : fail(
            problem.code === 'PROP_NO_MODEL_FOR_PROPERTY' ? 'ENV_PROPERTY_MISSING' : problem.code,
            problem.reason,
            path,
            params.material === undefined ? [] : [params.material],
          );
    const mission = params.useMissionExposure === true ? spaceEnvironmentOf(doc).humidityExposure : undefined;
    if (params.useMissionExposure === true && mission === undefined)
      return fail(
        'ENV_PARAM_INVALID',
        'useMissionExposure is set but the mission has no humidityExposure (set_mission_environment)',
        'useMissionExposure',
      );
    const faces = params.faces ?? mission?.faces;
    if (faces === undefined) return fail('ENV_PARAM_INVALID', 'faces is required: both, or one (other face sealed)', 'faces');
    const mode = params.mode ?? 'absorption';
    const temperature = params.temperature ?? mission?.temperature;
    const exposure = params.exposure ?? mission?.duration;
    const material = params.material;

    const given = givenInput(params.thickness, 'm', 'thickness');
    if (isInputProblem(given)) return failFor(given, 'thickness');
    const thickness = { ...given, unverified: false };
    if (!(thickness.value > 0))
      return fail('ENV_PARAM_INVALID', `thickness must be > 0 (got ${params.thickness.value} ${params.thickness.unit})`, 'thickness');

    const request: UptakeInputs = {
      doc,
      ctx,
      material,
      at: temperature === undefined ? {} : { T: temperature },
      mode,
      relativeHumidity: mission?.relativeHumidity,
    };
    const diffusivity = diffusivityInput(request, params.diffusivity);
    if (isInputProblem(diffusivity))
      return failFor(diffusivity, params.diffusivity === undefined && material !== undefined ? 'material' : 'diffusivity');
    if (!(diffusivity.value > 0) || !Number.isFinite(diffusivity.value))
      return fail('ENV_PARAM_INVALID', `diffusivity must be > 0 (got ${diffusivity.value} m^2/s)`, 'diffusivity');
    const defaults: string[] = [];
    const boundary = boundaryInput(request, params.saturation, params.saturationLaw, defaults);
    if (isInputProblem(boundary))
      return failFor(boundary, params.saturation === undefined && material !== undefined ? 'material' : 'saturation');
    const initial = initialInput(request, params.initial, defaults);
    if (isInputProblem(initial)) return failFor(initial, 'initial');

    const targets = params.targets ?? [];
    if (exposure === undefined && targets.length === 0)
      return fail('ENV_PARAM_INVALID', 'give an `exposure` time and/or `targets` fractions: nothing to compute', 'exposure');
    const targetTaus: number[] = [];
    for (const [index, target] of targets.entries()) {
      const tau = timeToFraction(target);
      if (tau === null)
        return fail(
          'ENV_PARAM_INVALID',
          `target ${target} must be strictly between 0 and 1 (and not within rounding of 1)`,
          `targets.${index}`,
        );
      targetTaus.push(tau);
    }
    let exposureSeconds: number | undefined;
    if (exposure !== undefined) {
      const seconds = convertValue(exposure.value, exposure.unit, 's');
      if (isUnitFailure(seconds) || !(seconds.value >= 0) || !Number.isFinite(seconds.value))
        return fail('ENV_PARAM_INVALID', `exposure must be a finite time >= 0 (got ${exposure.value} ${exposure.unit})`, 'exposure');
      exposureSeconds = seconds.value;
    }
    const timeUnit = params.timeUnit ?? exposure?.unit ?? DEFAULT_TIME_UNIT;
    const unitScale = convertValue(1, 's', timeUnit);
    if (isUnitFailure(unitScale)) return fail('ENV_PARAM_INVALID', `timeUnit '${timeUnit}': ${unitScale.message}`, 'timeUnit');
    const fromSeconds = (seconds: number): number => seconds * unitScale.value;

    const hEff = effectiveThickness(thickness.value, faces);
    const secondsPerTau = (hEff * hEff) / diffusivity.value;
    const contentOf = (g: number): number => contentAt(initial.value, boundary.value, g);
    const tau = exposureSeconds === undefined ? undefined : exposureSeconds / secondsPerTau;
    const fraction = tau === undefined ? undefined : fractionalUptake(tau);
    const moisture = fraction === undefined ? undefined : contentOf(fraction);
    const tEnd = exposureSeconds !== undefined && exposureSeconds > 0 ? exposureSeconds : TAU_99 * secondsPerTau;
    const curve = logSpaced(tEnd * 1e-4, tEnd, CURVE_SAMPLES).map((seconds) => {
      const g = fractionalUptake(seconds / secondsPerTau);
      return { t: fromSeconds(seconds), fraction: g, moisturePercent: contentOf(g) };
    });
    const timesToFraction = targets.map((target, index) => {
      const targetTau = targetTaus[index] ?? 0;
      return {
        fraction: target,
        tau: targetTau,
        moisturePercent: contentOf(target),
        time: { value: fromSeconds(targetTau * secondsPerTau), unit: timeUnit },
      };
    });

    const inputs: Record<string, ReturnType<typeof describeInput>> = {
      thickness: describeInput(thickness),
      diffusivity: describeInput(diffusivity),
      [mode === 'desorption' ? 'boundary' : 'saturation']: describeInput(boundary),
      initial: describeInput(initial),
    };
    const unverifiedNames = Object.entries(inputs)
      .filter(([, input]) => input.unverified)
      .map(([name]) => name);
    const items: EnvItem[] = [
      {
        code: 'ENV_MODEL_ASSUMPTION',
        severity: 'info',
        message:
          '1D Fick plane sheet, constant D, edges sealed or thickness much smaller than width; no through-thickness gradient or non-Fickian behaviour',
      },
      ...(unverifiedNames.length > 0 ? [unverifiedItem(`input ${unverifiedNames.join(', ')}`)] : []),
    ];
    const data = {
      model: 'fick_plane_sheet',
      faces,
      mode,
      assumption: '1D, edges sealed or h << width',
      tau,
      fraction,
      moisturePercent: moisture,
      timesToFraction,
      curve,
      inputs,
      defaults,
      items,
      unverified: unverifiedNames.length > 0,
    };
    const times = timesToFraction.map(
      (entry) => `t${Math.round(entry.fraction * 100)} = ${entry.time.value.toPrecision(6)} ${timeUnit} (tau ${entry.tau.toPrecision(6)})`,
    );
    const state =
      tau === undefined || fraction === undefined || moisture === undefined
        ? ''
        : `tau ${tau.toPrecision(6)}, G ${fraction.toPrecision(6)}, M ${moisture.toPrecision(9)} % after ${exposure?.value} ${exposure?.unit}. `;
    return report(
      doc,
      `${COMMAND}: Fick plane sheet, ${faces} face(s), ${mode}: ${state}${times.length > 0 ? `${times.join('; ')}. ` : ''}${defaults.length > 0 ? `Defaults: ${defaults.join('; ')}. ` : ''}${data.unverified ? `Unverified inputs: ${unverifiedNames.join(', ')}.` : 'All inputs sourced.'}`,
      data,
    );
  },
});
