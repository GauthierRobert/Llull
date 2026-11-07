/** set_joint_physics: friction model, end stops and armature of a physics joint. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, codedRejection, failer } from '@core/commands/noop';
import type { DynamicJoint } from '@core/model/dynamics';
import type { JointFriction, JointLimits, JointPhysics } from '@core/model/transmissions';
import { dampingRatioForRestitution } from '../sim/endStop';
import { dynamicsOf, withDynamics } from './bodies';
import { sourceSchema, toSource } from './motorSchemas';

const REMEDIATION: Readonly<Record<string, string>> = {
  DRV_FRICTION_INVALID:
    'Give static >= kinetic >= 0 (stiction), static >= coulomb with stribeckVelocity > 0 (stribeck), mu >= 0 with pinRadiusMm > 0 (load_dependent), using the Nm / Nms suffixes on a revolute joint and N / Ns/m on a prismatic one.',
  DRV_LIMITS_INVALID:
    'Give min < max in rad (revolute) or m (prismatic), stiffness > 0, and dampingRatio > 0 or restitution in (0.0002, 1].',
};

const number = (text: string): z.ZodOptional<z.ZodNumber> => z.number().optional().describe(text);

const frictionSchema = z.object({
  model: z
    .enum(['coulomb', 'stiction', 'stribeck', 'load_dependent'])
    .describe(
      '"coulomb": constant kinetic friction. "stiction": static level while the joint is at rest, kinetic once it slips (stick-slip, breakaway). "stribeck": ' +
        'F_c + (F_s - F_c)·exp(-(v/v_s)²). "load_dependent": base + μ·r·(radial load + preload + moment/arm) read from the joint reaction (a bearing).',
    ),
  staticNm: number('stiction / stribeck on a REVOLUTE joint: static (breakaway) friction torque F_s, N·m (>= kinetic / coulomb).'),
  staticN: number('stiction / stribeck on a PRISMATIC joint: static friction force F_s, N (>= kinetic / coulomb).'),
  kineticNm: number('coulomb / stiction, revolute: kinetic friction torque, N·m.'),
  kineticN: number('coulomb / stiction, prismatic: kinetic friction force, N.'),
  coulombNm: number('stribeck, revolute: Coulomb level F_c far above the Stribeck speed, N·m.'),
  coulombN: number('stribeck, prismatic: Coulomb level F_c, N.'),
  stribeckVelocity: number('stribeck: Stribeck speed v_s, rad/s (revolute) or m/s (prismatic), > 0.'),
  viscousNmsPerRad: number('Viscous damping coefficient, N·m·s/rad (revolute); replaces the joint damping of add_body_joint.'),
  viscousNsPerM: number('Viscous damping coefficient, N·s/m (prismatic); replaces the joint damping of add_body_joint.'),
  mu: number('load_dependent: coefficient of friction of the bearing (>= 0).'),
  pinRadiusMm: number(
    'load_dependent: radius at which the friction force acts (pin / bearing radius), mm (> 0). Ignored on a prismatic joint.',
  ),
  preloadN: number('load_dependent: preload added to the measured radial load, N (>= 0).'),
  frictionArmMm: number('load_dependent: bending-moment arm, mm: adds |M_bending| / arm to the normal load.'),
  baseNm: number('load_dependent, revolute: load-independent friction torque, N·m.'),
  baseN: number('load_dependent, prismatic: load-independent friction force, N.'),
  source: sourceSchema.describe('Where the friction numbers come from (required): grades the result (C = assumed).'),
});

const limitsSchema = z.object({
  min: z.number().describe('Lower travel limit, rad (revolute) or m (prismatic), measured from the pose the joint is modelled in.'),
  max: z.number().describe('Upper travel limit, same unit (> min).'),
  stiffness: z.number().describe('Stop stiffness, N·m/rad or N/m (> 0): one-sided linear spring-damper at each limit.'),
  dampingRatio: number('Damping ratio ζ of the stop on the inertia the joint pushes (> 0). Default from `restitution`.'),
  restitution: number('Coefficient of restitution of an impact (one-sided stop: ζ 0.2 gives 0.5717, ζ 0.5 gives 0.2). Default 0.5.'),
});

type FrictionParams = z.infer<typeof frictionSchema>;

/** The stored friction model of `params` on `joint`, or why not (unit suffixes must match the joint kind). */
function friction(params: FrictionParams, joint: DynamicJoint): JointFriction | { error: string } {
  const revolute = joint.kind === 'revolute';
  const [unitKind, wrong] = revolute ? ['Nm', 'N'] : ['N', 'Nm'];
  const pick = (angular: number | undefined, linear: number | undefined, name: string): number | undefined | { error: string } => {
    const [mine, other] = revolute ? [angular, linear] : [linear, angular];
    return other !== undefined
      ? { error: `${name}${wrong} does not fit ${joint.kind} joint '${joint.id}' (use ${name}${unitKind})` }
      : mine;
  };
  const [fixed, kinetic, coulomb, base, viscous] = [
    pick(params.staticNm, params.staticN, 'static'),
    pick(params.kineticNm, params.kineticN, 'kinetic'),
    pick(params.coulombNm, params.coulombN, 'coulomb'),
    pick(params.baseNm, params.baseN, 'base'),
    revolute
      ? params.viscousNsPerM === undefined
        ? params.viscousNmsPerRad
        : { error: `viscousNsPerM does not fit revolute joint '${joint.id}' (use viscousNmsPerRad)` }
      : params.viscousNmsPerRad === undefined
        ? params.viscousNsPerM
        : { error: `viscousNmsPerRad does not fit prismatic joint '${joint.id}' (use viscousNsPerM)` },
  ];
  for (const value of [fixed, kinetic, coulomb, base, viscous]) if (typeof value === 'object') return value;
  const numbers = (list: (number | undefined | { error: string })[]): (number | undefined)[] =>
    list.map((v) => (typeof v === 'object' ? undefined : v));
  const [s, k, c, b, v] = numbers([fixed, kinetic, coulomb, base, viscous]);
  const common = { ...(v === undefined ? {} : { viscous: v }), source: toSource(params.source) };
  const ok = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
  if (v !== undefined && !ok(v)) return { error: 'viscous must be >= 0' };
  switch (params.model) {
    case 'coulomb':
      return ok(k) ? { model: 'coulomb', kinetic: k, ...common } : { error: `coulomb needs kinetic${unitKind} >= 0` };
    case 'stiction':
      return ok(s) && ok(k) && s >= k
        ? { model: 'stiction', static: s, kinetic: k, ...common }
        : { error: `stiction needs static${unitKind} >= kinetic${unitKind} >= 0` };
    case 'stribeck':
      return ok(s) && ok(c) && s >= c && (params.stribeckVelocity ?? 0) > 0
        ? { model: 'stribeck', static: s, coulomb: c, stribeckVelocity: params.stribeckVelocity ?? 0, ...common }
        : { error: `stribeck needs static${unitKind} >= coulomb${unitKind} >= 0 and stribeckVelocity > 0` };
    case 'load_dependent': {
      const { mu, pinRadiusMm, preloadN, frictionArmMm } = params;
      const valid =
        ok(mu) &&
        (pinRadiusMm ?? 0) > 0 &&
        (preloadN === undefined || ok(preloadN)) &&
        (frictionArmMm === undefined || frictionArmMm > 0) &&
        (b === undefined || ok(b));
      return valid
        ? {
            model: 'load_dependent',
            mu,
            pinRadiusMm: pinRadiusMm ?? 0,
            ...(preloadN === undefined ? {} : { preloadN }),
            ...(frictionArmMm === undefined ? {} : { frictionArmMm }),
            ...(b === undefined ? {} : { base: b }),
            ...common,
          }
        : { error: 'load_dependent needs mu >= 0, pinRadiusMm > 0, preloadN / base >= 0 and frictionArmMm > 0' };
    }
  }
}

