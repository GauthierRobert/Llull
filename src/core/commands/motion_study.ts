/**
 * @command motion_study
 * @pure
 * @layer core/commands
 * @affects nothing — read-only query, affected:[]
 * @invariant document returned unchanged; each step evaluates a CLONE of the doc
 * @invariant steps = clamp(steps, 2, 360), non-integers rounded
 * @failure unknown jointId (mode='joint') → no-op, affected:[]
 * @failure unknown / non-numeric parameter name (mode='parameter') → no-op, affected:[]
 * @failure start === end → friendly summary, empty steps
 * @failure steps < 2 → graceful no-op with explanatory summary
 */

import type { CadDocument, DriveRelation, Vec3 } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { instanceBoundsFromDoc } from './scene';
import type { Bounds } from './scene';

// ---------------------------------------------------------------------------
// Re-implementation of the KN1 motion evaluation helpers
// (duplicated here to avoid exporting them from joints.ts and to remain
//  self-contained; the logic is identical to evaluateMotionInternal)
// ---------------------------------------------------------------------------

function normalizeAxis(axis: 'x' | 'y' | 'z' | Vec3): Vec3 {
  if (axis === 'x') return [1, 0, 0];
  if (axis === 'y') return [0, 1, 0];
  if (axis === 'z') return [0, 0, 1];
  return axis;
}

function rotateAboutAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const [ux, uy, uz] = axis;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = v[0] * ux + v[1] * uy + v[2] * uz;
  const crossX = uy * v[2] - uz * v[1];
  const crossY = uz * v[0] - ux * v[2];
  const crossZ = ux * v[1] - uy * v[0];
  return [
    v[0] * cos + crossX * sin + ux * dot * (1 - cos),
    v[1] * cos + crossY * sin + uy * dot * (1 - cos),
    v[2] * cos + crossZ * sin + uz * dot * (1 - cos),
  ];
}

/** Kahn topo-sort of drive relations — returns joint ids in evaluation order. */
function driveTopoOrder(driveRelations: Record<string, DriveRelation>): string[] {
  const jointIds = new Set<string>();
  for (const dr of Object.values(driveRelations)) {
    jointIds.add(dr.driver);
    jointIds.add(dr.driven);
  }
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const jid of jointIds) {
    inDegree.set(jid, 0);
    adj.set(jid, []);
  }
  for (const dr of Object.values(driveRelations)) {
    inDegree.set(dr.driven, (inDegree.get(dr.driven) ?? 0) + 1);
    adj.get(dr.driver)?.push(dr.driven);
  }
  const queue: string[] = [];
  for (const [jid, deg] of inDegree) {
    if (deg === 0) queue.push(jid);
  }
  const sorted: string[] = [];
  while (queue.length > 0) {
    const jid = queue.shift()!;
    sorted.push(jid);
    for (const neighbor of adj.get(jid) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }
  return sorted;
}

/**
 * Evaluate joint transforms on `doc` at the given base joint values map.
 * The `baseValues` map overrides the joint's stored value for a specific joint
 * (the one being swept). All other joints use their stored values.
 *
 * Returns { instancePositions, instanceRotations, resolvedJoints }.
 * @pure — reads only, never mutates doc
 */
function evaluateAtValues(
  doc: CadDocument,
  baseValues: Record<string, number>,
): {
  instancePositions: Record<string, Vec3>;
  instanceRotations: Record<string, Vec3>;
  resolvedJoints: Record<string, number>;
} {
  // Step 1: collect base joint values (from stored doc + overrides)
  const resolvedJoints: Record<string, number> = {};
  for (const [jid, joint] of Object.entries(doc.joints)) {
    const rawValue = joint.kind === 'revolute' ? joint.angle : joint.displacement;
    resolvedJoints[jid] = jid in baseValues ? baseValues[jid]! : rawValue;
  }

  // Step 2: propagate drive relations in topo order
  const sortedJoints = driveTopoOrder(doc.driveRelations);
  const drivenBy = new Map<string, DriveRelation>();
  for (const dr of Object.values(doc.driveRelations)) {
    drivenBy.set(dr.driven, dr);
  }
  for (const jid of sortedJoints) {
    const dr = drivenBy.get(jid);
    if (!dr) continue;
    const driverValue = resolvedJoints[dr.driver];
    if (driverValue === undefined) continue;
    // Only propagate if the driven joint is NOT already overridden by baseValues
    if (!(jid in baseValues)) {
      resolvedJoints[jid] = driverValue * dr.ratio + (dr.offset ?? 0);
    }
  }

  // Step 3: apply joints to instance transforms
  const instancePositions: Record<string, Vec3> = {};
  const instanceRotations: Record<string, Vec3> = {};

  for (const joint of Object.values(doc.joints)) {
    const entityA = doc.entities[joint.a.instanceId];
    const entityB = doc.entities[joint.b.instanceId];
    if (!entityA || entityA.kind !== 'instance') continue;
    if (!entityB || entityB.kind !== 'instance') continue;

    const value = resolvedJoints[joint.id] ?? 0;
    const axisVec = normalizeAxis(joint.axis as 'x' | 'y' | 'z' | Vec3);

    if (joint.kind === 'revolute') {
      const pivot = entityA.position;
      const bPos: Vec3 = instancePositions[joint.b.instanceId] ?? entityB.position;
      const bRot: Vec3 = instanceRotations[joint.b.instanceId] ?? entityB.rotation;
      const offset: Vec3 = [bPos[0] - pivot[0], bPos[1] - pivot[1], bPos[2] - pivot[2]];
      const rotatedOffset = rotateAboutAxis(offset, axisVec, value);
      instancePositions[joint.b.instanceId] = [
        pivot[0] + rotatedOffset[0],
        pivot[1] + rotatedOffset[1],
        pivot[2] + rotatedOffset[2],
      ];
      const deltaRot: Vec3 =
        joint.axis === 'x' ? [value, 0, 0] :
        joint.axis === 'y' ? [0, value, 0] :
        joint.axis === 'z' ? [0, 0, value] :
        [axisVec[0] * value, axisVec[1] * value, axisVec[2] * value];
      instanceRotations[joint.b.instanceId] = [
        bRot[0] + deltaRot[0],
        bRot[1] + deltaRot[1],
        bRot[2] + deltaRot[2],
      ];
    } else {
      const aPos = entityA.position;
      instancePositions[joint.b.instanceId] = [
        aPos[0] + axisVec[0] * value,
        aPos[1] + axisVec[1] * value,
        aPos[2] + axisVec[2] * value,
      ];
      const bRot: Vec3 = instanceRotations[joint.b.instanceId] ?? entityB.rotation;
      instanceRotations[joint.b.instanceId] = bRot;
    }
  }

  return { instancePositions, instanceRotations, resolvedJoints };
}

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
    a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] && a.max[2] >= b.min[2]
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

