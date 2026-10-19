/**
 * `CadDocument.dynamics` + entity geometry → the engine-neutral `SimulationModel` (SI units). Bodies get their mass properties from their
 * entities' geometry; the joint tree is ordered parent before child; gear initial speeds are made consistent with the ratios.
 */

import type { CadDocument, Entity, Vec3 } from '../model/types';
import { DEFAULT_SOLVER_SETTINGS, GROUND, type DynamicsModel, type DynamicsSolverSettings, type RigidBody } from '../model/dynamics';
import { toMetres } from '../model/units';
import { entityBoundsInDoc } from '../geometry/bounds';
import type { GeometryKernel } from '../geometry/kernel';
import { resolveMassProperties } from '../geometry/resolveMassProperties';
import { resolveDensity, type DensityFallback } from '../geometry/resolveDensity';
import { combineMassProperties, type InertiaTensor, type MassProperties } from '../geometry/massProperties';
import { RAD_PER_S_PER_RPM, appliedLoadsFor, speedServoGains } from './forceLaws';
import type { SimulationBody, SimulationJoint, SimulationLoop, SimulationModel, SimulationServo, SimulationSpring } from './physicsEngine';
import { prepareCylinders, withCylinderForces, type CylinderRuntime } from './cylinderLoads';
import { withEngineLosses } from './engine/engineLosses';
import { consistentSpeeds } from './mobility';
import { announcedSpeed } from './timestep';
import type { CurveCode } from './pressureCurve';
import { buildTopology, isRefusal, type Topology, type TopologyRefusal } from './topology';
import { scale3 } from '../lib/vec3';

/** kg/m³ of a body entity without a material and without a body density: steel (a named default, AF-31). */
const DEFAULT_DENSITY: DensityFallback = { kgPerM3: 7850, source: 'default:steel 7850 kg/m^3', defaulted: true };

/** SI mass properties of one body (kg, m, kg·m²) and the densities they were computed from (`geometry/resolveDensity`). */
export interface BodyMassProperties {
  readonly mass: number;
  readonly centerOfMass: Vec3;
  readonly inertia: InertiaTensor;
  readonly densitySources: readonly string[];
  readonly densityDefaulted: boolean;
  readonly unverifiedReasons: readonly string[];
}

/** The mass distribution alone (what the reports and the inertia helpers read). */
export type BodyMassDistribution = Pick<BodyMassProperties, 'mass' | 'centerOfMass' | 'inertia'>;

/**
 * Mass properties of `body` in SI units, or an error. Entity densities come from `resolveDensity`: the assigned material (density model,
 * else its plain density), else the body density (kg/m³), else steel, reported as a default. `massKg` rescales the whole distribution.
 * With `kernel` (OCC) an exact B-rep part gets its exact inertia (`resolveMassProperties`).
 */
export function bodyMassProperties(
  doc: CadDocument,
  body: RigidBody,
  kernel?: GeometryKernel | null,
): BodyMassProperties | { error: string } {
  const metres = toMetres(doc, 1);
  const unitVolume = metres ** 3;
  const fallback: DensityFallback =
    body.density !== undefined
      ? { kgPerM3: body.density, source: `body '${body.id}' density ${body.density} kg/m^3`, defaulted: false }
      : DEFAULT_DENSITY;
  const sources = new Set<string>();
  const reasons = new Set<string>();
  let defaulted = false;
  let refused: { error: string } | null = null;
  const densityOf = (solid: Entity): number => {
    const density = resolveDensity(doc, solid.materialId, fallback);
    if (density === null) return 0;
    if (!density.available) {
      refused ??= { error: `${density.code}: body '${body.id}': ${density.reason}` };
      return 0;
    }
    const material = density.materialId === undefined ? undefined : doc.materials[density.materialId];
    const sourced = material?.source !== undefined && density.modelId === undefined;
    sources.add(sourced ? `material '${density.materialId}' density, source: ${material?.source}` : density.source);
    // a material that names its source (FR-FPR-73 catalogue) is not "given without a source"
    for (const reason of density.unverifiedReasons) if (!sourced) reasons.add(reason);
    defaulted ||= density.defaulted;
    return density.materialId === undefined ? density.kgPerM3 * unitVolume : density.gPerDocUnit3 / 1000;
  };
  const parts: MassProperties[] = [];
  for (const id of body.entityIds) {
    const entity = doc.entities[id];
    if (entity === undefined) return { error: `body '${body.id}' references missing entity '${id}'` };
    const props = resolveMassProperties(doc, entity, densityOf, { kernel: kernel ?? null })?.properties ?? null;
    if (refused !== null) return refused;
    if (props === null) return { error: `body '${body.id}': entity '${id}' (${entity.kind}) has no solid volume` };
    parts.push(props);
  }
  const combined = combineMassProperties(parts);
  if (combined === null) return { error: `body '${body.id}' has zero mass` };
  const scale = body.massKg !== undefined ? body.massKg / combined.mass : 1;
  return {
    mass: combined.mass * scale,
    centerOfMass: scale3(combined.centerOfMass, metres),
    inertia: combined.inertia.map((value) => value * scale * metres * metres) as unknown as InertiaTensor,
    densitySources: body.massKg !== undefined ? [`body '${body.id}' massKg ${body.massKg}`, ...sources] : [...sources],
    densityDefaulted: body.massKg === undefined && defaulted,
    unverifiedReasons: [...reasons],
  };
}

