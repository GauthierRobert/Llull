/**
 * Engine geometry of one cylinder, read from the joints of the mechanism at t = 0 (TR-FPR §5.4): crank radius, rod length, cylinder axis
 * and offset, the crank angle of the top position, and the joints that carry the derived loads (wrist pin, crank pin).
 */

import { GROUND, type CylinderPressure, type DynamicJoint, type DynamicsModel } from '../model/dynamics';
import type { Vec3 } from '../model/vectors';
import { createSlider, sliderStroke, type Slider } from './slider';
import type { Topology } from './topology';

export interface EngineLayout {
  readonly cylinderId: string;
  readonly pistonJoint: string;
  readonly crankJoint: string;
  /** The joint between piston and rod (tree or loop) and the one between rod and crank. */
  readonly wristJoint: string;
  readonly crankPinJoint: string;
  readonly pistonBody: string;
  readonly rodBody: string;
  readonly crankBody: string;
  /** Metres. */
  readonly slider: Slider;
  readonly strokeM: number;
  readonly pistonAreaM2: number;
  readonly clearanceVolumeM3: number;
  readonly displacementM3: number;
  /** Crank joint angle (rad from its t = 0 pose, in [0, 2 pi)) at which this piston is at its top. */
  readonly topCrankAngleRad: number;
  /** +1 when the head lies along the piston joint's positive axis, else -1. */
  readonly headSign: 1 | -1;
  /** The cylinder axis does not pass through the crank axis. */
  readonly offset: boolean;
  /** World crank axis (unit), the crank centre and the cylinder head direction (unit), metres. */
  readonly crankAxis: Vec3;
  readonly crankCenter: Vec3;
  readonly headDirection: Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
};
const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
const metres = (v: Vec3, m: number): Vec3 => scale(v, m);

const TWO_PI = 2 * Math.PI;

/** Joint between bodies `a` and `b` (either sense) of the given kinds, other than `except`. */
function jointBetween(dynamics: DynamicsModel, a: string, b: string, except: ReadonlySet<string>): DynamicJoint | undefined {
  return Object.values(dynamics.joints).find(
    (joint) =>
      !except.has(joint.id) &&
      joint.kind !== 'prismatic' &&
      ((joint.parent === a && joint.child === b) || (joint.parent === b && joint.child === a)),
  );
}

/** The layout of `cylinder`, or the reason it cannot be derived (the mechanism is incomplete or inconsistent). */
export function engineLayout(
  dynamics: DynamicsModel,
  topology: Topology,
  cylinder: CylinderPressure,
  metresPerUnit: number,
): EngineLayout | { error: string } {
  const piston = dynamics.joints[cylinder.piston];
  const crank = dynamics.joints[cylinder.crank];
  if (piston === undefined || piston.kind !== 'prismatic') return { error: `piston '${cylinder.piston}' is not a prismatic joint` };
  if (crank === undefined || crank.kind !== 'revolute') return { error: `crank '${cylinder.crank}' is not a revolute joint` };
  const inTree = (id: string): boolean => topology.tree.some((entry) => entry.joint.id === id);
  if (!inTree(piston.id) || !inTree(crank.id))
    return {
      error: `the piston and crank joints must be tree joints (not loop closures); '${inTree(piston.id) ? crank.id : piston.id}' closes a loop`,
    };
  const except = new Set([piston.id, crank.id]);
  const pistonBody = piston.child;
  const crankBody = crank.child;
  let wrist: DynamicJoint | undefined;
  let pin: DynamicJoint | undefined;
  for (const candidate of Object.values(dynamics.joints)) {
    if (except.has(candidate.id) || candidate.kind === 'prismatic') continue;
    const rod = candidate.child === pistonBody ? candidate.parent : candidate.parent === pistonBody ? candidate.child : undefined;
    if (rod === undefined || rod === GROUND || rod === crankBody) continue;
    const link = jointBetween(dynamics, rod, crankBody, new Set([...except, candidate.id]));
    if (link !== undefined) [wrist, pin] = [candidate, link];
    if (wrist !== undefined) break;
  }
  if (wrist === undefined || pin === undefined)
    return {
      error: `no connecting rod: expected a joint between piston body '${pistonBody}' and a rod body, and one between that rod and crank body '${crankBody}'`,
    };
  const rodBody = wrist.child === pistonBody ? wrist.parent : wrist.child;
  const m = metresPerUnit;
  const [center, axis, wristPoint, pinPoint, cylinderAxis] = [
    metres(crank.anchor, m),
    unit(crank.axis),
    metres(wrist.anchor, m),
    metres(pin.anchor, m),
    unit(piston.axis),
  ];
  if (Math.abs(dot(cylinderAxis, axis)) > 1e-3) return { error: 'the cylinder axis must be perpendicular to the crank axis' };
  const reach = dot(sub(wristPoint, center), cylinderAxis);
  const headSign: 1 | -1 = reach < 0 ? -1 : 1;
  const head = scale(cylinderAxis, headSign);
  const normal = cross(axis, head);
  const pinVector = sub(pinPoint, center);
  const [pinHead, pinNormal] = [dot(pinVector, head), dot(pinVector, normal)];
  const r = Math.hypot(pinHead, pinNormal);
  const rodVector = sub(pinPoint, wristPoint);
  const l = Math.hypot(dot(rodVector, head), dot(rodVector, normal));
  const offset = dot(sub(wristPoint, center), normal);
  if (r < 1e-9) return { error: 'the crank pin lies on the crank axis (crank radius 0)' };
  if (l <= r + Math.abs(offset))
    return { error: `the rod (${(l * 1000).toPrecision(5)} mm) is not longer than the crank radius plus the offset` };
  const slider = createSlider(r, l, offset);
  const pinAngle = Math.atan2(pinNormal, pinHead);
  const top = (((slider.top - pinAngle) % TWO_PI) + TWO_PI) % TWO_PI;
  const strokeM = sliderStroke(slider);
  const area = (Math.PI * (cylinder.boreMm / 1000) ** 2) / 4;
  const displacement = area * strokeM;
  return {
    cylinderId: cylinder.id,
    pistonJoint: piston.id,
    crankJoint: crank.id,
    wristJoint: wrist.id,
    crankPinJoint: pin.id,
    pistonBody,
    rodBody,
    crankBody,
    slider,
    strokeM,
    pistonAreaM2: area,
    clearanceVolumeM3: displacement / (cylinder.compressionRatio - 1),
    displacementM3: displacement,
    topCrankAngleRad: top,
    headSign,
    offset: Math.abs(offset) > 1e-9 * l,
    crankAxis: axis,
    crankCenter: center,
    headDirection: head,
  };
}
