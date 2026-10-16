/**
 * Joint realisation (FR-FPR-08, exact faces only): a revolute joint is physically realised when a pin (convex cylinder) on one side and a
 * bore (concave cylinder) on the other are coaxial with the joint axis. Reports the diametral clearance and the axial engagement.
 * @invariant a kernel without face axes (Manifold) yields `not_run`, never a pass
 * @failure no coaxial pin / bore pair -> `FPR_JOINT_NOT_REALISED` (warn)
 */

import type { CheckItem } from '../../model/checkResult';
import type { Vec3 } from '../../model/types';
import { cross3, dot3, len3, normalize3, sub3 } from '../../lib/vec3';
import type { GeometryKernel, ShapeFace, ShapeHandle } from '../kernel';
import { kernelUnsupportedItem, makeItem } from './partValidity';

export interface RevoluteJointInput {
  readonly id: string;
  /** World point on the joint axis and the axis direction (document units). */
  readonly anchor: Vec3;
  readonly axis: Vec3;
  /** Shapes of the parent side (empty when the parent is the world) and of the child side. */
  readonly parentShapes: readonly ShapeHandle[];
  readonly childShapes: readonly ShapeHandle[];
  readonly mmPerUnit: number;
}

/** Parallelism tolerance of a face axis to the joint axis (degrees). */
const ANGLE_DEGREES = 0.5;
/** Axis offset tolerance: absolute (mm) plus relative to the radius. */
const OFFSET_ABSOLUTE_MM = 0.01;
const OFFSET_RELATIVE = 1e-4;

interface Candidate {
  readonly convex: boolean;
  readonly radius: number;
  /** Axial interval along the joint axis, measured from the anchor. */
  readonly range: readonly [number, number];
}

function candidatesOf(kernel: GeometryKernel, shapes: readonly ShapeHandle[], input: RevoluteJointInput): Candidate[] | null {
  const axis = normalize3(input.axis);
  const found: Candidate[] = [];
  for (const shape of shapes) {
    const topology = kernel.topology(shape);
    if (topology === null) return null;
    for (const face of topology.faces as readonly ShapeFace[]) {
      const info = face.axis;
      if (face.surface !== 'cylinder' || info === undefined || info.radius === undefined || face.convex === undefined) continue;
      const direction = normalize3(info.direction);
      if (len3(cross3(direction, axis)) > Math.sin((ANGLE_DEGREES * Math.PI) / 180)) continue;
      const offset = len3(cross3(sub3(info.origin, input.anchor), axis));
      if (offset > OFFSET_ABSOLUTE_MM / input.mmPerUnit + OFFSET_RELATIVE * info.radius) continue;
      const sign = dot3(direction, axis) >= 0 ? 1 : -1;
      const base = dot3(sub3(info.origin, input.anchor), axis);
      const [low, high] = info.span ?? [0, 0];
      const ends = [base + sign * low, base + sign * high].sort((p, q) => p - q);
      found.push({ convex: face.convex, radius: info.radius, range: [ends[0] ?? 0, ends[1] ?? 0] });
    }
  }
  return found;
}

/** The item for one revolute joint. */
export function realiseJoint(kernel: GeometryKernel, input: RevoluteJointInput): CheckItem {
  const ids = [input.id];
  const parent = candidatesOf(kernel, input.parentShapes, input);
  const child = candidatesOf(kernel, input.childShapes, input);
  if (parent === null || child === null) return kernelUnsupportedItem(ids, 'joint realisation (exact cylinder faces)');
  let best: { pin: Candidate; bore: Candidate } | null = null;
  for (const [sideA, sideB] of [
    [parent, child],
    [child, parent],
  ] as const) {
    for (const pin of sideA.filter((face) => face.convex)) {
      for (const bore of sideB.filter((face) => !face.convex)) {
        if (best === null || Math.abs(bore.radius - pin.radius) < Math.abs(best.bore.radius - best.pin.radius)) best = { pin, bore };
      }
    }
  }
  if (best === null)
    return makeItem(
      'FPR_JOINT_NOT_REALISED',
      'warn',
      ids,
      'Model the journal (pin) on one part and the bore on the other, coaxial with the joint axis.',
      { note: 'no coaxial pin / bore cylinder pair found on the two sides of the joint' },
    );
  const { pin, bore } = best;
  const engagement = Math.max(0, Math.min(pin.range[1], bore.range[1]) - Math.max(pin.range[0], bore.range[0]));
  return makeItem('FPR_JOINT_REALISED', 'pass', ids, 'Pin and bore found.', {
    values: {
      pinDiameterMm: 2 * pin.radius * input.mmPerUnit,
      boreDiameterMm: 2 * bore.radius * input.mmPerUnit,
      diametralClearanceMm: 2 * (bore.radius - pin.radius) * input.mmPerUnit,
      engagementMm: engagement * input.mmPerUnit,
    },
  });
}
