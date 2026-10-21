/** Joints between rigid bodies and gear couplings between joints. */

import { GROUND, type DynamicJoint } from '@core/model/dynamics';
import type { Vec3 } from '@core/model/vectors';
import { buildTopology, isRefusal } from '../sim/topology';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { idOrNext } from '@lib/explicitId';
import { changed, commandError, failer, rejection } from '@core/commands/noop';
import { dynamicsIdTaken, dynamicsOf, withDynamics } from './bodies';
import { BODY_JOINT_KINDS, bodyJointKind } from './kinematicKinds';

const RAD_PER_S_PER_RPM = (2 * Math.PI) / 60;

/**
 * @affects adds 1 joint to doc.dynamics (affected: [jointId])
 * @invariant child is an existing non-fixed body (it may already have other joints: closed loops); parent is GROUND or another body;
 *            axis non-zero (revolute, prismatic); spherical joints carry no damping, friction or initial speed; the joint graph keeps a
 *            valid spanning tree (dynamics/topology.ts);
 *            stiffness >= 0 (spring force = -stiffness · (q - springReference), q measured from the modelled pose)
 * @failure unknown / fixed child, unknown parent, zero axis, taken id, spherical with damping / friction / spring / speed, FPR_LOOP_PRISMATIC
 *          (a prismatic joint would have to close a loop) -> no-op; a spherical joint alone on its body is accepted but FPR_SPHERICAL_TREE
 *          blocks simulate_motion until the body has a revolute or prismatic joint
 */
