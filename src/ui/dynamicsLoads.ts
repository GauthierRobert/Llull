// What acts on the rigid-body model, as one reviewable list: each body's weight (gravity at its centre of mass), every joint axis, gear
// coupling, motor drive torque and propeller thrust — with its value in SI and, during playback, the value at the playback time. Read by
// the Physics "Loads & forces" review list and drawn by the viewport's DynamicsLoadsOverlay, so both always show the same thing.

import type { CadDocument, Vec3 } from '@core/model/types';
import { GROUND, type DynamicJoint, type DynamicsModel, type Motor, type PropellerLoad } from '@core/model/dynamics';
import { bodyMassProperties } from '@core/dynamics/simulationModel';
import { RAD_PER_S_PER_RPM, propellerOutput } from '@core/dynamics/forceLaws';
import type { SimulationData } from '@core/dynamics/simulationReport';
import { toMetres } from '@core/model/units';

export const LOAD_LAYERS = ['gravity', 'joints', 'drives', 'thrust'] as const;
export type LoadLayer = (typeof LOAD_LAYERS)[number];

export const LOAD_LAYER_LABELS: Readonly<Record<LoadLayer, string>> = {
  gravity: 'Weight',
  joints: 'Joints & gears',
  drives: 'Motor torque',
  thrust: 'Thrust',
};

/** Glyph / swatch colour per layer (viewport overlay and review list). */
export const LOAD_COLORS: Readonly<Record<LoadLayer, string>> = {
  gravity: '#ff9100',
  joints: '#00b8d4',
  drives: '#64dd17',
  thrust: '#ff4081',
};

/** force: arrow along `direction`; torque: ring about `direction`; axis: line through `origin`; link: dashed `origin`→`end`. */
type LoadShape = 'force' | 'torque' | 'axis' | 'link';

export interface LoadItem {
  readonly id: string;
  readonly layer: LoadLayer;
  readonly shape: LoadShape;
  /** Who it acts on / what it is, e.g. `Crank` or `Crank ⟳ ground`. */
  readonly title: string;
  /** Short value shown in the list and next to the glyph, e.g. `W 12.3 N`. */
  readonly value: string;
  /** The setup behind it, for review, e.g. `revolute · damping 0.02 N·m·s/rad`. */
  readonly detail: string;
  /** Document units. */
  readonly origin: Vec3;
  /** Unit vector. */
  readonly direction: Vec3;
  /** Document units; link only. */
  readonly end?: Vec3;
  /** |N| or |N·m| for force / torque (sizes the glyph); null = not a quantity. */
  readonly magnitude: number | null;
}

export const formatQuantity = (value: number, digits = 3): string => {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e4 || abs < 1e-2) return value.toExponential(digits - 1);
  return value.toLocaleString('en-US', { maximumSignificantDigits: digits });
};

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1];
}

/** Index of the last sample at or before `time` (0 when none). */
function sampleIndex(times: readonly number[], time: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((times[mid] ?? 0) <= time) low = mid;
    else high = mid - 1;
  }
  return Math.max(low, 0);
}

/** Value of `series` at `time` (last sample at or before it); undefined when there is no series. */
function sampleAt(times: readonly number[], series: readonly number[] | undefined, time: number): number | undefined {
  if (series === undefined || series.length === 0) return undefined;
  return series[Math.min(sampleIndex(times, time), series.length - 1)];
}

/** Playback state the values are read at: the last run and the playback time, or none (design values). */
export interface LoadPlayback {
  readonly result: SimulationData;
  readonly time: number;
}

interface Context {
  readonly doc: CadDocument;
  readonly dynamics: DynamicsModel;
  readonly playback: LoadPlayback | null;
  readonly centres: Readonly<Record<string, Vec3>>;
  readonly bodyName: (id: string) => string;
}

/** Body centre of mass in document units: the replayed pose at the playback time, else the design pose. */
function centreAt(context: Context, bodyId: string): Vec3 | undefined {
  const poses = context.playback?.result.poses;
  const track = poses?.bodies[bodyId];
  if (poses !== undefined && track !== undefined && track.position.length > 0) {
    const index = sampleIndex(poses.times, context.playback?.time ?? 0);
    return track.position[Math.min(index, track.position.length - 1)];
  }
  return context.centres[bodyId];
}

