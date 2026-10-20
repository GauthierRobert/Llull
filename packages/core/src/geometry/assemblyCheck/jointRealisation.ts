/**
 * Joint realisation (FR-FPR-08, exact faces only): a revolute joint is physically realised when a pin (convex cylinder) on one side and a
 * bore (concave cylinder) on the other are coaxial with the joint axis. Reports the diametral clearance and the axial engagement.
 * @invariant a kernel without face axes (Manifold) fits cylinders to the tessellation (`unverified`, note "approximate"); with no tessellation
 *   either the item is `not_run`, never a pass
 * @failure no coaxial pin / bore pair -> `FPR_JOINT_NOT_REALISED` (warn)
 */

import type { CheckItem } from '../../model/checkResult';
import type { MeshData, Vec3 } from '../../model/types';
import { cross3, dot3, len3, normalize3, sub3 } from '../../lib/vec3';
import type { GeometryKernel, ShapeFace, ShapeHandle } from '../kernel';
import { ANGLE_DEGREES, type Candidate, OFFSET_ABSOLUTE_MM, OFFSET_RELATIVE, meshCandidates } from './jointCandidates';
import { kernelUnsupportedItem, makeItem } from './partValidity';

export interface RevoluteJointInput {
  readonly id: string;
  /** World point on the joint axis and the axis direction (document units). */
  readonly anchor: Vec3;
  readonly axis: Vec3;
  /** Shapes of the parent side (empty when the parent is the world) and of the child side. */
  readonly parentShapes: readonly ShapeHandle[];
  readonly childShapes: readonly ShapeHandle[];
  /** World-space tessellations of the same two sides, for the approximate fit when the kernel has no exact faces. */
  readonly parentMeshes: readonly MeshData[];
  readonly childMeshes: readonly MeshData[];
  readonly mmPerUnit: number;
}

/** Largest radial clearance (as a fraction of the pin radius) still counted as a fit; a 2 mm pin in a 40 mm bore is not a joint. */
const MAX_RELATIVE_CLEARANCE = 0.1;

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
  const exactParent = candidatesOf(kernel, input.parentShapes, input);
  const exactChild = candidatesOf(kernel, input.childShapes, input);
  const approximate = exactParent === null || exactChild === null;
  const meshed = approximate && (input.childMeshes.length > 0 || input.parentMeshes.length > 0);
  if (approximate && !meshed) return kernelUnsupportedItem(ids, 'joint realisation (exact cylinder faces)');
  const parent = exactParent ?? meshCandidates(input.parentMeshes, input.anchor, input.axis, input.mmPerUnit);
  const child = exactChild ?? meshCandidates(input.childMeshes, input.anchor, input.axis, input.mmPerUnit);
  const approximation = approximate
    ? {
        unverified: true,
        note: 'approximate: cylinders fitted to the tessellation (the kernel has no exact faces); radii are exact to the tessellation vertices, a same-radius pair of journals on one part reads as one',
      }
    : {};
  let best: { pin: Candidate; bore: Candidate; engagement: number } | null = null;
  const rejected = new Set<'disjoint' | 'interference' | 'loose'>();
  for (const [sideA, sideB] of [
    [parent, child],
    [child, parent],
  ] as const) {
    for (const pin of sideA.filter((face) => face.convex)) {
      for (const bore of sideB.filter((face) => !face.convex)) {
        const engagement = Math.min(pin.range[1], bore.range[1]) - Math.max(pin.range[0], bore.range[0]);
        if (engagement <= 0) rejected.add('disjoint');
        else if (bore.radius < pin.radius) rejected.add('interference');
        else if (bore.radius - pin.radius > MAX_RELATIVE_CLEARANCE * pin.radius) rejected.add('loose');
        else if (best === null || bore.radius - pin.radius < best.bore.radius - best.pin.radius) best = { pin, bore, engagement };
      }
    }
  }
  if (best === null) {
    const reason = rejected.has('interference')
      ? 'a pin is larger than its bore (interference; declared fits are V1)'
      : rejected.has('loose')
        ? `the bore is more than ${MAX_RELATIVE_CLEARANCE * 100} % of the pin radius larger than the pin`
        : rejected.has('disjoint')
          ? 'the pin and bore do not overlap along the joint axis'
          : 'no coaxial pin / bore cylinder pair found on the two sides of the joint';
    return makeItem(
      'FPR_JOINT_NOT_REALISED',
      'warn',
      ids,
      'Model the journal (pin) on one part and the bore on the other, coaxial with the joint axis, overlapping along it.',
      { ...approximation, note: approximate ? `${reason} (approximate: tessellation fit)` : reason },
    );
  }
  const { pin, bore, engagement } = best;
  return makeItem('FPR_JOINT_REALISED', 'pass', ids, 'Pin and bore found.', {
    ...approximation,
    values: {
      pinDiameterMm: 2 * pin.radius * input.mmPerUnit,
      boreDiameterMm: 2 * bore.radius * input.mmPerUnit,
      diametralClearanceMm: 2 * (bore.radius - pin.radius) * input.mmPerUnit,
      engagementMm: engagement * input.mmPerUnit,
    },
  });
}
