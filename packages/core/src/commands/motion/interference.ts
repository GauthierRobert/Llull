import type { CadDocument, Vec3 } from '../../model/types';
import { instanceBoundsFromDoc, type Bounds } from '../../geometry/bounds';
import { elementAt } from '../../lib/elementAt';

/** Overlap depth below this fraction of the larger box diagonal is contact, not interference (motion_study reporting). */
export const CONTACT_TOLERANCE = 1e-6;
/** Finer fraction used to locate the first contact when motion stops. */
export const STOP_TOLERANCE = 1e-9;

/** Instance transforms of one pose (as returned by evaluate_motion). */
export interface Pose {
  readonly instancePositions: Record<string, Vec3>;
  readonly instanceRotations: Record<string, Vec3>;
}

/** World AABB per instance id with each instance posed (position AND rotation) as at the step. @pure */
export function boundsAtStep(doc: CadDocument, step: Pose): Record<string, Bounds> {
  const result: Record<string, Bounds> = {};
  for (const id of Object.keys(doc.entities)) {
    const entity = doc.entities[id];
    if (!entity || entity.kind !== 'instance') continue;
    result[id] = instanceBoundsFromDoc(
      { ...entity, position: step.instancePositions[id] ?? entity.position, rotation: step.instanceRotations[id] ?? entity.rotation },
      doc,
    );
  }
  return result;
}

const diagonal = ({ min, max }: Bounds): number => Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);

/** The boxes overlap by more than `fraction` of the larger diagonal on every axis (touching faces do not count). */
export function interferes(a: Bounds, b: Bounds, fraction = CONTACT_TOLERANCE): boolean {
  const tolerance = fraction * Math.max(diagonal(a), diagonal(b));
  return [0, 1, 2].every((axis) => Math.min(a.max[axis] ?? 0, b.max[axis] ?? 0) - Math.max(a.min[axis] ?? 0, b.min[axis] ?? 0) > tolerance);
}

/** Every overlapping pair of instance AABBs. @pure */
export function detectInterferences(bounds: Record<string, Bounds>): [string, string][] {
  const entries = Object.entries(bounds);
  const pairs: [string, string][] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, boundsA] = elementAt(entries, i);
      const [idB, boundsB] = elementAt(entries, j);
      if (interferes(boundsA, boundsB)) pairs.push([idA, idB]);
    }
  }
  return pairs;
}

/**
 * Joint-value overrides for one sweep sample. mode 'joint': the target joint takes `value`. mode 'parameter': joints whose stored value
 * equals the parameter's current value follow the sweep, the rest keep their stored value.
 */
export function sweepOverrides(doc: CadDocument, mode: 'joint' | 'parameter', target: string, value: number): Record<string, number> {
  if (mode === 'joint') return { [target]: value };
  const current = doc.parameters[target]?.value ?? 0;
  const overrides: Record<string, number> = {};
  for (const [jid, joint] of Object.entries(doc.joints)) {
    const raw = joint.kind === 'revolute' ? joint.angle : joint.kind === 'prismatic' ? joint.displacement : (joint.values[0] ?? 0);
    const stored = typeof raw === 'number' ? raw : 0;
    overrides[jid] = current !== 0 && stored === current ? value : stored;
  }
  return overrides;
}