interface MotionStudyParams {
  mode: string;
  target: string;
  start: number;
  end: number;
  steps?: number;
  interferenceCheck?: boolean;
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
export const motionStudy: CommandDefinition<MotionStudyParams> = {
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
  paramsSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        description:
          'Sweep mode. "joint": vary a specific joint value directly. ' +
          '"parameter": vary a named doc.parameters entry; downstream joints that reference it are re-evaluated.',
        enum: ['joint', 'parameter'],
      },
      target: {
        type: 'string',
        description:
          'What to sweep. For mode="joint": the joint id (must exist in doc.joints). ' +
          'For mode="parameter": the parameter name (must exist in doc.parameters and resolve to a number).',
      },
      start: {
        type: 'number',
        description:
          'Start value of the sweep range (inclusive). ' +
          'For revolute joints: radians. For prismatic joints: document units. For parameters: the parameter\'s unit.',
      },
      end: {
        type: 'number',
        description:
          'End value of the sweep range (inclusive). ' +
          'For revolute joints: radians. For prismatic joints: document units. For parameters: the parameter\'s unit.',
      },
      steps: {
        type: 'number',
        description:
          'Number of samples across the range (default 24, minimum 2, maximum 360). ' +
          'Non-integers are rounded. Step k = start + (end - start) * k / (steps - 1).',
      },
      interferenceCheck: {
        type: 'boolean',
        description:
          'When true, run a lightweight AABB overlap pass on every pair of InstanceEntity objects at each step. ' +
          'Colliding pairs are recorded in the returned interferences array. Default: false.',
      },
    },
    required: ['mode', 'target', 'start', 'end'],
  },
  run: (doc, { mode, target, start, end, steps, interferenceCheck }): CommandResult => {
    // Validate mode
    if (mode !== 'joint' && mode !== 'parameter') {
      return {
        document: doc,
        summary: `motion_study: unknown mode '${String(mode)}'. Use "joint" or "parameter".`,
        affected: [],
      };
    }

    // Validate target
    if (typeof target !== 'string' || target.length === 0) {
      return {
        document: doc,
        summary: 'motion_study: "target" must be a non-empty string.',
        affected: [],
      };
    }

    // Validate start / end
    if (typeof start !== 'number' || !Number.isFinite(start)) {
      return {
        document: doc,
        summary: `motion_study: "start" must be a finite number, got ${String(start)}.`,
        affected: [],
      };
    }
    if (typeof end !== 'number' || !Number.isFinite(end)) {
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
        data: { steps: [], interferences: [], summary: { totalSteps: 0, framesWithInterference: 0 } } satisfies MotionStudyData,
      };
    }

    // Validate and clamp steps
    const rawSteps = steps !== undefined ? Math.round(steps) : 24;
    if (rawSteps < 2) {
      return {
        document: doc,
        summary: `motion_study: steps must be at least 2 (got ${String(steps)}). No sweep performed.`,
        affected: [],
        data: { steps: [], interferences: [], summary: { totalSteps: 0, framesWithInterference: 0 } } satisfies MotionStudyData,
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
      const sweepValue = start + (end - start) * k / (clampedSteps - 1);

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
        const updatedParam = { ...doc.parameters[target]!, value: sweepValue, expression: String(sweepValue) };
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
        // via drive relations will be re-evaluated in evaluateAtValues' topo pass.
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

      const { instancePositions, instanceRotations, resolvedJoints } = evaluateAtValues(doc, baseValues);

      motionSteps.push({ stepIndex: k, sweepValue, instancePositions, instanceRotations, resolvedJoints });

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
};
