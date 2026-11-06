/** Time profiles of the dynamics model (PHY-23): stored by `add_motion_profile`, inspected by `evaluate_motion_profile`. */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { codedRejection, changed, failer, report } from '../noop';
import { idOrNext } from '../../lib/explicitId';
import { createDynamicsModel, dynamicsIdTaken } from '../../model/dynamics';
import type { MotionProfile, ProfileLaw, ProfileSegment } from '../../model/drives';
import { compileProfile, isProfileRefusal, profilePeaks, profileUnitScale } from '../../geometry/motionProfile';

const LAWS = ['linear', 'trapezoid', 's_curve', 'cycloidal', 'poly345', 'modified_sine', 'modified_trapezoid', 'harmonic'] as const;

const segmentSchema = z.object({
  kind: z
    .enum(['dwell', 'move', 'sine', 'table'])
    .describe('"dwell" holds the value; "move" goes to `to` by a law; "sine" adds an oscillation; "table" interpolates points.'),
  duration: z
    .number()
    .positive()
    .optional()
    .describe(
      'dwell: seconds held. move: seconds the move takes (cam laws and linear need it; trapezoid / s_curve compute it from their limits when omitted).',
    ),
  law: z
    .enum(LAWS)
    .optional()
    .describe(
      'move: "cycloidal" (smooth, C_v 2, C_a 6.283), "poly345" (3-4-5 polynomial, C_v 1.875, C_a 5.774), "harmonic" (C_v 1.571, C_a 4.935, jerk spikes at the ends), ' +
        '"modified_trapezoid" (C_v 2, C_a 4.888), "modified_sine" (C_v 1.760, C_a 5.528), "linear" (constant speed), "trapezoid" (constant acceleration ramps), ' +
        '"s_curve" (7-segment jerk-limited). C_v and C_a are the peak velocity and acceleration of a unit rise over a unit duration.',
    ),
  to: z
    .number()
    .optional()
    .describe('move: value (in the profile unit) at the end of the move; it starts at the value the previous segment ended on.'),
  vmax: z.number().positive().optional().describe('trapezoid / s_curve / linear: speed limit in profile unit per second.'),
  amax: z.number().positive().optional().describe('trapezoid / s_curve: acceleration limit in profile unit per second squared.'),
  jerk: z
    .number()
    .positive()
    .optional()
    .describe('s_curve: jerk limit in profile unit per second cubed. With vmax and amax gives T = D/vmax + vmax/amax + amax/jerk.'),
  accelFraction: z
    .number()
    .positive()
    .max(0.5)
    .optional()
    .describe(
      'trapezoid / s_curve given only `duration`: fraction of the duration spent accelerating (and again decelerating). Default 1/3; 0.5 = triangle.',
    ),
  amplitude: z.number().optional().describe('sine: amplitude in the profile unit.'),
  frequencyHz: z.number().positive().optional().describe('sine: frequency in Hz.'),
  cycles: z.number().positive().optional().describe('sine: number of cycles (the segment lasts cycles / frequencyHz).'),
  phaseDeg: z
    .number()
    .optional()
    .describe('sine: phase in degrees (default 0). The sine is added to the value at the segment start, so the value is continuous.'),
  points: z
    .array(z.tuple([z.number(), z.number()]))
    .max(100000)
    .optional()
    .describe(
      'table: [[seconds from the segment start, value], ...] with the first time 0 and strictly increasing times. The first value must equal the current value.',
    ),
  interpolation: z
    .enum(['linear', 'monotone_cubic'])
    .optional()
    .describe('table: "linear" (default) or "monotone_cubic" (Fritsch-Carlson, no overshoot).'),
});

type FlatSegment = z.infer<typeof segmentSchema>;

function toSegment(flat: FlatSegment): ProfileSegment | string {
  const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
    value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
  switch (flat.kind) {
    case 'dwell':
      return flat.duration === undefined ? 'dwell needs duration' : { kind: 'dwell', duration: flat.duration };
    case 'move':
      if (flat.law === undefined || flat.to === undefined) return 'move needs law and to';
      return {
        kind: 'move',
        law: flat.law satisfies ProfileLaw,
        to: flat.to,
        ...optional('duration', flat.duration),
        ...optional('vmax', flat.vmax),
        ...optional('amax', flat.amax),
        ...optional('jerk', flat.jerk),
        ...optional('accelFraction', flat.accelFraction),
      };
    case 'sine':
      if (flat.amplitude === undefined || flat.frequencyHz === undefined || flat.cycles === undefined)
        return 'sine needs amplitude, frequencyHz and cycles';
      return {
        kind: 'sine',
        amplitude: flat.amplitude,
        frequencyHz: flat.frequencyHz,
        cycles: flat.cycles,
        ...optional('phaseDeg', flat.phaseDeg),
      };
    case 'table':
      return flat.points === undefined
        ? 'table needs points'
        : { kind: 'table', points: flat.points, interpolation: flat.interpolation ?? 'linear' };
  }
}