/** The stored limits of `params`, or why not. */
function limits(params: z.infer<typeof limitsSchema>): JointLimits | { error: string } {
  const { min, max, stiffness, dampingRatio, restitution } = params;
  if (!(Number.isFinite(min) && Number.isFinite(max) && min < max)) return { error: `limits need finite min < max (got ${min}, ${max})` };
  if (!(Number.isFinite(stiffness) && stiffness > 0)) return { error: 'limits.stiffness must be > 0' };
  if (dampingRatio !== undefined && !(Number.isFinite(dampingRatio) && dampingRatio > 0))
    return { error: 'limits.dampingRatio must be > 0' };
  if (restitution !== undefined && (!(restitution > 0) || dampingRatioForRestitution(restitution) === null))
    return { error: `restitution ${restitution} is not reachable by a stop (0.0002 < e <= 1)` };
  return {
    min,
    max,
    stiffness,
    ...(dampingRatio === undefined ? {} : { dampingRatio }),
    ...(restitution === undefined ? {} : { restitution }),
  };
}

/**
 * @affects sets / clears doc.dynamics.jointPhysics[joint] (affected: [jointId]); record removed when it ends up empty
 * @invariant the joint is revolute or prismatic; given fields replace the stored ones, null clears one, omitted fields stay; static >= kinetic >= 0; min < max;
 *   a friction model replaces the `friction` / `damping` numbers of add_body_joint for the simulation
 * @failure unknown / spherical joint, nothing to set -> no-op; bad friction numbers or unit suffix -> DRV_FRICTION_INVALID; bad limits -> DRV_LIMITS_INVALID
 */
