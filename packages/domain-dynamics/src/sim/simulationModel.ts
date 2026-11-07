/**
 * `CadDocument.dynamics` + entity geometry → the engine-neutral `SimulationModel` (SI units). Bodies get their mass properties from their
 * entities' geometry; the joint tree is ordered parent before child; gear initial speeds are made consistent with the ratios.
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import { DEFAULT_SOLVER_SETTINGS, GROUND, type DynamicsModel, type DynamicsSolverSettings, type RigidBody } from '@core/model/dynamics';
import { transmissionJoints, transmissionRatio } from '@core/model/transmissions';
import { toMetres } from '@core/model/units';
import { entityBoundsInDoc } from '@core/geometry/bounds';
import type { GeometryKernel } from '@core/geometry/kernel';
import { bodyMassProperties, type BodyMassDistribution, type BodyMassProperties } from '@core/geometry/bodyMassProperties';
import { RAD_PER_S_PER_RPM, appliedLoadsFor, speedServoGains } from './forceLaws';
import type {
  SimulationBody,
  SimulationJoint,
  SimulationLoop,
  SimulationModel,
  SimulationServo,
  SimulationSpring,
} from '@core/dynamics/physicsEngine';
import { buildActuators, type ActuatorRefusal, type DriveRuntime } from './actuators/block';
import { buildJointPhysics, effectiveFriction, latchBlockers, type JointPhysicsRefusal } from './jointPhysics';
import { withLoadSchedules } from './loadSchedules';
import { reflectedInertia } from './reflectedInertia';
import { compileCouplings, rigidLinks, type CouplingRefusal } from './transmissions';
import { drivetrainOfMotor, isDatasheetMotor } from './actuators/machine';
import { prepareCylinders, withCylinderForces, type CylinderRuntime } from './cylinderLoads';
import { withInstalledLosses } from './engineLossHook';
import { consistentSpeeds } from './mobility';
import { announcedSpeed } from './timestep';
import type { CurveCode } from './pressureCurve';
import { buildTopology, isRefusal, type Topology, type TopologyRefusal } from './topology';
import { scale3 } from '@lib/vec3';
import { compileFlight, withFlightLoads, type FlightRuntime } from '../flight/flightLoads';

function unitAxis(axis: Vec3): Vec3 {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  return [axis[0] / length, axis[1] / length, axis[2] / length];
}

/** Joint speeds at t = 0: each driven joint left at 0 starts at ratio × its driver (else the transmission constraint would jerk it). */
function initialVelocities(dynamics: DynamicsModel): Record<string, number> {
  const speeds: Record<string, number> = Object.fromEntries(Object.values(dynamics.joints).map((j) => [j.id, j.initialVelocity]));
  const transmissions = Object.values(dynamics.transmissions ?? {});
  for (let pass = 0; pass < transmissions.length; pass++)
    for (const transmission of transmissions) {
      const { driver, driven } = transmissionJoints(transmission);
      const speed = speeds[driver] ?? 0;
      if (dynamics.joints[driven]?.initialVelocity === 0 && speed !== 0) speeds[driven] = transmissionRatio(transmission) * speed;
    }
  return speeds;
}

/** Moment of inertia (kg·m²) of a body about the line through `anchor` along unit `axis` (parallel-axis theorem). */
export function inertiaAboutAxis(body: BodyMassDistribution, anchor: Vec3, axis: Vec3): number {
  const [ax, ay, az] = axis;
  const [ixx, iyy, izz, ixy, ixz, iyz] = body.inertia;
  const own = ixx * ax * ax + iyy * ay * ay + izz * az * az + 2 * (ixy * ax * ay + ixz * ax * az + iyz * ay * az);
  const d = [0, 1, 2].map((i) => (body.centerOfMass[i] ?? 0) - (anchor[i] ?? 0));
  const along = (d[0] ?? 0) * ax + (d[1] ?? 0) * ay + (d[2] ?? 0) * az;
  const offsetSquared = d.reduce((sum, value) => sum + value * value, 0) - along * along;
  return own + body.mass * Math.max(0, offsetSquared);
}

/** Moment of inertia (kg·m²) about `joint`'s axis of every body carried by it (its child and that child's descendants); the carried mass (kg) for a prismatic joint. */
function inertiaAboutJoint(bodies: readonly SimulationBody[], joint: SimulationJoint): number {
  const carried = new Set<string>();
  for (const body of bodies)
    if (body.joint?.id === joint.id || (body.parentId !== null && carried.has(body.parentId))) carried.add(body.id);
  const mine = bodies.filter((body) => carried.has(body.id));
  if (joint.kind === 'prismatic') return mine.reduce((total, body) => total + body.mass, 0);
  return mine.reduce((total, body) => total + inertiaAboutAxis(body, joint.anchor, joint.axis), 0);
}

