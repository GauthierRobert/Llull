import type { Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { evaluateMotionInternal } from './jointsKinematics';
import { findContactStop, type ContactStop } from './contactStop';
import { boundsAtStep, detectInterferences, sweepOverrides } from './interference';
import { noop, report } from '../noop';

/** One sweep sample: the applied value, resolved joint values and instance transforms by id. */
interface MotionStep {
  stepIndex: number;
  sweepValue: number;
  instancePositions: Record<string, Vec3>;
  instanceRotations: Record<string, Vec3>;
  resolvedJoints: Record<string, number>;
  /** Present when the joints form a closed loop: whether it closes at this sample. */
  loopClosed?: boolean;
}

/** A pair of instance ids that overlap (AABB interference) at a given step. */
interface InterferencePair {
  stepIndex: number;
  instanceIdA: string;
  instanceIdB: string;
}

export interface MotionStudyData {
  steps: MotionStep[];
  interferences: InterferencePair[];
  summary: { totalSteps: number; framesWithInterference: number };
  /** Present when a contact set was given. */
  contact?: ContactStop;
}

/**
 * @affects nothing — read-only query; document returned unchanged, affected:[]
 * @invariant steps clamped to [2, 360]; non-integers rounded
 * @invariant each sweep step evaluates a virtual clone; the input doc is never mutated
 * @failure unknown jointId (mode='joint') → no-op, affected:[]
 * @failure unknown parameter (mode='parameter') or non-numeric parameter → no-op, affected:[]
 * @failure start === end → friendly summary, empty steps
 * @failure steps < 2 after rounding/clamping → graceful no-op
 */
export const motionStudy = defineCommand({
  name: 'motion_study',
  annotations: { readOnly: true, metaHistory: true },
  description:
    'Evaluate the mechanism across a value sweep and return per-step instance transforms plus interference flags. ' +
    'mode="joint": sweep a single joint (by jointId) through a value range (radians for revolute, units for prismatic). ' +
    'mode="parameter": sweep a named doc.parameters entry through a value range, propagating to any joints that reference it. ' +
    '"target" is the joint id or parameter name to sweep. "start" and "end" define the sweep range (inclusive). ' +
    '"steps" is the number of samples (default 24; clamped to [2, 360]; non-integers rounded). ' +
    '"interferenceCheck" (default false): when true, runs a lightweight overlap test (axis-aligned box of each instance in its rotated pose; faces that merely touch are not interference) on every instance pair at each step. ' +
    'Returns the input document unchanged (affected:[]) with data: { steps: MotionStep[], interferences: InterferencePair[], ' +
    '  summary: { totalSteps: number, framesWithInterference: number } }. ' +
    'Failure cases (unknown target, start===end, steps<2) return an explanatory summary with empty data.',
  params: z.object({
    mode: z
      .enum(['joint', 'parameter'])
      .describe(
        'Sweep mode. "joint": vary a specific joint value directly. ' +
          '"parameter": vary a named doc.parameters entry; downstream joints that reference it are re-evaluated.',
      ),
    target: z
      .string()
      .describe(
        'What to sweep. For mode="joint": the joint id (must exist in doc.joints). ' +
          'For mode="parameter": the parameter name (must exist in doc.parameters and resolve to a number).',
      ),
    start: z
      .number()
      .describe(
        'Start value of the sweep range (inclusive). ' +
          "For revolute joints: radians. For prismatic joints: document units. For parameters: the parameter's unit.",
      ),
    end: z
      .number()
      .describe(
        'End value of the sweep range (inclusive). ' +
          "For revolute joints: radians. For prismatic joints: document units. For parameters: the parameter's unit.",
      ),
    steps: z
      .number()
      .int()
      .optional()
      .describe(
        'Number of samples across the range (default 24, minimum 2, maximum 360). ' +
          'Must be an integer. Step k = start + (end - start) * k / (steps - 1).',
      ),
    interferenceCheck: z
      .boolean()
      .optional()
      .describe(
        'When true, run a lightweight AABB overlap pass on every pair of InstanceEntity objects at each step. ' +
          'Colliding pairs are recorded in the returned interferences array. Default: false.',
      ),
    contactSetId: z
      .string()
      .optional()
      .describe(
        'Id of a contact set (create_contact_set). The sweep ends at the first value where a pair of the set touches (bisected to 1e-9 of the range) ' +
          'or an unsolved loop stops closing; data.contact reports { stopped, stopValue, reason, pair }.',
      ),
  }),
  run: (doc, { mode, target, start, end, steps, interferenceCheck, contactSetId }): CommandResult => {
    if (target.length === 0) return noop(doc, 'motion_study: "target" must be a non-empty string.');
    const emptyStudy = { steps: [], interferences: [], summary: { totalSteps: 0, framesWithInterference: 0 } } satisfies MotionStudyData;
    if (start === end)
      return report(doc, `motion_study: start === end (${start}). Sweep has zero length — no steps to evaluate.`, emptyStudy);
    const rawSteps = steps ?? 24;
    if (rawSteps < 2) return report(doc, `motion_study: steps must be at least 2 (got ${String(steps)}). No sweep performed.`, emptyStudy);
    const clampedSteps = Math.min(360, rawSteps);
    if (mode === 'joint') {
      if (!(target in doc.joints)) return noop(doc, `motion_study: joint '${target}' does not exist in doc.joints.`);
    } else {
      // mode === 'parameter'
      const param = Object.hasOwn(doc.parameters, target) ? doc.parameters[target] : undefined;
      if (!param) return noop(doc, `motion_study: parameter '${target}' does not exist in doc.parameters.`);
      if (typeof param.value !== 'number' || !Number.isFinite(param.value))
        return noop(doc, `motion_study: parameter '${target}' is not numeric (value: ${String(param.value)}).`);
    }
    const contactSet = contactSetId === undefined ? undefined : doc.contactSets?.[contactSetId];
    if (contactSetId !== undefined && contactSet === undefined)
      return noop(doc, `motion_study: contact set '${contactSetId}' does not exist (create_contact_set).`);
    const stop =
      contactSet === undefined
        ? undefined
        : findContactStop(doc, { mode, target, from: start, to: end }, contactSet.pairs, 400, 1e-9 * Math.abs(end - start));
    const last = stop?.stopped === true ? stop.stopValue : end;
    const motionSteps: MotionStep[] = [];
    const allInterferences: InterferencePair[] = [];
    const stepsWithInterference = new Set<number>();
    let guess: Record<string, readonly number[]> = {};
    for (let k = 0; k < clampedSteps; k++) {
      const sweepValue = start + ((last - start) * k) / (clampedSteps - 1);
      const evaluated = evaluateMotionInternal(doc, sweepOverrides(doc, mode, target, sweepValue), guess);
      const { instancePositions, instanceRotations, resolvedJoints } = evaluated;
      if (evaluated.loop !== undefined && evaluated.loop.closed) guess = evaluated.loop.passive;
      motionSteps.push({
        stepIndex: k,
        sweepValue,
        instancePositions,
        instanceRotations,
        resolvedJoints,
        ...(evaluated.loop === undefined ? {} : { loopClosed: evaluated.loop.closed }),
      });
      if (interferenceCheck === true) {
        const bounds = boundsAtStep(doc, { instancePositions, instanceRotations });
        const pairs = detectInterferences(bounds);
        for (const [idA, idB] of pairs) {
          allInterferences.push({ stepIndex: k, instanceIdA: idA, instanceIdB: idB });
          stepsWithInterference.add(k);
        }
      }
    }
    const framesWithInterference = stepsWithInterference.size;
    const summaryText =
      `motion_study: swept ${mode}='${target}' from ${start} to ${end} in ${clampedSteps} step(s). ` +
      (interferenceCheck === true
        ? `${allInterferences.length} interference pair(s) across ${framesWithInterference} frame(s).`
        : 'Interference check disabled.');
    const contactNote =
      stop === undefined
        ? ''
        : stop.stopped
          ? ` Motion stops at ${stop.stopValue} (${stop.reason === 'loop_open' ? 'the loop cannot close beyond it' : `first contact ${stop.pair?.join(' / ')}`}).`
          : ' No contact in the range.';
    return report(doc, summaryText + contactNote, {
      steps: motionSteps,
      interferences: allInterferences,
      summary: { totalSteps: clampedSteps, framesWithInterference },
      ...(stop === undefined ? {} : { contact: stop }),
    } satisfies MotionStudyData);
  },
});