const profileFields = {
  quantity: z
    .enum(['position', 'velocity', 'torque', 'force', 'voltage', 'frequency'])
    .describe(
      'What the values are: position (rad, deg, rev, m, mm), velocity (rad/s, rpm, deg/s, m/s, mm/s), torque (N*m), force (N), voltage (V), frequency (Hz).',
    ),
  unit: z.string().describe('Unit of every value of the profile, one of those listed for `quantity` (e.g. "deg", "rpm", "N*m", "V").'),
  start: z.number().optional().describe('Value at t = 0. Default 0 (the first value of a leading table).'),
  segments: z.array(segmentSchema).min(1).max(10000).describe('Segments played one after the other (at most 10000).'),
  repeat: z
    .number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .describe('Whole repeats of the segment list. Default 1. The profile must end where it starts.'),
  allowStep: z
    .boolean()
    .optional()
    .describe(
      'Accept a jump of the value (or of the velocity of a position profile) between segments. Default false: a jump is refused with DRV_PROFILE_DISCONTINUOUS.',
    ),
};

function buildProfile(id: string, params: z.infer<z.ZodObject<typeof profileFields>>): MotionProfile | { error: string; code?: string } {
  const segments: ProfileSegment[] = [];
  for (const [index, flat] of params.segments.entries()) {
    const segment = toSegment(flat);
    if (typeof segment === 'string') return { error: `segment ${index}: ${segment}`, code: 'DRV_PROFILE_INVALID' };
    segments.push(segment);
  }
  if (profileUnitScale(params.quantity, params.unit) === null)
    return { error: `unit '${params.unit}' is not a ${params.quantity} unit`, code: 'DRV_PROFILE_INVALID' };
  return {
    id,
    quantity: params.quantity,
    unit: params.unit,
    ...(params.start === undefined ? {} : { start: params.start }),
    segments,
    ...(params.repeat === undefined ? {} : { repeat: params.repeat }),
    ...(params.allowStep === undefined ? {} : { allowStep: params.allowStep }),
  };
}

const REMEDIATION: Readonly<Record<string, string>> = {
  DRV_PROFILE_INVALID: 'Fix the named segment or unit; see the add_motion_profile description for the fields of each kind.',
  DRV_PROFILE_DISCONTINUOUS: 'Make each segment start where the previous one ended (cam laws end at rest), or pass allowStep.',
  DRV_PROFILE_INFEASIBLE: 'Lengthen the duration to the shortest feasible one named in the message, or raise vmax / amax / jerk.',
};

/**
 * @affects adds 1 profile to doc.dynamics.profiles (affected: [profileId])
 * @invariant a stored profile compiles (continuous value, C1 position, feasible limits); the id is unique among dynamics records
 * @failure bad shape or unit -> DRV_PROFILE_INVALID; jump between segments -> DRV_PROFILE_DISCONTINUOUS; limits that cannot reach the move in `duration` -> DRV_PROFILE_INFEASIBLE (shortest named); taken id -> no-op
 */
export const addMotionProfile = defineCommand({
  name: 'add_motion_profile',
  description:
    'Store a time profile for the drives of the physics model (set_motor_drive): a sequence of segments played one after the other, each starting where the ' +
    'previous one ended. Segment kinds: "dwell" (hold), "move" (go to `to` by a law: cycloidal / poly345 / harmonic / modified_trapezoid / modified_sine need `duration`; ' +
    'trapezoid and s_curve take (vmax, amax[, jerk]) and compute the duration T = D/v + v/a (+ a/j), or take a `duration`; linear takes duration or vmax), ' +
    '"sine" (oscillation) and "table" (points, linear or monotone cubic). Cam laws and trapezoid / s_curve moves start and end at rest, so a position profile of ' +
    'moves and dwells is smooth by construction; a jump in value, or in velocity for a position profile, is refused with DRV_PROFILE_DISCONTINUOUS unless allowStep. ' +
    'quantity + unit say what the values mean (position deg, velocity rpm, torque N*m, voltage V...). `repeat` plays the segment list several times (it must end where it ' +
    'starts). Check the result with evaluate_motion_profile. Returns the profile id in affected[0].',
  params: z.object({ ...profileFields, id: z.string().optional().describe('Optional explicit profile id.') }),
  run: (doc, params): CommandResult => {
    const dynamics = doc.dynamics ?? createDynamicsModel();
    const profileId = idOrNext(params.id, 'profile');
    if (dynamicsIdTaken(dynamics, profileId)) return failer(doc, 'add_motion_profile')(`id '${profileId}' is already used`);
    const profile = buildProfile(profileId, params);
    if ('error' in profile)
      return codedRejection(
        doc,
        'add_motion_profile',
        profile.code ?? 'DRV_PROFILE_INVALID',
        profile.error,
        REMEDIATION['DRV_PROFILE_INVALID'] ?? '',
      );
    const compiled = compileProfile(profile);
    if (isProfileRefusal(compiled))
      return codedRejection(
        doc,
        'add_motion_profile',
        compiled.code,
        compiled.error,
        REMEDIATION[compiled.code] ?? '',
        [],
        [],
        compiled.shortestDuration === undefined ? undefined : { shortestDurationS: compiled.shortestDuration },
      );
    const peaks = profilePeaks(compiled);
    return changed(
      { ...doc, dynamics: { ...dynamics, profiles: { ...dynamics.profiles, [profileId]: profile } } },
      `add_motion_profile: '${profileId}' ${profile.quantity} [${profile.unit}], ${profile.segments.length} segment(s)${(profile.repeat ?? 1) > 1 ? ` x${profile.repeat}` : ''}, ` +
        `duration ${compiled.duration.toPrecision(6)} s, peak |value| ${peaks.value.toPrecision(5)}, |velocity| ${peaks.velocity.toPrecision(5)}, |acceleration| ${peaks.acceleration.toPrecision(5)} (profile units).`,
      [profileId],
    );
  },
});