export const addBodyJoint = defineCommand({
  name: 'add_body_joint',
  description:
    'Connect a rigid body (child) to the ground or to another body (parent), for simulate_motion (physics joint with mass, forces and time; for a kinematic pose between component instances use add_joint + evaluate_motion instead). "revolute": the child spins about ' +
    '`axis` through `anchor` (a shaft in its bearings, a propeller hub, a crank pin, a hinge). "prismatic": the child slides along ' +
    '`axis` (a piston in its bore). "spherical": a ball pin at `anchor` (three rotations); it can only CLOSE A LOOP, never be the only ' +
    'connection of a body. `anchor` is a world point on the axis in DOCUMENT units (e.g. the shaft centre); `axis` a world direction ' +
    '(need not be unit; not used by spherical). A body may be the child of SEVERAL joints: that makes a closed loop (slider-crank, ' +
    'four-bar, multi-cylinder engine). llull then picks the spanning tree itself (prismatic joints first, then revolute, in creation ' +
    'order, so the last-declared joint of a loop becomes the closing constraint) and reports it in inspect_dynamics (data.topology, ' +
    'data.mobility: degrees of freedom, redundant constraints). Loop joints have no coordinate of their own: motors, gears, propellers ' +
    'and cylinder pressure must sit on tree joints. In a planar loop make one revolute loop joint "spherical" to avoid redundant ' +
    'constraints. Refusals: FPR_LOOP_PRISMATIC (a prismatic joint would close a loop: re-order, or use a revolute joint there), ' +
    'FPR_SPHERICAL_TREE (reported by inspect_dynamics / simulate_motion while a spherical joint is the only connection of its body: declare the revolute or prismatic joint too, in any order). The loop must be closed at the start pose: every joint has one anchor, so the pose of the bodies is the pose ' +
    'you modelled; give `anchorOnChild` only to state where the pin sits on the child body when it differs (the distance is the loop ' +
    'gap; above 1 µm simulate_motion refuses with FPR_LOOP_OPEN). Optional: damping (viscous, N·m·s/rad), friction (dry, N·m), ' +
    'initialRpm / initialVelocity (speed at t = 0). SPRING: `stiffness` makes the joint a spring (torsional N·m/rad for revolute, linear ' +
    'N/m for prismatic; 1 N/mm = 1000 N/m, 1 N·m/deg = 57.2958 N·m/rad) that is relaxed at `springReference` (rad or m, measured from the pose ' +
    'the joint is modelled in; default 0 = relaxed at the start pose). Mass-spring: prismatic joint + stiffness k, period 2π·sqrt(m/k). ' +
    'Spring energy counts in the potential energy of simulate_motion (energy: true). A spring needs a tree joint (not a loop-closing one). Returns the joint id in affected[0].',
  params: z.object({
    kind: z
      .enum(BODY_JOINT_KINDS)
      .describe(
        '"revolute" = rotation about the axis (MuJoCo hinge); "prismatic" = translation along it (slide); "spherical" or "ball" = ball pin, loop closure only. ' +
          'rigid, cylindrical, pin_slot, planar and cam exist as kinematic joints (add_joint) but have no single MuJoCo joint: they are refused here with the composition to use.',
      ),
    child: z.string().describe('Id of the moving body.'),
    parent: z.string().optional().describe(`Body the child is mounted on, or "${GROUND}" (default) for the fixed world.`),
    anchor: vec3('World point on the joint axis (the pin centre for spherical), document units, e.g. the shaft centre [0, 200, 800].'),
    axis: vec3('World direction of the axis, e.g. [0, 1, 0] for a shaft along Y. Required for revolute and prismatic.').optional(),
    anchorOnChild: vec3(
      'Where the pin sits on the child body, document units, when it differs from anchor. Only used when the joint closes a loop: the ' +
        'distance to anchor is the loop gap (refused above 1 µm). Default = anchor.',
    ).optional(),
    damping: z.number().min(0).optional().describe('Viscous damping: N·m·s/rad (revolute) or N·s/m (prismatic). Default 0.'),
    friction: z.number().min(0).optional().describe('Dry friction: N·m (revolute) or N (prismatic). Default 0.'),
    stiffness: z
      .number()
      .min(0)
      .optional()
      .describe('Spring stiffness: N·m/rad (revolute) or N/m (prismatic; 1 N/mm = 1000 N/m). Default 0 = no spring. Not for spherical.'),
    springReference: z
      .number()
      .optional()
      .describe(
        'Joint coordinate where the spring is relaxed: rad (revolute) or metres (prismatic), measured from the pose the joint is modelled in. Default 0.',
      ),
    initialRpm: z.number().optional().describe('Revolute only: speed at t = 0 in rpm (overrides initialVelocity).'),
    initialVelocity: z.number().optional().describe('Speed at t = 0: rad/s (revolute) or m/s (prismatic). Default 0.'),
    id: z.string().optional().describe('Optional explicit joint id.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_body_joint');
    const dynamics = dynamicsOf(doc);
    const parent = params.parent ?? GROUND;
    const child = dynamics.bodies[params.child];
    if (child === undefined) return fail(`child body '${params.child}' not found (add_rigid_body first)`);
    if (child.fixed) return fail(`body '${child.id}' is fixed to the ground and cannot move`);
    if (parent !== GROUND && dynamics.bodies[parent] === undefined) return fail(`parent body '${parent}' not found`);
    if (parent === child.id) return fail(`a body cannot be jointed to itself ('${parent}')`);
    const kind = bodyJointKind(params.kind);
    if (typeof kind === 'object') return fail(kind.refusal);
    const spherical = kind === 'spherical';
    const axis: Vec3 = params.axis ?? [0, 0, 1];
    if (!spherical && (params.axis === undefined || Math.hypot(...axis) < 1e-12)) return fail('axis must be a non-zero vector');
    const requestedSpeed = params.initialRpm !== undefined || (params.initialVelocity ?? 0) !== 0;
    if (spherical && ((params.damping ?? 0) !== 0 || (params.friction ?? 0) !== 0 || requestedSpeed))
      return fail('a spherical joint has no damping, friction or initial speed (put them on the tree joints)');
    if (spherical && (params.stiffness !== undefined || params.springReference !== undefined))
      return fail('a spherical joint has no spring (put stiffness on a revolute or prismatic tree joint)');
    if (params.springReference !== undefined && (params.stiffness ?? 0) === 0) return fail('springReference needs a stiffness > 0');
    const jointId = idOrNext(params.id, 'bjoint');
    if (dynamicsIdTaken(dynamics, jointId)) return fail(`id '${jointId}' is already used`);
    const initialVelocity =
      params.initialRpm !== undefined && kind === 'revolute' ? params.initialRpm * RAD_PER_S_PER_RPM : (params.initialVelocity ?? 0);
    const joint: DynamicJoint = {
      id: jointId,
      kind,
      parent,
      child: child.id,
      anchor: params.anchor,
      axis,
      ...(params.anchorOnChild !== undefined ? { anchorOnChild: params.anchorOnChild } : {}),
      damping: params.damping ?? 0,
      friction: params.friction ?? 0,
      ...((params.stiffness ?? 0) > 0 ? { stiffness: params.stiffness ?? 0 } : {}),
      ...((params.stiffness ?? 0) > 0 && (params.springReference ?? 0) !== 0 ? { springReference: params.springReference ?? 0 } : {}),
      initialVelocity,
    };
    const next = { ...dynamics, joints: { ...dynamics.joints, [jointId]: joint } };
    const topology = buildTopology(next);
    // a spherical joint may be declared before the joint that carries its body: only simulate_motion / inspect_dynamics complain then
    if (isRefusal(topology) && topology.code !== 'FPR_SPHERICAL_TREE')
      return rejection(
        doc,
        `add_body_joint: ${topology.code} — ${topology.error}; no-op.`,
        commandError(topology.code, topology.error, topology.ids),
      );
    const closes = !isRefusal(topology) && topology.loops.some((loop) => loop.id === jointId);
    const role = isRefusal(topology)
      ? `waiting: it can only close a loop, so '${child.id}' still needs a revolute or prismatic joint (FPR_SPHERICAL_TREE until then)`
      : closes
        ? `closes a loop (${topology.loops.length} loop(s), ${topology.tree.length} tree joint(s))`
        : 'tree joint';
    const sense = spherical
      ? `ball pin at [${params.anchor.join(', ')}]`
      : `axis [${axis.join(', ')}] through [${params.anchor.join(', ')}]`;
    const spring =
      joint.stiffness === undefined
        ? ''
        : `, spring ${joint.stiffness} ${kind === 'revolute' ? 'N·m/rad' : 'N/m'} relaxed at ${joint.springReference ?? 0} ${kind === 'revolute' ? 'rad' : 'm'}`;
    return changed(
      withDynamics(doc, next),
      `add_body_joint: ${kind} '${jointId}' — '${child.id}' on '${parent}', ${sense}${spring}; ${role}.`,
      [jointId],
    );
  },
});

/**
 * @affects adds 1 gear coupling to doc.dynamics (affected: [gearId])
 * @invariant driver !== driven, both existing joints; ratio finite and non-zero; a joint is driven by at most one gear
 * @failure unknown joint, self-coupling, zero ratio, already-driven joint, circular coupling, taken id -> no-op
 */
export const addGearCoupling = defineCommand({
  name: 'add_gear_coupling',
  description:
    'Couple two physics joints (add_body_joint) rigidly, like meshing gears, a belt or a chain: speed(driven) = ratio × speed(driver), enforced by the physics ' +
    "engine, so each side feels the other's inertia and load. ratio = -teeth(driver)/teeth(driven) for an external spur mesh (opposite " +
    'rotation), +teeth(driver)/teeth(driven) for a belt or an internal ring gear. Planetary with fixed ring, sun → carrier: ' +
    'ratio = sunTeeth / (sunTeeth + ringTeeth). Planets relative to the carrier: -ringTeeth / planetTeeth (driver = carrier joint). ' +
    'Kinematic-only equivalent for add_joint joints: add_drive_relation. Returns the coupling id in affected[0].',
  params: z.object({
    driver: z.string().describe('Joint id whose speed drives the other (e.g. the crankshaft joint).'),
    driven: z.string().describe('Joint id that follows (e.g. the propeller joint).'),
    ratio: z
      .number()
      .optional()
      .describe('speed(driven) / speed(driver); negative reverses the direction. Give this OR `teeth`; with both they must agree.'),
    teeth: z
      .tuple([z.number().int().positive(), z.number().int().positive()])
      .optional()
      .describe(
        'Tooth counts [driver, driven]: ratio = driverTeeth / drivenTeeth, exact (Rotax 912 reduction 21/51 pinion on the crank: [21, 51] gives 2388.24 rpm from 5800 rpm), negated by `reverseRotation`.',
      ),
    reverseRotation: z
      .boolean()
      .optional()
      .describe('With `teeth`: true for an external spur mesh (the driven shaft turns the other way, ratio negative). Default false.'),
    efficiency: z
      .number()
      .gt(0)
      .max(1)
      .optional()
      .describe(
        'Mesh efficiency in (0, 1] (FR-FPR-74): the transmitted torque is reduced by (1 - efficiency) on the driven shaft, against its rotation. ' +
          'Real spur meshes are above 0.98 with peaks 0.993-0.999 [NASA TM 81426]; 0.99 is the usual value. Omitted = ideal gear (1, no loss).',
      ),
    id: z.string().optional().describe('Optional explicit coupling id.'),
  }),
  run: (doc, { driver, driven, teeth, reverseRotation, efficiency, id, ...rest }): CommandResult => {
    const fail = failer(doc, 'add_gear_coupling');
    const fromTeeth = teeth === undefined ? undefined : (reverseRotation === true ? -1 : 1) * (teeth[0] / teeth[1]);
    if (rest.ratio === undefined && fromTeeth === undefined) return fail('give a ratio or tooth counts');
    if (rest.ratio !== undefined && fromTeeth !== undefined && Math.abs(rest.ratio - fromTeeth) > 1e-9 * Math.abs(fromTeeth))
      return fail(`ratio ${rest.ratio} disagrees with the tooth counts (${teeth?.join('/')} give ${fromTeeth})`);
    const ratio = rest.ratio ?? fromTeeth ?? 0;
    const dynamics = dynamicsOf(doc);
    if (dynamics.joints[driver] === undefined) return fail(`driver joint '${driver}' not found (add_body_joint first)`);
    if (dynamics.joints[driven] === undefined) return fail(`driven joint '${driven}' not found`);
    if (driver === driven) return fail('a joint cannot drive itself');
    if (!(Math.abs(ratio) > 0) || !Number.isFinite(ratio)) return fail('ratio must be finite and non-zero');
    const twice = Object.values(dynamics.gears).find((gear) => gear.driven === driven);
    if (twice !== undefined) return fail(`joint '${driven}' is already driven by gear '${twice.id}'`);
    const driverOf = new Map(Object.values(dynamics.gears).map((gear) => [gear.driven, gear.driver]));
    for (let current: string | undefined = driver, guard = 0; current !== undefined && guard <= driverOf.size; guard++) {
      if (current === driven) return fail(`'${driven}' already drives '${driver}' through gears: the coupling would be circular`);
      current = driverOf.get(current);
    }
    const gearId = idOrNext(id, 'gear');
    if (dynamicsIdTaken(dynamics, gearId)) return fail(`id '${gearId}' is already used`);
    return changed(
      withDynamics(doc, {
        ...dynamics,
        gears: {
          ...dynamics.gears,
          [gearId]: {
            id: gearId,
            driver,
            driven,
            ratio,
            ...(efficiency !== undefined ? { efficiency } : {}),
            ...(teeth !== undefined ? { teeth } : {}),
          },
        },
      }),
      `add_gear_coupling: '${gearId}' — speed(${driven}) = ${Number(ratio.toPrecision(8))} × speed(${driver})` +
        `${teeth === undefined ? '' : ` (teeth ${teeth.join('/')})`}, efficiency ${efficiency ?? 1}${efficiency === undefined ? ' (ideal; 0.99 is typical for a real mesh)' : ''}.`,
      [gearId],
    );
  },
});
