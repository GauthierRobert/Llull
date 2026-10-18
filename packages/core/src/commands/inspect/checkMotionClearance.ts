/** check_motion_clearance: read-only sweep of each revolute joint through a full turn, reporting instance pairs whose boxes overlap. */

import type { CadDocument, Joint, Vec3 } from '../../model/types';
import { MM_PER_UNIT } from '../../model/units';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { execute } from '../execute';
import type { MotionStudyData } from '../motion/motionStudy';
import { type ReviewItem, reviewItem, reviewResult, reviewSummary } from './reviewEnvelope';

const DEFAULT_STEPS = 36;
const AABB_NOTE = 'motion_study tests axis-aligned boxes of each instance in its rotated pose: an approximation that can over-report';

interface PairFinding {
  readonly pair: readonly [string, string];
  readonly jointId: string;
  readonly frames: number;
  readonly firstAtDeg: number;
  readonly pointsMm: readonly [Vec3, Vec3];
}

function isStudy(data: unknown): data is MotionStudyData {
  return typeof data === 'object' && data !== null && 'steps' in data && 'interferences' in data;
}

/** One sweep 0..2pi of `joint`; one finding per interfering pair. */
function sweepRevolute(doc: CadDocument, joint: Joint, steps: number, ctx: Parameters<typeof execute>[3]): PairFinding[] | null {
  const run = execute(
    doc,
    'motion_study',
    { mode: 'joint', target: joint.id, start: 0, end: 2 * Math.PI, steps, interferenceCheck: true },
    ctx,
  );
  if (!isStudy(run.data)) return null;
  const study = run.data;
  const mmPerUnit = MM_PER_UNIT[doc.units];
  const pairs = new Map<string, MotionStudyData['interferences']>();
  for (const hit of study.interferences) {
    const key = [hit.instanceIdA, hit.instanceIdB].sort().join(',');
    pairs.set(key, [...(pairs.get(key) ?? []), hit]);
  }
  return [...pairs.values()].flatMap((hits) => {
    const first = hits[0];
    const step = first === undefined ? undefined : study.steps[first.stepIndex];
    if (first === undefined || step === undefined) return [];
    const point = (id: string): Vec3 => {
      const position = step.instancePositions[id] ?? doc.entities[id]?.position ?? [0, 0, 0];
      return [position[0] * mmPerUnit, position[1] * mmPerUnit, position[2] * mmPerUnit];
    };
    const pair = [first.instanceIdA, first.instanceIdB].sort() as unknown as readonly [string, string];
    return [
      {
        pair,
        jointId: joint.id,
        frames: hits.length,
        firstAtDeg: (step.sweepValue * 180) / Math.PI,
        pointsMm: [point(pair[0]), point(pair[1])],
      },
    ];
  });
}

/**
 * @affects nothing — read-only; returns the CheckResult envelope (check 'motion_clearance') in data
 * @invariant returns the SAME document, affected []; composes the read-only motion_study; one finding per instance pair (first joint wins)
 * @failure no joints -> status not_run FPR_MOTION_NONE; prismatic joint (no limits in the model) -> not_run FPR_MOTION_NO_LIMITS for it
 */
export const checkMotionClearance = defineCommand({
  name: 'check_motion_clearance',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Clearance in motion: sweeps every revolute kinematic joint (add_joint) through a full turn 0..360 degrees in `steps` samples with ' +
    'motion_study and reports each pair of component instances whose boxes overlap in some frame. The overlap test is an axis-aligned ' +
    'box approximation of each instance in its rotated pose (faces that merely touch do not count), so findings are warn, never fail, and ' +
    'can over-report; confirm with check_assembly at the flagged pose (set_joint_value). Prismatic joints have no travel limits in the ' +
    'model and are skipped with a not_run item FPR_MOTION_NO_LIMITS. Items: FPR_MOTION_INTERFERENCE (warn, ids = the two instances, ' +
    'values { framesWithInterference, firstAtDeg }, witness { pointsMm, crankDeg }), FPR_MOTION_CLEAR (pass, values { stepsChecked }), ' +
    'FPR_MOTION_NONE (not_run, no joints). status is the worst item (fail > not_run > warn > pass). Read-only. Computed by llull, not ' +
    'approved: a qualified engineer must review.',
  params: z.object({
    steps: z
      .number()
      .int()
      .min(2)
      .max(360)
      .optional()
      .describe('Samples per joint over the full turn, an integer from 2 to 360. Default 36 (about 10 degrees apart).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const steps = params.steps ?? DEFAULT_STEPS;
    const joints = doc.jointOrder.flatMap((id) => (doc.joints[id] === undefined ? [] : [doc.joints[id]]));
    const items: ReviewItem[] = [];
    if (joints.length === 0)
      items.push(
        reviewItem(
          'motion_clearance',
          'FPR_MOTION_NONE',
          'not_run',
          [],
          'Add a joint between component instances (add_joint) to define motion.',
          { unverified: true, note: 'doc.joints is empty: there is no motion to sweep' },
        ),
      );
    const findings = new Map<string, PairFinding>();
    const swept: string[] = [];
    for (const joint of joints) {
      if (joint.kind !== 'revolute') {
        items.push(
          reviewItem(
            'motion_clearance',
            'FPR_MOTION_NO_LIMITS',
            'not_run',
            [joint.id],
            'Prismatic joints carry no travel limits: sweep it yourself with motion_study (mode joint, start, end, interferenceCheck).',
            { unverified: true, note: 'prismatic joint skipped' },
          ),
        );
        continue;
      }
      const found = sweepRevolute(doc, joint, steps, ctx);
      if (found === null) continue;
      swept.push(joint.id);
      for (const finding of found) if (!findings.has(finding.pair.join(','))) findings.set(finding.pair.join(','), finding);
    }
    for (const finding of findings.values())
      items.push(
        reviewItem(
          'motion_clearance',
          'FPR_MOTION_INTERFERENCE',
          'warn',
          finding.pair,
          'Move the parts apart, shorten the swing, or confirm with check_assembly at the flagged angle (set_joint_value) that the overlap is real.',
          {
            values: { framesWithInterference: finding.frames, firstAtDeg: finding.firstAtDeg },
            witness: { pointsMm: finding.pointsMm, crankDeg: finding.firstAtDeg },
            unverified: true,
            note: `${AABB_NOTE}; swept joint ${finding.jointId}`,
          },
        ),
      );
    if (swept.length > 0 && findings.size === 0)
      items.push(
        reviewItem('motion_clearance', 'FPR_MOTION_CLEAR', 'pass', swept, 'No instance boxes overlap during the sweep.', {
          values: { stepsChecked: steps, jointsSwept: swept.length },
          unverified: true,
          note: AABB_NOTE,
        }),
      );
    const result = reviewResult(
      'motion_clearance',
      items,
      {
        method: 'motion_study sweep 0..2pi per revolute joint with AABB overlap per instance pair',
        tolerances: { contactToleranceRelative: 1e-6 },
        params,
      },
      { joints: doc.joints, jointOrder: doc.jointOrder, driveRelations: doc.driveRelations, entities: doc.entities, steps },
    );
    return report(
      doc,
      reviewSummary(
        'check_motion_clearance',
        result,
        `${swept.length} revolute joint(s) swept in ${steps} steps, ${findings.size} interfering pair(s) (box approximation).`,
      ),
      result,
    );
  },
});