const MAX_SAMPLES = 10001;

/**
 * @affects nothing — read-only; returns { profileId, quantity, unit, durationS, peaks, samples } in data
 * @invariant input document deep-equal before and after; no FeatureStep; deterministic
 * @failure unknown profile id, neither or both of `profile` / `definition`, bad definition -> no-op with the DRV_PROFILE_* reason
 */
export const evaluateMotionProfile = defineCommand({
  name: 'evaluate_motion_profile',
  annotations: { readOnly: true },
  description:
    'Evaluate a motion profile (add_motion_profile) at uniform samples or at given times: value, velocity (first derivative) and acceleration (second ' +
    'derivative) in the profile unit, plus the duration and the peak magnitudes (found by a fine scan, not only at the samples). Use it to read the peak ' +
    'velocity and acceleration of a move before driving a motor with it: a unit rise over a unit duration returns the cam coefficients C_v and C_a. ' +
    'Give `profile` (a stored id) or `definition` (the same fields as add_motion_profile, to preview without storing). `samples` 2..10001 uniform points ' +
    'over the whole duration (default 101), or `times` (seconds; values past the end hold the final value). Read-only.',
  params: z.object({
    profile: z.string().optional().describe('Id of a stored profile.'),
    definition: z.object(profileFields).optional().describe('An unstored profile, same fields as add_motion_profile.'),
    samples: z
      .number()
      .int()
      .min(2)
      .max(MAX_SAMPLES)
      .optional()
      .describe('Uniform sample count over [0, duration], 2..10001. Default 101.'),
    times: z.array(z.number().min(0)).max(MAX_SAMPLES).optional().describe('Explicit times in seconds (instead of `samples`).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'evaluate_motion_profile');
    if ((params.profile === undefined) === (params.definition === undefined)) return fail('give exactly one of `profile` and `definition`');
    const stored = params.profile === undefined ? undefined : doc.dynamics?.profiles?.[params.profile];
    if (params.profile !== undefined && stored === undefined)
      return fail(`profile '${params.profile}' not found (add_motion_profile first)`);
    const profile = stored ?? (params.definition === undefined ? undefined : buildProfile('definition', params.definition));
    if (profile === undefined) return fail('no profile');
    if ('error' in profile)
      return codedRejection(
        doc,
        'evaluate_motion_profile',
        profile.code ?? 'DRV_PROFILE_INVALID',
        profile.error,
        REMEDIATION['DRV_PROFILE_INVALID'] ?? '',
      );
    const compiled = compileProfile(profile);
    if (isProfileRefusal(compiled))
      return codedRejection(doc, 'evaluate_motion_profile', compiled.code, compiled.error, REMEDIATION[compiled.code] ?? '');
    const count = params.samples ?? 101;
    const times = params.times ?? Array.from({ length: count }, (_, i) => (compiled.duration * i) / (count - 1));
    const samples = times.map((t) => ({ t, ...compiled.evaluate(t) }));
    const peaks = profilePeaks(compiled);
    return report(
      doc,
      `evaluate_motion_profile: '${profile.id}' ${profile.quantity} [${profile.unit}], duration ${compiled.duration.toPrecision(6)} s; peak |value| ${peaks.value.toPrecision(6)}, ` +
        `|velocity| ${peaks.velocity.toPrecision(6)}, |acceleration| ${peaks.acceleration.toPrecision(6)}; ${samples.length} sample(s).`,
      {
        profileId: profile.id,
        quantity: profile.quantity,
        unit: profile.unit,
        durationS: compiled.duration,
        cycleS: compiled.cycle,
        peaks,
        samples,
      },
    );
  },
});
