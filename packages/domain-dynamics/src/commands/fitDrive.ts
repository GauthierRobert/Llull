/** fit_drive_parameters: identify drive parameters (inertia, friction, resistance, torque constant) from a measured series. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { codedRejection, failer, report } from '@core/commands/noop';
import type { ReferenceSeries, SeriesQuantity } from '@core/model/drives';
import {
  ELECTRICAL,
  fitElectrical,
  fitMechanical,
  MAX_CONDITION,
  MECHANICAL,
  type Channels,
  type FitResult,
  type Unknown,
} from '../sim/driveFit';
import { dynamicsOf } from './bodies';

const NAME = 'fit_drive_parameters';
const UNKNOWNS = [...MECHANICAL, ...ELECTRICAL] as const satisfies readonly Unknown[];

const UNIT: Readonly<Record<Unknown, string>> = {
  inertia: 'kg*m^2',
  coulombNm: 'N*m',
  viscousNmsPerRad: 'N*m*s/rad',
  resistance: 'ohm',
  torqueConstant: 'N*m/A',
};

const inline = z.object({
  t: z.array(z.number()).min(3).max(100_000).describe('Sample times, s, strictly increasing.'),
  omega: z.array(z.number()).describe('Shaft speed, rad/s, one per time.'),
  current: z.array(z.number()).optional().describe('Motor current, A, one per time (electrical fit).'),
  voltage: z.array(z.number()).optional().describe('Terminal voltage, V, one per time (electrical fit).'),
  torque: z.array(z.number()).optional().describe('Measured torque on the shaft, N*m, one per time (mechanical fit with a known input).'),
});
const byId = z.object({
  omega: z.string().describe('Id of a joint_velocity or motor_speed reference series (add_reference_data).'),
  current: z.string().optional().describe('Id of a motor_current reference series on the same times.'),
  voltage: z.string().optional().describe('Id of a motor_voltage reference series on the same times.'),
  torque: z.string().optional().describe('Id of a motor_torque reference series on the same times.'),
});

const CHANNEL_QUANTITY: Readonly<Record<keyof z.infer<typeof byId>, readonly SeriesQuantity[]>> = {
  omega: ['joint_velocity', 'motor_speed'],
  current: ['motor_current'],
  voltage: ['motor_voltage'],
  torque: ['motor_torque'],
};

/** Channels of stored reference series, or why they cannot be used. */
function channelsOf(doc: CadDocument, ids: z.infer<typeof byId>): Channels | string {
  const stored = dynamicsOf(doc).referenceSeries ?? {};
  const pick = (channel: keyof typeof CHANNEL_QUANTITY, id: string | undefined): ReferenceSeries | string | undefined => {
    if (id === undefined) return undefined;
    const series = stored[id];
    if (series === undefined) return `no reference series '${id}'`;
    return CHANNEL_QUANTITY[channel].includes(series.quantity)
      ? series
      : `reference series '${id}' is ${series.quantity}, the ${channel} channel needs ${CHANNEL_QUANTITY[channel].join(' or ')}`;
  };
  const picked = [pick('omega', ids.omega), pick('current', ids.current), pick('voltage', ids.voltage), pick('torque', ids.torque)];
  const problem = picked.find((entry): entry is string => typeof entry === 'string');
  if (problem !== undefined) return problem;
  const [omega, current, voltage, torque] = picked as (ReferenceSeries | undefined)[];
  if (omega === undefined) return 'the omega channel is missing';
  const sameTimes = [current, voltage, torque].every(
    (series) =>
      series === undefined || (series.times.length === omega.times.length && series.times.every((time, k) => time === omega.times[k])),
  );
  if (!sameTimes) return 'the channels must share the same sample times';
  return {
    t: omega.times,
    omega: omega.values,
    ...(current === undefined ? {} : { current: current.values }),
    ...(voltage === undefined ? {} : { voltage: voltage.values }),
    ...(torque === undefined ? {} : { torque: torque.values }),
  };
}

const REMEDIATION =
  'Add the missing experiment: a spin-down plus a spin-up with a measured torque (separates J from the friction), a bench-measured J or `known.inertia`, or a step response with varied speed (separates R from kt).';

/**
 * @affects nothing — read-only; returns { model, values { name: { value, sigma, unit } }, residualRms, samplesUsed, condition, neglected } in data
 * @invariant input deep-equal, no FeatureStep; every model is linear in its unknowns (one least squares), sigma is the 1-sigma of the residual covariance (null with no
 *            spare equation); a regressor above condition 1e8 is refused, never fitted; a spin-down with the inertia unknown and no torque is refused (homogeneous)
 * @failure unknown series / mixed unknowns / a name in both `unknowns` and `known` -> no-op; the data cannot separate the unknowns -> DRV_FIT_UNIDENTIFIABLE
 *          (the confounded pair named); too few or malformed samples -> DRV_FIT_DATA
 */
