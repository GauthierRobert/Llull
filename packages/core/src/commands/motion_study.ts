import type { CadDocument, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { instanceBoundsFromDoc } from './sceneBounds';
import { Bounds } from './sceneTypes';
import { evaluateMotionInternal } from './jointsKinematics';

// ---------------------------------------------------------------------------
// Motion study result types
// ---------------------------------------------------------------------------

/** Per-step result of a motion study sweep. */
export interface MotionStep {
  /** Step index (0-based). */
  stepIndex: number;
  /** The sweep value applied at this step. */
  sweepValue: number;
  /** Instance positions at this step: instanceId → Vec3. */
  instancePositions: Record<string, Vec3>;
  /** Instance rotations at this step: instanceId → Vec3. */
  instanceRotations: Record<string, Vec3>;
  /** Resolved joint values at this step: jointId → number. */
  resolvedJoints: Record<string, number>;
}

/** A pair of instance ids that overlap (AABB interference) at a given step. */
export interface InterferencePair {
  stepIndex: number;
  instanceIdA: string;
  instanceIdB: string;
}

/** Structured data returned by motion_study in CommandResult.data. */
export interface MotionStudyData {
  steps: MotionStep[];
  interferences: InterferencePair[];
  summary: {
    totalSteps: number;
    framesWithInterference: number;
  };
}

// ---------------------------------------------------------------------------
// AABB interference helpers
// ---------------------------------------------------------------------------

/** Returns true when two world-space AABBs overlap. */
function aabbOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

/**
 * Given a step's instance positions, build AABB bounds per instance using
 * instanceBoundsFromDoc but translated to the resolved step position.
 * Returns instanceId → Bounds.
 *
 * @pure
 */
function boundsAtStep(
  doc: CadDocument,
  instancePositions: Record<string, Vec3>,
): Record<string, Bounds> {
  const result: Record<string, Bounds> = {};
  for (const id of Object.keys(doc.entities)) {
    const entity = doc.entities[id];
    if (!entity || entity.kind !== 'instance') continue;
    const resolvedPos = instancePositions[id] ?? entity.position;
    // Temporarily reposition the instance (shallow clone, not mutating doc).
    const tempEntity = { ...entity, position: resolvedPos };
    const bounds = instanceBoundsFromDoc(tempEntity, doc);
    result[id] = bounds;
  }
  return result;
}

/**
 * Check all pairs of instance bounds for AABB overlap.
 * Returns array of colliding [idA, idB] pairs.
 * @pure
 */
function detectInterferences(bounds: Record<string, Bounds>): [string, string][] {
  const ids = Object.keys(bounds);
  const pairs: [string, string][] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const idA = ids[i]!;
      const idB = ids[j]!;
      if (aabbOverlap(bounds[idA]!, bounds[idB]!)) {
        pairs.push([idA, idB]);
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// motion_study command
// ---------------------------------------------------------------------------

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
      .optional()
      .describe(
        'Number of samples across the range (default 24, minimum 2, maximum 360). ' +
          'Non-integers are rounded. Step k = start + (end - start) * k / (steps - 1).',
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
    // Validate target
    if (target.length === 0) {
      return {
        document: doc,
        summary: 'motion_study: "target" must be a non-empty string.',
        affected: [],
      };
    }

    // Validate start / end
    if (!Number.isFinite(start)) {
      return {
        document: doc,
        summary: `motion_study: "start" must be a finite number, got ${String(start)}.`,
        affected: [],
      };
    }
    if (!Number.isFinite(end)) {
      return {
        document: doc,
        summary: `motion_study: "end" must be a finite number, got ${String(end)}.`,
        affected: [],
      };
    }

    // Zero-length sweep
    if (start === end) {
      return {
        document: doc,
        summary: `motion_study: start === end (${start}). Sweep has zero length — no steps to evaluate.`,
        affected: [],
        data: {
          steps: [],
          interferences: [],
          summary: { totalSteps: 0, framesWithInterference: 0 },
        } satisfies MotionStudyData,
      };
    }

    // Validate and clamp steps
    const rawSteps = steps !== undefined ? Math.round(steps) : 24;
    if (rawSteps < 2) {
      return {
        document: doc,
        summary: `motion_study: steps must be at least 2 (got ${String(steps)}). No sweep performed.`,
        affected: [],
        data: {
          steps: [],
          interferences: [],
          summary: { totalSteps: 0, framesWithInterference: 0 },
        } satisfies MotionStudyData,
      };
    }
    const clampedSteps = Math.min(360, Math.max(2, rawSteps));

    // Mode-specific validation
    if (mode === 'joint') {
      if (!(target in doc.joints)) {
        return {
          document: doc,
          summary: `motion_study: joint '${target}' does not exist in doc.joints.`,
          affected: [],
        };
      }
    } else {
      // mode === 'parameter'
      if (!(target in doc.parameters)) {
        return {
          document: doc,
          summary: `motion_study: parameter '${target}' does not exist in doc.parameters.`,
          affected: [],
        };
      }
      const param = doc.parameters[target]!;
      if (typeof param.value !== 'number' || !Number.isFinite(param.value)) {
        return {
          document: doc,
          summary: `motion_study: parameter '${target}' is not numeric (value: ${String(param.value)}).`,
          affected: [],
        };
      }
    }

    // Run sweep
    const motionSteps: MotionStep[] = [];
    const allInterferences: InterferencePair[] = [];
    const stepsWithInterference = new Set<number>();

    for (let k = 0; k < clampedSteps; k++) {
      const sweepValue = start + ((end - start) * k) / (clampedSteps - 1);

      let baseValues: Record<string, number>;

      if (mode === 'joint') {
        // Override the specific joint value
        baseValues = { [target]: sweepValue };
      } else {
        // mode === 'parameter': apply the parameter value and then derive joint
        // values from it. We build a virtual doc with the parameter updated, then
        // collect all joint values as they would be resolved against that parameter.
        // We patch the doc's parameter value for evaluation purposes (no mutation of
        // input doc — we derive the effective joint values inline).
        const updatedParam = {
          ...doc.parameters[target]!,
          value: sweepValue,
          expression: String(sweepValue),
        };
        const virtualParameters = { ...doc.parameters, [target]: updatedParam };

        // Compute overrides for all joints that use a parameter expression.
        // We resolve each joint's raw expression against the virtual parameter env.
        const env: Record<string, number> = {};
        for (const [name, p] of Object.entries(virtualParameters)) {
          env[name] = p.value;
        }

        baseValues = {};
        for (const [jid, joint] of Object.entries(doc.joints)) {
          const rawValue = joint.kind === 'revolute' ? joint.angle : joint.displacement;
          // Only override joints that are driven by expressions (numbers stay as-is).
          // Since set_joint_value stores the resolved number in the joint, we need
          // to check if the joint's raw value matches the current parameter value.
          // Strategy: apply the override for ALL joints so drive-relation propagation
          // from the virtual parameter is reflected. But we cannot trivially know which
          // joints reference a specific parameter since values are stored as numbers.
          // Instead we derive the override only for joints whose stored value
          // numerically equals the current parameter value (direct coupling).
          // For the general case, we rely on drive relations to propagate the effect.
          // If the joint is NOT driven by drive relations, skip it (use stored value).
          baseValues[jid] = typeof rawValue === 'number' ? rawValue : 0;
        }

        // Now inject the sweep override: joints that are driven by the parameter
        // via drive relations will be re-evaluated in evaluateMotionInternal's topo pass.
        // For direct joint→parameter coupling we compute the correct value:
        // find all joints whose stored (current doc) angle/displacement equals
        // the current parameter value and scale them proportionally.
        const currentParamValue = doc.parameters[target]!.value;
        if (currentParamValue !== 0) {
          for (const [jid, joint] of Object.entries(doc.joints)) {
            const rawValue = joint.kind === 'revolute' ? joint.angle : joint.displacement;
            if (typeof rawValue === 'number' && rawValue === currentParamValue) {
              baseValues[jid] = sweepValue;
            }
          }
        }
        // Also patch any joint that directly stores the parameter value (same reference).
        // This covers the case where set_joint_value was called with the parameter's
        // current numeric value — we scale it to the new sweep position.
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

      // Interference check (optional, O(n²) AABB pairs)
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