function weightItems(context: Context): LoadItem[] {
  const { dynamics, doc } = context;
  const g = Math.hypot(...dynamics.gravity);
  const items: LoadItem[] = [];
  for (const body of Object.values(dynamics.bodies)) {
    const props = bodyMassProperties(doc, body);
    const origin = centreAt(context, body.id);
    if ('error' in props || origin === undefined) continue;
    const weight = props.mass * g;
    const density =
      body.massKg !== undefined ? `mass set to ${formatQuantity(body.massKg)} kg` : `${formatQuantity(body.density ?? 7850)} kg/m³`;
    items.push({
      id: `weight:${body.id}`,
      layer: 'gravity',
      shape: 'force',
      title: context.bodyName(body.id),
      value: `W ${formatQuantity(weight)} N`,
      detail: `${formatQuantity(props.mass)} kg · ${density}${body.fixed ? ' · fixed to ground' : ''} · ${body.entityIds.length} part(s)`,
      origin,
      direction: g > 0 ? unit(dynamics.gravity) : [0, 0, -1],
      magnitude: body.fixed ? 0 : weight,
    });
  }
  return items;
}

function jointDetail(joint: DynamicJoint): string {
  const revolute = joint.kind === 'revolute';
  const speed = revolute
    ? `${formatQuantity(joint.initialVelocity / RAD_PER_S_PER_RPM)} rpm`
    : `${formatQuantity(joint.initialVelocity)} m/s`;
  const parts = [
    joint.kind,
    `damping ${formatQuantity(joint.damping)} ${revolute ? 'N·m·s/rad' : 'N·s/m'}`,
    `friction ${formatQuantity(joint.friction)} ${revolute ? 'N·m' : 'N'}`,
  ];
  if (joint.initialVelocity !== 0) parts.push(`starts at ${speed}`);
  return parts.join(' · ');
}

function jointItems(context: Context): LoadItem[] {
  const { dynamics, playback } = context;
  const items: LoadItem[] = Object.values(dynamics.joints).map((joint) => {
    const live = playback?.result.joints[joint.id];
    const velocity = sampleAt(playback?.result.series?.times ?? [], playback?.result.series?.jointVelocity[joint.id], playback?.time ?? 0);
    const value =
      velocity === undefined
        ? joint.kind
        : joint.kind === 'revolute'
          ? `${formatQuantity(velocity / RAD_PER_S_PER_RPM)} rpm`
          : `${formatQuantity(velocity)} m/s`;
    return {
      id: joint.id,
      layer: 'joints',
      shape: 'axis',
      title: `${context.bodyName(joint.child)} ${joint.kind === 'revolute' ? '⟳' : '⇄'} ${context.bodyName(joint.parent)}`,
      value: live === undefined && velocity === undefined ? joint.kind : value,
      detail: jointDetail(joint),
      origin: joint.anchor,
      direction: unit(joint.axis),
      magnitude: null,
    } satisfies LoadItem;
  });
  for (const gear of Object.values(dynamics.gears)) {
    const driver = dynamics.joints[gear.driver];
    const driven = dynamics.joints[gear.driven];
    if (driver === undefined || driven === undefined) continue;
    const measured = playback?.result.gears[gear.id]?.measuredRatio;
    items.push({
      id: gear.id,
      layer: 'joints',
      shape: 'link',
      title: `${gear.driver} → ${gear.driven}`,
      value: `ratio ${formatQuantity(gear.ratio)}`,
      detail: `gear / belt coupling: driven speed = ${formatQuantity(gear.ratio)} × driver${
        measured !== undefined && measured !== null ? ` · measured ${formatQuantity(measured)}` : ''
      }`,
      origin: driver.anchor,
      end: driven.anchor,
      direction: unit(driven.axis),
      magnitude: null,
    });
  }
  return items;
}

function motorDesign(motor: Motor): { value: string; detail: string; magnitude: number } {
  if (motor.kind === 'speed')
    return {
      value: `${formatQuantity(motor.rpm)} rpm`,
      detail: `speed governor: holds ${formatQuantity(motor.rpm)} rpm with at most ${formatQuantity(motor.maxTorque)} N·m`,
      magnitude: motor.maxTorque,
    };
  const peak = motor.curve.reduce((best, point) => (point[1] > best[1] ? point : best), motor.curve[0] ?? [0, 0]);
  const rpms = motor.curve.map((point) => point[0]);
  return {
    value: `≤ ${formatQuantity(peak[1] * motor.throttle)} N·m`,
    detail: `torque curve ${formatQuantity(Math.min(...rpms))}–${formatQuantity(Math.max(...rpms))} rpm, peak ${formatQuantity(peak[1])} N·m @ ${formatQuantity(peak[0])} rpm · throttle ${formatQuantity(motor.throttle * 100)} %`,
    magnitude: peak[1] * motor.throttle,
  };
}