export const fitDriveParameters = defineCommand({
  name: NAME,
  annotations: { readOnly: true },
  description:
    'Identify drive parameters from a measured series by linear least squares, with the 1-sigma of each value and the residual RMS. MECHANICAL unknowns ' +
    "(inertia kg*m^2, coulombNm N*m, viscousNmsPerRad N*m*s/rad) fit J*w' = torque - Tf*sign(w) - b*w to a speed series (rad/s) with w' by a centred difference " +
    '(samples next to a stop are skipped); `torque` is the measured input (omit for a pure spin-down). ELECTRICAL unknowns (resistance ohm, torqueConstant N*m/A) fit ' +
    'u = R*i + L*di/dt + kt*w to a step response (voltage, current, omega); `known.inductance` adds the L*di/dt term, without it the term is neglected and listed. ' +
    'Name every other parameter in `known` (e.g. inertia 1.37e-5 for a spin-down) or in `unknowns`; fit mechanical and electrical unknowns separately. ' +
    '`series` is inline arrays { t, omega, current?, voltage?, torque? } or the ids of stored reference series { omega, current?, voltage?, torque? } ' +
    '(add_reference_data with `series`, same sample times). A regressor with condition number above 1e8 is refused with DRV_FIT_UNIDENTIFIABLE naming the ' +
    'confounded pair (e.g. inertia and Coulomb friction from a spin-down alone: add a run with a known torque or a measured J). The sigma is the ordinary ' +
    'least-squares one: it assumes the noise is in the equation (voltage, torque), not in the regressors, so with the inertia unknown a noisy speed biases the value beyond its sigma. Read-only. ' +
    'Next: compare with the datasheet value (check_motor_data), put the fitted value into set_joint_physics / add_motor with a source of grade A.',
  params: z.object({
    series: z.union([inline, byId]).describe('The measured data: inline arrays, or reference series ids.'),
    unknowns: z.array(z.enum(UNKNOWNS)).min(1).max(3).describe('Parameters to identify (all mechanical or all electrical).'),
    known: z
      .object({
        inertia: z.number().positive().optional().describe('Moment of inertia, kg*m^2.'),
        coulombNm: z.number().min(0).optional().describe('Coulomb friction torque, N*m.'),
        viscousNmsPerRad: z.number().min(0).optional().describe('Viscous friction, N*m*s/rad.'),
        resistance: z.number().positive().optional().describe('Terminal resistance, ohm.'),
        torqueConstant: z.number().positive().optional().describe('Torque constant (= back-EMF constant), N*m/A.'),
        inductance: z.number().min(0).optional().describe('Terminal inductance, H (adds the L di/dt term of the electrical fit).'),
      })
      .optional()
      .describe('Fixed values of the parameters that are not unknowns (same units as the output).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, NAME);
    const unknowns = [...new Set(params.unknowns)];
    const known: Record<string, number> = Object.fromEntries(
      Object.entries(params.known ?? {}).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
    );
    const overlap = unknowns.filter((name) => name in known);
    if (overlap.length > 0) return fail(`${overlap.join(', ')} cannot be both unknown and known`);
    const mechanical = unknowns.every((name) => (MECHANICAL as readonly string[]).includes(name));
    const electrical = unknowns.every((name) => (ELECTRICAL as readonly string[]).includes(name));
    if (!mechanical && !electrical)
      return fail('fit mechanical (inertia, friction) and electrical (resistance, torqueConstant) unknowns in separate calls');
    const foreign = Object.keys(known).filter((name) =>
      mechanical ? !(MECHANICAL as readonly string[]).includes(name) : ![...ELECTRICAL, 'inductance'].includes(name),
    );
    if (foreign.length > 0) return fail(`known ${foreign.join(', ')} does not belong to a ${mechanical ? 'mechanical' : 'electrical'} fit`);
    const series = params.series;
    const channels =
      'omega' in series && typeof series.omega === 'string' ? channelsOf(doc, series as z.infer<typeof byId>) : (series as Channels);
    if (typeof channels === 'string') return fail(channels);
    const result: FitResult = mechanical ? fitMechanical(channels, unknowns, known) : fitElectrical(channels, unknowns, known);
    if (!result.ok)
      return result.code === 'DRV_FIT_UNIDENTIFIABLE'
        ? codedRejection(doc, NAME, result.code, result.why, REMEDIATION, result.confounded)
        : codedRejection(
            doc,
            NAME,
            result.code,
            result.why,
            'Give at least as many usable samples as unknowns, one time per sample, finite numbers.',
          );
    const neglected = electrical && known['inductance'] === undefined ? ['inductance (L di/dt term dropped: give known.inductance)'] : [];
    const values = Object.fromEntries(
      Object.entries(result.values).map(([name, fit]) => [name, { value: fit.value, sigma: fit.sigma, unit: UNIT[name as Unknown] }]),
    );
    const text = Object.entries(result.values)
      .map(
        ([name, fit]) =>
          `${name} ${fit.value.toPrecision(6)} ${UNIT[name as Unknown]}${fit.sigma === null ? '' : ` ± ${fit.sigma.toPrecision(2)}`}`,
      )
      .join(', ');
    return report(
      doc,
      `${NAME}: ${result.model} fit of ${result.samplesUsed} sample(s): ${text}; residual RMS ${result.residualRms.toPrecision(3)}, condition ${result.condition.toPrecision(3)} (limit ${MAX_CONDITION.toExponential(0)}).` +
        `${neglected.length > 0 ? ' Neglected: inductance.' : ''} Next: check_motor_data, then store the value with a source.`,
      {
        model: result.model,
        values,
        residualRms: result.residualRms,
        samplesUsed: result.samplesUsed,
        condition: result.condition,
        neglected,
      },
    );
  },
});