export const setJointPhysics = defineCommand({
  name: 'set_joint_physics',
  description:
    'Give a physics joint (add_body_joint) a friction model, end stops and an armature for simulate_motion; given parts REPLACE the stored ones, null clears a part, omitted parts stay. ' +
    '`friction`: model "coulomb" (constant), "stiction" (static level while at rest, kinetic once slipping: breakaway and stick-slip, the joint holds up to the static level exactly), ' +
    '"stribeck" (F_c + (F_s - F_c)·exp(-(v/v_s)²)) or "load_dependent" (base + μ·r·(radial load + preload + bending moment/arm), the load read from the joint reaction of the same step); ' +
    "use the Nm / Nms/rad names on a revolute joint and the N / Ns/m names on a prismatic one; the model REPLACES the joint's `friction` / `damping` numbers and its `source` " +
    "(grade C = assumed) is carried to the results; a datasheet motor's no-load friction still adds on top. `limits`: end stops min..max (rad or m from the modelled pose) as a " +
    'one-sided spring-damper of `stiffness` with damping from `dampingRatio` or `restitution` on the inertia the joint pushes (reported peak penetration and force in simulate_motion data.stops; ' +
    'the timestep must satisfy ω_n·Δt <= 0.1 with ω_n = sqrt(stiffness / inertia) or simulate_motion refuses with DRV_STEP_TOO_COARSE). `armatureKgM2`: inertia on the joint ' +
    'coordinate that belongs to no body (a rotor, a flywheel). Returns the joint id in affected[0].',
  params: z.object({
    joint: z.string().describe('Revolute or prismatic joint id.'),
    friction: frictionSchema
      .nullable()
      .optional()
      .describe('Friction model; null removes it (the joint keeps its add_body_joint friction / damping).'),
    limits: limitsSchema.nullable().optional().describe('End stops; null removes them.'),
    armatureKgM2: z
      .number()
      .min(0)
      .nullable()
      .optional()
      .describe('Extra inertia on the joint coordinate, kg·m² (revolute) or kg (prismatic); null or 0 removes it.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'set_joint_physics');
    const dynamics = dynamicsOf(doc);
    const joint = dynamics.joints[params.joint];
    if (joint === undefined) return fail(`joint '${params.joint}' not found (add_body_joint first)`);
    if (joint.kind === 'spherical') return fail(`joint '${params.joint}' is spherical: it has no coordinate to give physics to`);
    if (params.friction === undefined && params.limits === undefined && params.armatureKgM2 === undefined)
      return fail('nothing to set (give friction, limits or armatureKgM2)');
    const refuse = (code: string, message: string): CommandResult =>
      codedRejection(doc, 'set_joint_physics', code, message, REMEDIATION[code] ?? 'see the command description', [params.joint]);
    const stored = dynamics.jointPhysics?.[params.joint];
    let model = stored?.friction;
    if (params.friction === null) model = undefined;
    else if (params.friction !== undefined) {
      const made = friction(params.friction, joint);
      if ('error' in made) return refuse('DRV_FRICTION_INVALID', made.error);
      model = made;
    }
    let stops = stored?.limits;
    if (params.limits === null) stops = undefined;
    else if (params.limits !== undefined) {
      const made = limits(params.limits);
      if ('error' in made) return refuse('DRV_LIMITS_INVALID', made.error);
      stops = made;
    }
    const armature =
      params.armatureKgM2 === undefined
        ? stored?.armatureKgM2
        : params.armatureKgM2 === null || params.armatureKgM2 === 0
          ? undefined
          : params.armatureKgM2;
    const record: JointPhysics = {
      id: params.joint,
      ...(stops === undefined ? {} : { limits: stops }),
      ...(model === undefined ? {} : { friction: model }),
      ...(armature === undefined ? {} : { armatureKgM2: armature }),
    };
    const { [params.joint]: _removed, ...others } = dynamics.jointPhysics ?? {};
    const empty = stops === undefined && model === undefined && armature === undefined;
    const parts = [
      model === undefined ? null : `friction ${model.model}`,
      stops === undefined ? null : `end stops [${stops.min}, ${stops.max}] k ${stops.stiffness}`,
      armature === undefined ? null : `armature ${armature}`,
    ].filter((part) => part !== null);
    return changed(
      withDynamics(doc, { ...dynamics, jointPhysics: empty ? others : { ...others, [params.joint]: record } }),
      `set_joint_physics: joint '${params.joint}' — ${empty ? 'cleared' : parts.join(', ')}.`,
      [params.joint],
    );
  },
});
