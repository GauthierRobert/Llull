import type { CadDocument, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { boundsOverlap, instanceBoundsFromDoc } from './sceneBounds';
import type { Bounds } from './sceneTypes';
import { evaluateMotionInternal } from './jointsKinematics';
import { noop } from './noop';
import { elementAt } from '../lib/elementAt';

/** One sweep sample: the applied value, resolved joint values and instance transforms by id. */
interface MotionStep {
  stepIndex: number;
  sweepValue: number;
  instancePositions: Record<string, Vec3>;
  instanceRotations: Record<string, Vec3>;
  resolvedJoints: Record<string, number>;
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
  summary: {
    totalSteps: number;
    framesWithInterference: number;
  };
}

/** World AABB per instance id with each instance moved to its position at the step. @pure */
function boundsAtStep(
  doc: CadDocument,
  instancePositions: Record<string, Vec3>,
): Record<string, Bounds> {
  const result: Record<string, Bounds> = {};
  for (const id of Object.keys(doc.entities)) {
    const entity = doc.entities[id];
    if (!entity || entity.kind !== 'instance') continue;
    const resolvedPos = instancePositions[id] ?? entity.position;
    result[id] = instanceBoundsFromDoc({ ...entity, position: resolvedPos }, doc);
  }
  return result;
}

/** Every overlapping pair of instance AABBs. @pure */
function detectInterferences(bounds: Record<string, Bounds>): [string, string][] {
  const entries = Object.entries(bounds);
  const pairs: [string, string][] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, boundsA] = elementAt(entries, i);
      const [idB, boundsB] = elementAt(entries, j);
      if (boundsOverlap(boundsA, boundsB)) {
        pairs.push([idA, idB]);
      }
    }
  }
  return pairs;
}

/**
 * @command motion_study
 * @pure
 * @layer core/commands
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
    '"target" is the joint id or parameter name to sweep. ' +
    '"start" and "end" define the sweep range (inclusive). ' +
    '"steps" is the number of samples (default 24; clamped to [2, 360]; non-integers rounded). ' +
    '"interferenceCheck" (default false): when true, runs a lightweight AABB overlap test on every instance pair at each step. ' +
    'Returns the input document unchanged (affected:[]) with data: ' +
    '{ steps: MotionStep[], interferences: InterferencePair[], ' +
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
  }),
  run: (doc, { mode, target, start, end, steps, interferenceCheck }): CommandResult => {
    if (target.length === 0) {
      return noop(doc, 'motion_study: "target" must be a non-empty string.');
    }

    const emptyStudy = {
      steps: [],
      interferences: [],
      summary: { totalSteps: 0, framesWithInterference: 0 },
    } satisfies MotionStudyData;

    if (start === end) {
      return {
        document: doc,
        summary: `motion_study: start === end (${start}). Sweep has zero length — no steps to evaluate.`,
        affected: [],
        data: emptyStudy,
      };
    }

    const rawSteps = steps ?? 24;
    if (rawSteps < 2) {
      return {
        document: doc,
        summary: `motion_study: steps must be at least 2 (got ${String(steps)}). No sweep performed.`,
        affected: [],
        data: emptyStudy,
      };
    }
    const clampedSteps = Math.min(360, rawSteps);

    if (mode === 'joint') {
      if (!(target in doc.joints)) {
        return noop(doc, `motion_study: joint '${target}' does not exist in doc.joints.`);
      }
    } else {
      // mode === 'parameter'
      const param = Object.hasOwn(doc.parameters, target) ? doc.parameters[target] : undefined;
      if (!param) {
        return noop(doc, `motion_study: parameter '${target}' does not exist in doc.parameters.`);
      }
      if (typeof param.value !== 'number' || !Number.isFinite(param.value)) {
        return noop(
          doc,
          `motion_study: parameter '${target}' is not numeric (value: ${String(param.value)}).`,
        );
      }
    }

    const motionSteps: MotionStep[] = [];
    const allInterferences: InterferencePair[] = [];
    const stepsWithInterference = new Set<number>();

    for (let k = 0; k < clampedSteps; k++) {
      const sweepValue = start + ((end - start) * k) / (clampedSteps - 1);

      let baseValues: Record<string, number>;

      if (mode === 'joint') {
        baseValues = { [target]: sweepValue };
      } else {
        // Joints whose stored value equals the parameter's current value follow the sweep;
        // the rest keep their stored value (drive relations propagate in evaluateMotionInternal).
        const currentParamValue = doc.parameters[target]?.value ?? 0;
        baseValues = {};
        for (const [jid, joint] of Object.entries(doc.joints)) {
          const rawValue = joint.kind === 'revolute' ? joint.angle : joint.displacement;
          const stored = typeof rawValue === 'number' ? rawValue : 0;
          baseValues[jid] =
            currentParamValue !== 0 && stored === currentParamValue ? sweepValue : stored;
        }
      }

      const { instancePositions, instanceRotations, resolvedJoints } = evaluateMotionInternal(
        doc,
        baseValues,
      );

      motionSteps.push({
        stepIndex: k,
        sweepValue,
        instancePositions,
        instanceRotations,
        resolvedJoints,
      });

      if (interferenceCheck === true) {
        const bounds = boundsAtStep(doc, instancePositions);
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

    return {
      document: doc,
      summary: summaryText,
      affected: [],
      data: {
        steps: motionSteps,
        interferences: allInterferences,
        summary: { totalSteps: clampedSteps, framesWithInterference },
      } satisfies MotionStudyData,
    };
  },
});