function motorItems(context: Context): LoadItem[] {
  const { dynamics, playback } = context;
  const items: LoadItem[] = [];
  for (const motor of Object.values(dynamics.motors)) {
    const joint = dynamics.joints[motor.joint];
    if (joint === undefined) continue;
    const design = motorDesign(motor);
    const torque = sampleAt(playback?.result.series?.times ?? [], playback?.result.series?.motorTorque[motor.id], playback?.time ?? 0);
    items.push({
      id: motor.id,
      layer: 'drives',
      shape: 'torque',
      title: `${motor.id} on ${context.bodyName(joint.child)}`,
      value: torque === undefined ? design.value : `${formatQuantity(torque)} N·m`,
      detail: design.detail,
      origin: joint.anchor,
      direction: unit(joint.axis),
      magnitude: torque === undefined ? design.magnitude : Math.abs(torque),
    });
  }
  return items;
}

/** Design thrust: at the speed a speed motor on the same joint holds; unknown otherwise (it depends on the run). */
function designThrust(dynamics: DynamicsModel, propeller: PropellerLoad): number | null {
  const governor = Object.values(dynamics.motors).find((motor) => motor.kind === 'speed' && motor.joint === propeller.joint);
  if (governor === undefined || governor.kind !== 'speed') return null;
  return propellerOutput(propeller, governor.rpm * RAD_PER_S_PER_RPM).thrust;
}

function propellerItems(context: Context): LoadItem[] {
  const { dynamics, playback } = context;
  const items: LoadItem[] = [];
  for (const propeller of Object.values(dynamics.propellers)) {
    const joint = dynamics.joints[propeller.joint];
    if (joint === undefined) continue;
    const live = sampleAt(
      playback?.result.series?.times ?? [],
      playback?.result.series?.propellerThrust[propeller.id],
      playback?.time ?? 0,
    );
    const thrust = live ?? designThrust(dynamics, propeller);
    items.push({
      id: propeller.id,
      layer: 'thrust',
      shape: 'force',
      title: `${propeller.id} on ${context.bodyName(joint.child)}`,
      value: thrust === null ? 'T after a run' : `T ${formatQuantity(thrust)} N`,
      detail: `Ø ${formatQuantity(propeller.diameter)} m · Ct ${formatQuantity(propeller.thrustCoefficient)} · Cp ${formatQuantity(propeller.powerCoefficient)} · ρ ${formatQuantity(propeller.airDensity)} kg/m³${live === undefined && thrust !== null ? ' · at the governed speed' : ''}`,
      origin: centreAt(context, joint.child) ?? joint.anchor,
      direction: unit(propeller.thrustDirection),
      magnitude: thrust,
    });
  }
  return items;
}

/** Design-pose centres of mass (document units), per body; bodies whose mass cannot be computed are left out. */
export function bodyCentres(doc: CadDocument): Record<string, Vec3> {
  const perUnit = toMetres(doc, 1);
  const centres: Record<string, Vec3> = {};
  for (const body of Object.values(doc.dynamics?.bodies ?? {})) {
    const props = bodyMassProperties(doc, body);
    if (!('error' in props)) centres[body.id] = props.centerOfMass.map((c) => c / perUnit) as unknown as Vec3;
  }
  return centres;
}

/** Every load of the document's dynamics model, in layer order; empty without dynamics. */
export function dynamicsLoads(doc: CadDocument, playback: LoadPlayback | null, centres: Readonly<Record<string, Vec3>>): LoadItem[] {
  const dynamics = doc.dynamics;
  if (dynamics === undefined) return [];
  const bodyName = (id: string): string => (id === GROUND ? 'ground' : (dynamics.bodies[id]?.name ?? id));
  const context: Context = { doc, dynamics, playback, centres, bodyName };
  return [...weightItems(context), ...jointItems(context), ...motorItems(context), ...propellerItems(context)];
}