/** First reference from a transmission / joint physics / load schedule / motor / propeller to a joint that cannot move (missing, or on a fixed body). */
function danglingReference(dynamics: DynamicsModel, movable: ReadonlySet<string>, closing: ReadonlySet<string>): string | null {
  const why = (joint: string): string =>
    closing.has(joint) ? 'which closes a loop and has no coordinate of its own (use a tree joint of the loop)' : 'which cannot move';
  for (const transmission of Object.values(dynamics.transmissions ?? {}))
    for (const joint of Object.values(transmissionJoints(transmission)))
      if (!movable.has(joint)) return `transmission '${transmission.id}' uses joint '${joint}', ${why(joint)}`;
  for (const load of [...Object.values(dynamics.motors), ...Object.values(dynamics.propellers)])
    if (!movable.has(load.joint)) return `'${load.id}' acts on joint '${load.joint}', ${why(load.joint)}`;
  for (const physics of Object.values(dynamics.jointPhysics ?? {}))
    if (!movable.has(physics.id)) return `joint physics of '${physics.id}': the joint ${why(physics.id)}`;
  for (const schedule of Object.values(dynamics.loadSchedules ?? {}))
    if ('joint' in schedule.target && !movable.has(schedule.target.joint))
      return `load schedule '${schedule.id}' acts on joint '${schedule.target.joint}', ${why(schedule.target.joint)}`;
  return null;
}

/** Smallest half-distance between the two pins of a revolute loop, m. */
const MIN_HALF_SPAN = 0.005;

const NO_EXTRA = { armature: 0, friction: 0 };
const armatureOf = (joint: SimulationJoint): number => (joint.armature === undefined ? 0 : joint.armature);

/** Inertia and friction a datasheet motor adds to its joint (rotor behind the gearhead, no-load friction) and the armature of its joint physics, by joint id. */
function motorJointExtras(dynamics: DynamicsModel): Record<string, { armature: number; friction: number }> {
  const extras: Record<string, { armature: number; friction: number }> = {};
  for (const motor of Object.values(dynamics.motors)) {
    if (!isDatasheetMotor(motor)) continue;
    const p = drivetrainOfMotor(motor);
    const held = extras[motor.joint] ?? NO_EXTRA;
    extras[motor.joint] = { armature: held.armature + p.armatureKgM2, friction: held.friction + p.frictionNm };
  }
  for (const physics of Object.values(dynamics.jointPhysics ?? {}))
    if (physics.armatureKgM2 !== undefined) {
      const held = extras[physics.id] ?? NO_EXTRA;
      extras[physics.id] = { ...held, armature: held.armature + physics.armatureKgM2 };
    }
  return extras;
}

export interface BuiltSimulation {
  readonly model: SimulationModel;
  /** Driven datasheet motors of the run (empty when none). */
  readonly drives: readonly DriveRuntime[];
  readonly cylinders: readonly CylinderRuntime[];
  readonly mass: Record<string, BodyMassProperties>;
  readonly topology: Topology;
  readonly settings: DynamicsSolverSettings;
  /** Assumptions the build made that the report states (e.g. DRV_MESH_STIFFNESS_ASSUMED). */
  readonly notes: readonly string[];
  /** Rotors and body drag of the run (13 FLT); absent when the document has none. */
  readonly flight?: FlightRuntime;
}

export interface BuildRefusal {
  readonly error: string;
  /** FPR_* code when the refusal has one. */
  readonly code?: TopologyRefusal['code'] | CurveCode | ActuatorRefusal['code'] | CouplingRefusal['code'] | JointPhysicsRefusal['code'];
  readonly ids?: readonly string[];
}

/** Solver settings of the document: stored overrides on top of the defaults. */
export function solverSettingsOf(dynamics: DynamicsModel): DynamicsSolverSettings {
  return { ...DEFAULT_SOLVER_SETTINGS, ...dynamics.solver };
}

/** Half the shorter of the two bodies' extents along `axis` (m), at least MIN_HALF_SPAN; ground has no extent. */
function loopHalfSpan(doc: CadDocument, bodies: readonly (RigidBody | undefined)[], axis: Vec3, metres: number): number {
  const extents = bodies.flatMap((body) => {
    if (body === undefined) return [];
    const boxes = body.entityIds.flatMap((id) => {
      const entity = doc.entities[id];
      return entity === undefined ? [] : [entityBoundsInDoc(doc, entity)];
    });
    if (boxes.length === 0) return [];
    const min = [0, 1, 2].map((i) => Math.min(...boxes.map((box) => box.min[i] ?? 0)));
    const max = [0, 1, 2].map((i) => Math.max(...boxes.map((box) => box.max[i] ?? 0)));
    return [[0, 1, 2].reduce((sum, i) => sum + Math.abs(axis[i] ?? 0) * ((max[i] ?? 0) - (min[i] ?? 0)), 0) * metres];
  });
  return Math.max(MIN_HALF_SPAN, extents.length === 0 ? 0 : Math.min(...extents) / 2);
}

