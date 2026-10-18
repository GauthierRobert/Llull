/** check_mechanism: read-only Grubler-Kutzbach degrees-of-freedom count of the kinematic joints and the rigid-body dynamics model. */

import type { CadDocument } from '../../model/types';
import { GROUND } from '../../model/dynamics';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { type ReviewItem, reviewItem, reviewResult, reviewSummary } from './reviewEnvelope';

/** Freedoms a joint removes between two rigid bodies (6 minus the joint's own freedoms). */
const REMOVED_BY_DYNAMIC_JOINT = { revolute: 5, prismatic: 5, spherical: 3 } as const;
const REMOVED_BY_KINEMATIC_JOINT = 5;

interface Count {
  readonly source: 'joints' | 'dynamics';
  readonly jointIds: readonly string[];
  readonly bodies: number;
  readonly drives: number;
  readonly mobility: number;
}

/** doc.joints: instances are bodies; per connected group one instance is the ground; each drive relation removes one freedom. */
function kinematicCount(doc: CadDocument): Count | null {
  const joints = doc.jointOrder.flatMap((id) => (doc.joints[id] === undefined ? [] : [doc.joints[id]]));
  if (joints.length === 0) return null;
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const up = parent.get(id) ?? id;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  for (const joint of joints) {
    for (const id of [joint.a.instanceId, joint.b.instanceId]) if (!parent.has(id)) parent.set(id, id);
    parent.set(find(joint.a.instanceId), find(joint.b.instanceId));
  }
  const bodies = new Set(joints.flatMap((joint) => [joint.a.instanceId, joint.b.instanceId]));
  const groups = new Set([...bodies].map(find));
  const relations = doc.driveRelationOrder.filter((id) => {
    const relation = doc.driveRelations[id];
    return relation !== undefined && doc.joints[relation.driver] !== undefined && doc.joints[relation.driven] !== undefined;
  }).length;
  return {
    source: 'joints',
    jointIds: joints.map((joint) => joint.id),
    bodies: bodies.size,
    drives: relations,
    mobility: 6 * (bodies.size - groups.size) - REMOVED_BY_KINEMATIC_JOINT * joints.length - relations,
  };
}

/** doc.dynamics: fixed bodies and GROUND are the ground; each gear coupling removes one freedom; motors are the drives. */
function dynamicsCount(doc: CadDocument): Count | null {
  const dynamics = doc.dynamics;
  if (dynamics === undefined) return null;
  const joints = Object.values(dynamics.joints);
  if (joints.length === 0) return null;
  const isMovable = (bodyId: string): boolean => bodyId !== GROUND && dynamics.bodies[bodyId]?.fixed === false;
  const movable = Object.values(dynamics.bodies).filter((body) => !body.fixed).length;
  const removed = joints
    .filter((joint) => isMovable(joint.child) || isMovable(joint.parent))
    .reduce((sum, joint) => sum + REMOVED_BY_DYNAMIC_JOINT[joint.kind], 0);
  const gears = Object.values(dynamics.gears).filter(
    (gear) => dynamics.joints[gear.driver] !== undefined && dynamics.joints[gear.driven] !== undefined,
  ).length;
  return {
    source: 'dynamics',
    jointIds: joints.map((joint) => joint.id),
    bodies: Object.keys(dynamics.bodies).length,
    drives: Object.values(dynamics.motors).filter((motor) => dynamics.joints[motor.joint] !== undefined).length,
    mobility: 6 * movable - removed - gears,
  };
}

function itemsFor(count: Count): ReviewItem[] {
  const { source, jointIds, bodies, drives, mobility } = count;
  const values = { mobility, bodies, joints: jointIds.length, drives };
  const note =
    `${source === 'joints' ? 'kinematic joints (doc.joints)' : 'rigid-body dynamics (doc.dynamics)'}: Grubler-Kutzbach count ` +
    '6(bodies-1) - sum of removed freedoms; redundant constraints make the real mobility higher than this count';
  const base = { values, note, unverified: true } as const;
  if (mobility <= 0)
    return [
      reviewItem(
        'mechanism',
        'FPR_MECH_LOCKED',
        'fail',
        jointIds,
        'The joints leave no freedom to move: remove a joint, replace a redundant one, or check for a closed loop that is over-constrained.',
        base,
      ),
    ];
  if (mobility > drives)
    return [
      reviewItem(
        'mechanism',
        'FPR_MECH_UNDERCONSTRAINED',
        'warn',
        jointIds,
        `${mobility} freedom(s) but ${drives} drive(s): add motors / drive relations, or constrain the remaining freedoms, so the motion is fully determined.`,
        base,
      ),
    ];
  return [reviewItem('mechanism', 'FPR_MECH_OK', 'pass', jointIds, 'Every freedom of the mechanism is driven.', base)];
}

/**
 * @affects nothing — read-only; returns the CheckResult envelope (check 'mechanism') in data
 * @invariant returns the SAME document, affected []; deterministic; mobility is the Grubler-Kutzbach count, not a proof
 * @failure no doc.joints and no dynamics joints -> status not_run with FPR_MECH_NONE (never a pass)
 */
export const checkMechanism = defineCommand({
  name: 'check_mechanism',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Degrees of freedom (mobility) of the mechanism, from the kinematic joints (add_joint, doc.joints; instances are the bodies, one per ' +
    'connected group is the ground) and from the rigid-body dynamics model when it has joints (fixed bodies are the ground; revolute and ' +
    'prismatic joints remove 5 freedoms, spherical 3; gear couplings and drive relations remove 1 each). It is a Grubler-Kutzbach ' +
    'count: redundant constraints make the real mobility higher than the count, so a result is conservative, not a proof. ' +
    'Items: FPR_MECH_LOCKED (fail, mobility <= 0: nothing can move), FPR_MECH_UNDERCONSTRAINED (warn, mobility greater than the number ' +
    'of drives = motors or drive relations: parts move freely), FPR_MECH_OK (pass), with values { mobility, bodies, joints, drives }. ' +
    'No joints at all gives status not_run with FPR_MECH_NONE. status is the worst item (fail > not_run > warn > pass). Read-only. ' +
    'Next: add_joint / add_drive_relation / add_motor to fix the findings, then check_motion_clearance. Computed by llull, not approved: ' +
    'a qualified engineer must review.',
  params: z.object({}),
  run: (doc, params): CommandResult => {
    const counts = [kinematicCount(doc), dynamicsCount(doc)].flatMap((count) => (count === null ? [] : [count]));
    const items: ReviewItem[] =
      counts.length === 0
        ? [
            reviewItem(
              'mechanism',
              'FPR_MECH_NONE',
              'not_run',
              [],
              'Add joints between component instances (add_joint) or rigid-body joints (dynamics) to define a mechanism.',
              { unverified: true, note: 'no kinematic joints and no dynamics joints: there is no mechanism to count' },
            ),
          ]
        : counts.flatMap(itemsFor);
    const result = reviewResult(
      'mechanism',
      items,
      { method: 'Grubler-Kutzbach mobility count', tolerances: {}, params },
      { joints: doc.joints, jointOrder: doc.jointOrder, driveRelations: doc.driveRelations, dynamics: doc.dynamics ?? null },
    );
    const mobilities = counts.map((count) => `${count.source} mobility ${count.mobility}`).join(', ');
    return report(
      doc,
      reviewSummary(
        'check_mechanism',
        result,
        counts.length === 0 ? 'No mechanism defined.' : `${mobilities}.` + ' Next: check_motion_clearance.',
      ),
      result,
    );
  },
});