function unitAxis(axis: Vec3): Vec3 {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  return [axis[0] / length, axis[1] / length, axis[2] / length];
}

/** Joint speeds at t = 0: each driven joint left at 0 starts at ratio × its driver (else the gear constraint would jerk it). */
function initialVelocities(dynamics: DynamicsModel): Record<string, number> {
  const speeds: Record<string, number> = Object.fromEntries(Object.values(dynamics.joints).map((j) => [j.id, j.initialVelocity]));
  const gears = Object.values(dynamics.gears);
  for (let pass = 0; pass < gears.length; pass++)
    for (const gear of gears) {
      const driver = speeds[gear.driver] ?? 0;
      if (dynamics.joints[gear.driven]?.initialVelocity === 0 && driver !== 0) speeds[gear.driven] = gear.ratio * driver;
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

/** Moment of inertia (kg·m²) about `joint`'s axis of every body carried by it (its child and that child's descendants). */
function inertiaAboutJoint(bodies: readonly SimulationBody[], joint: SimulationJoint): number {
  const carried = new Set<string>();
  for (const body of bodies)
    if (body.joint?.id === joint.id || (body.parentId !== null && carried.has(body.parentId))) carried.add(body.id);
  return bodies.filter((body) => carried.has(body.id)).reduce((total, body) => total + inertiaAboutAxis(body, joint.anchor, joint.axis), 0);
}

/** First reference from a gear / motor / propeller to a joint that cannot move (missing, or on a fixed body). */
function danglingReference(dynamics: DynamicsModel, movable: ReadonlySet<string>, closing: ReadonlySet<string>): string | null {
  const why = (joint: string): string =>
    closing.has(joint) ? 'which closes a loop and has no coordinate of its own (use a tree joint of the loop)' : 'which cannot move';
  for (const gear of Object.values(dynamics.gears))
    for (const joint of [gear.driver, gear.driven])
      if (!movable.has(joint)) return `gear '${gear.id}' uses joint '${joint}', ${why(joint)}`;
  for (const load of [...Object.values(dynamics.motors), ...Object.values(dynamics.propellers)])
    if (!movable.has(load.joint)) return `'${load.id}' acts on joint '${load.joint}', ${why(load.joint)}`;
  return null;
}

/** Smallest half-distance between the two pins of a revolute loop, m. */
const MIN_HALF_SPAN = 0.005;

export interface BuiltSimulation {
  readonly model: SimulationModel;
  readonly cylinders: readonly CylinderRuntime[];
  readonly mass: Record<string, BodyMassProperties>;
  readonly topology: Topology;
  readonly settings: DynamicsSolverSettings;
}

export interface BuildRefusal {
  readonly error: string;
  /** FPR_* code when the refusal has one. */
  readonly code?: TopologyRefusal['code'] | CurveCode;
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
      simulationJoint = {
        id: entry.joint.id,
        kind: entry.joint.kind,
        anchor: scale3(entry.joint.anchor, metres),
        axis: entry.flipped ? [-axis[0], -axis[1], -axis[2]] : axis,
        damping: entry.joint.damping,
        friction: entry.joint.friction,
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
    if (motor.kind !== 'speed' || joint === undefined) return [];
    const gains = speedServoGains(inertiaAboutJoint(bodies, joint), timestep);
    return [{ id: motor.id, joint: motor.joint, targetVelocity: motor.rpm * RAD_PER_S_PER_RPM, ...gains, maxForce: motor.maxTorque }];
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
  const loads = withEngineLosses(gasLoads, Object.values(dynamics.losses ?? {}), cylinders);
  const solver = {
    integrator: settings.integrator,
    loopTimeConstant: settings.loopTimeConstantSteps * timestep,
    loopImpedance: settings.loopImpedance,
  };
  return {
    cylinders,
    model: {
      gravity: dynamics.gravity,
      bodies,
      gears: Object.values(dynamics.gears),
      loops,
      solver,
      servos,
      ...(springs.length > 0 ? { springs } : {}),
      loads,
    },
    mass,
    topology,
    settings,
  };
}