/** The simulation model of the document's dynamics at integration step `timestep` (s), or the first problem that prevents simulating it. */
export function buildSimulationModel(doc: CadDocument, timestep: number, kernel?: GeometryKernel | null): BuiltSimulation | BuildRefusal {
  const dynamics = doc.dynamics;
  if (dynamics === undefined || Object.keys(dynamics.bodies).length === 0) return { error: 'no rigid bodies (add_rigid_body first)' };
  const metres = toMetres(doc, 1);
  const topology = buildTopology(dynamics);
  if (isRefusal(topology)) return topology;
  const settings = solverSettingsOf(dynamics);
  const speeds = { ...initialVelocities(dynamics), ...consistentSpeeds(topology, initialVelocities(dynamics), metres) };
  const extras = motorJointExtras(dynamics);
  const mass: Record<string, BodyMassProperties> = {};
  const bodies: SimulationBody[] = [];
  for (const id of topology.bodyOrder) {
    const body = dynamics.bodies[id];
    if (body === undefined) continue;
    const props = bodyMassProperties(doc, body, kernel);
    if ('error' in props) return props;
    mass[body.id] = props;
    const entry = body.fixed ? undefined : topology.jointOfBody.get(body.id);
    let simulationJoint: SimulationJoint | null = null;
    if (entry !== undefined && entry.joint.kind !== 'spherical') {
      const axis = unitAxis(entry.joint.axis);
      const motorExtra = extras[entry.joint.id] ?? NO_EXTRA;
      const friction = effectiveFriction(dynamics, entry.joint);
      simulationJoint = {
        id: entry.joint.id,
        kind: entry.joint.kind,
        anchor: scale3(entry.joint.anchor, metres),
        axis: entry.flipped ? [-axis[0], -axis[1], -axis[2]] : axis,
        damping: friction.damping,
        friction: friction.dry + motorExtra.friction,
        ...(motorExtra.armature > 0 ? { armature: motorExtra.armature } : {}),
        ...(entry.joint.stiffness !== undefined
          ? { stiffness: entry.joint.stiffness, springReference: (entry.flipped ? -1 : 1) * (entry.joint.springReference ?? 0) }
          : {}),
        initialVelocity: speeds[entry.joint.id] ?? 0,
      };
    }
    bodies.push({
      id: body.id,
      parentId: entry === undefined || entry.parent === GROUND ? null : entry.parent,
      mass: props.mass,
      centerOfMass: props.centerOfMass,
      inertia: props.inertia,
      joint: simulationJoint,
      fixed: body.fixed,
    });
  }
  const simulated = new Map(bodies.flatMap((body) => (body.joint === null ? [] : [[body.joint.id, body.joint] as const])));
  const closing = new Set(topology.loops.map((loop) => loop.id));
  const dangling = danglingReference(dynamics, new Set(simulated.keys()), closing);
  if (dangling !== null) return { error: dangling };
  const springOnLoop = Object.values(dynamics.joints).find((joint) => joint.stiffness !== undefined && closing.has(joint.id));
  if (springOnLoop !== undefined)
    return {
      error: `joint '${springOnLoop.id}' has a spring but closes a loop (no coordinate of its own): put the spring on a tree joint`,
    };
  const servos: SimulationServo[] = Object.values(dynamics.motors).flatMap((motor) => {
    const joint = simulated.get(motor.joint);
    if ((motor.kind !== 'speed' && motor.kind !== 'linear_speed') || joint === undefined) return [];
    const gains = speedServoGains(inertiaAboutJoint(bodies, joint), timestep);
    return motor.kind === 'speed'
      ? [{ id: motor.id, joint: motor.joint, targetVelocity: motor.rpm * RAD_PER_S_PER_RPM, ...gains, maxForce: motor.maxTorque }]
      : [{ id: motor.id, joint: motor.joint, targetVelocity: motor.speedMps, ...gains, maxForce: motor.maxForceN }];
  });
  const loops: SimulationLoop[] = topology.loops.flatMap((loop) => {
    if (loop.kind === 'prismatic') return [];
    const axis = unitAxis(loop.axis);
    return [
      {
        id: loop.id,
        kind: loop.kind,
        bodyA: loop.parent === GROUND ? 'world' : loop.parent,
        bodyB: loop.child,
        anchor: scale3(loop.anchor, metres),
        axis,
        halfSpan: loopHalfSpan(doc, [dynamics.bodies[loop.parent], dynamics.bodies[loop.child]], axis, metres),
      },
    ];
  });
  const missingEnd = Object.values(dynamics.springs ?? {}).flatMap((spring) =>
    [spring.bodyA, spring.bodyB].filter((end) => end !== GROUND && dynamics.bodies[end] === undefined).map((end) => `${spring.id}: ${end}`),
  )[0];
  if (missingEnd !== undefined) return { error: `spring ${missingEnd} is not a rigid body` };
  const springs: SimulationSpring[] = Object.values(dynamics.springs ?? {}).map((spring) => ({
    id: spring.id,
    bodyA: spring.bodyA === GROUND ? 'world' : spring.bodyA,
    bodyB: spring.bodyB === GROUND ? 'world' : spring.bodyB,
    pointA: scale3(spring.pointA, metres),
    pointB: scale3(spring.pointB, metres),
    stiffness: spring.stiffness,
    damping: spring.damping,
    freeLength: spring.freeLengthM,
  }));
  const bodyOfJoint = Object.fromEntries(Object.values(dynamics.joints).map((joint) => [joint.id, joint.child]));
  const baseLoads = appliedLoadsFor(Object.values(dynamics.motors), Object.values(dynamics.propellers), bodyOfJoint);
  const announcedRpm = announcedSpeed(dynamics) / RAD_PER_S_PER_RPM;
  const cylinders = prepareCylinders(dynamics, topology, metres, announcedRpm > 0 ? announcedRpm : undefined);
  if ('error' in cylinders) return cylinders;
  const gasLoads = cylinders.length > 0 ? withCylinderForces(baseLoads, cylinders) : baseLoads;
  const losses = withInstalledLosses(gasLoads, Object.values(dynamics.losses ?? {}), cylinders);
  if ('error' in losses) return losses;
  const signOf = (jointId: string): number => (topology.tree.find((entry) => entry.joint.id === jointId)?.flipped === true ? -1 : 1);
  const scheduled = withLoadSchedules(losses, dynamics, signOf);
  if ('error' in scheduled) return scheduled;
  const centers = Object.fromEntries(Object.entries(mass).map(([id, props]) => [id, props.centerOfMass]));
  const flight = compileFlight(doc, centers, metres);
  if (flight !== null && 'error' in flight) return flight;
  const loads = flight === null ? scheduled : withFlightLoads(scheduled, flight);
  const ownInertia = (jointId: string): number | undefined => {
    const joint = simulated.get(jointId);
    return joint === undefined ? undefined : inertiaAboutJoint(bodies, joint) + armatureOf(joint);
  };
  const compiled = compileCouplings(dynamics, { sign: signOf, own: ownInertia, timestep });
  if ('error' in compiled) return { error: `${compiled.code} — ${compiled.error}`, code: compiled.code };
  const links = rigidLinks(dynamics, signOf);
  const jointPhysics = buildJointPhysics(dynamics, {
    timestep,
    sign: signOf,
    inertiaOf: (jointId) => reflectedInertia(jointId, links, ownInertia),
    unlatched: latchBlockers(dynamics, topology.loops.length > 0),
  });
  if (jointPhysics !== null && 'error' in jointPhysics)
    return { error: `${jointPhysics.code} — ${jointPhysics.error}`, code: jointPhysics.code };
  const actuators = buildActuators(dynamics, {
    timestep,
    inertiaOf: (jointId) => {
      const joint = simulated.get(jointId);
      return joint === undefined ? undefined : inertiaAboutJoint(bodies, joint) + armatureOf(joint);
    },
  });
  if (actuators !== null && 'code' in actuators) return { error: `${actuators.code} — ${actuators.error}`, code: actuators.code };
  const solver = {
    integrator: settings.integrator,
    loopTimeConstant: settings.loopTimeConstantSteps * timestep,
    loopImpedance: settings.loopImpedance,
  };
  return {
    cylinders,
    drives: actuators?.drives ?? [],
    model: {
      gravity: dynamics.gravity,
      bodies,
      transmissions: compiled.couplings,
      loops,
      solver,
      servos,
      ...(springs.length > 0 ? { springs } : {}),
      ...(jointPhysics === null ? {} : { jointPhysics: jointPhysics.block }),
      ...(actuators === null ? {} : { actuators: actuators.block }),
      loads,
      ...(flight === null ? {} : { bodyStates: flight.bodies }),
    },
    mass,
    topology,
    settings,
    notes: [...compiled.warnings, ...(jointPhysics?.notes ?? [])],
    ...(flight === null ? {} : { flight }),
  };
}

/** kg·m² seen by joint `jointId` of a built simulation (bodies it carries + armature), or undefined when the joint cannot move. */
export function jointInertiaOf(built: BuiltSimulation, jointId: string): number | undefined {
  const joint = built.model.bodies.find((body) => body.joint?.id === jointId)?.joint;
  return joint === undefined || joint === null ? undefined : inertiaAboutJoint(built.model.bodies, joint) + armatureOf(joint);
}
