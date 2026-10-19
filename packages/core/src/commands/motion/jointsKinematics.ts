import { entityOfKind } from '../entity/entityOfKind';
import type { CadDocument, Joint, DriveRelation, Vec3 } from '../../model/types';
import { JOINT_DOF } from '../../model/joints';
import { resolveNumeric } from '../parametric/expression';
import { topologicalSort } from '../../lib/topologicalSort';
import { eulerFromMat, matFromEulerXYZ, mulMat3 } from '../../lib/axisRotation';
import { camFollower } from './camProfile';
import { clampToLimit, jointValues, violatedLimit } from './jointValues';
import { solveLoop } from './loopSolver';
import { REST, compose, jointMotion, moveBy, unitAxis, type RigidMotion } from './rigidMotion';

/** Joint ids ordered driver before driven; joints on a drive cycle are omitted. */
function driveOrder(driveRelations: Record<string, DriveRelation>): string[] {
  const relations = Object.values(driveRelations);
  const jointIds = new Set(relations.flatMap((dr) => [dr.driver, dr.driven]));
  return topologicalSort(
    jointIds,
    relations.map((dr): [string, string] => [dr.driver, dr.driven]),
  ).sorted;
}

/**
 * Check whether adding a drive relation from `driverJointId` to `drivenJointId` would create a cycle. Returns the cycle path as a string,
 * or null if no cycle.
 */
export function detectCycleOnAdd(
  driveRelations: Record<string, DriveRelation>,
  driverJointId: string,
  drivenJointId: string,
): string | null {
  // Temporarily build the graph with the new edge and run DFS from drivenJointId looking for driverJointId (which would form a cycle).
  const adj = new Map<string, string[]>();
  for (const dr of Object.values(driveRelations)) {
    if (!adj.has(dr.driver)) adj.set(dr.driver, []);
    adj.get(dr.driver)!.push(dr.driven);
  }
  // Add the proposed new edge
  if (!adj.has(driverJointId)) adj.set(driverJointId, []);
  adj.get(driverJointId)!.push(drivenJointId);
  // DFS from drivenJointId looking for driverJointId
  const visited = new Set<string>();
  const path: string[] = [drivenJointId];
  function dfs(current: string): boolean {
    if (current === driverJointId) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    for (const next of adj.get(current) ?? []) {
      path.push(next);
      if (dfs(next)) return true;
      path.pop();
    }
    return false;
  }
  if (dfs(drivenJointId)) return path.join(' → ');
  return null;
}

/** Outcome of the closed-loop solve (absent from `EvaluatedMotion` when the joint graph has no loop). */
export interface LoopReport {
  /** False when the loop cannot close at the driven values (e.g. Grashof violation) or a solved joint leaves its limits. */
  readonly closed: boolean;
  /** Norm of the loop-closure residual (document units). */
  readonly residual: number;
  readonly message: string;
  /** Number of independent loops (joints beyond a spanning tree). */
  readonly loops: number;
  /** Solved values of the passive joints by joint id (feed back as `guess` to follow an assembly branch while sweeping). */
  readonly passive: Record<string, number[]>;
}

interface EvaluatedMotion {
  /** Resolved joint values (joint id → first DOF value) after propagating drive relations. */
  resolvedJoints: Record<string, number>;
  /** All DOF values per joint id in `JOINT_DOF` order. */
  resolvedValues: Record<string, number[]>;
  /** New instance positions after applying joints. */
  instancePositions: Record<string, Vec3>;
  /** New instance rotations after applying joints. */
  instanceRotations: Record<string, Vec3>;
  loop?: LoopReport;
}

/** Stored values (expressions resolved), overrides on the first DOF, limits applied, drive relations and cams propagated. */
function resolveValues(doc: CadDocument, overrides: Readonly<Record<string, number>>): Record<string, number[]> {
  const values: Record<string, number[]> = {};
  for (const [jid, joint] of Object.entries(doc.joints)) {
    const raw = jointValues(joint).map((v, i) => {
      const limited = clampToLimit(
        i === 0 && overrides[jid] !== undefined ? (overrides[jid] ?? v) : (resolveNumeric(v, doc.parameters) ?? v),
        joint.limits?.[i],
      );
      return limited.value;
    });
    values[jid] = raw;
  }
  const drivenBy = new Map<string, DriveRelation>();
  for (const dr of Object.values(doc.driveRelations)) drivenBy.set(dr.driven, dr);
  for (const jid of driveOrder(doc.driveRelations)) {
    const dr = drivenBy.get(jid);
    const joint = doc.joints[jid];
    const driverValue = dr === undefined ? undefined : values[dr.driver]?.[0];
    if (!dr || !joint || driverValue === undefined || overrides[jid] !== undefined) continue;
    values[jid] = (values[jid] ?? []).map((v, i) =>
      i === 0 ? clampToLimit(driverValue * dr.ratio + (dr.offset ?? 0), joint.limits?.[0]).value : v,
    );
  }
  for (const joint of Object.values(doc.joints)) {
    if (joint.kind !== 'cam') continue;
    const driver = doc.joints[joint.camJoint];
    const follower = driver === undefined ? null : camFollower(doc, joint.profileId, unitAxis(driver.axis), unitAxis(joint.axis));
    const angle = values[joint.camJoint]?.[0];
    values[joint.id] = typeof follower === 'object' && follower !== null && angle !== undefined ? [follower.slide(angle)] : [0];
  }
  return values;
}

interface Plan {
  readonly tree: Joint[];
  readonly closing: Joint[];
  readonly moved: Set<string>;
}

/** Spanning tree from the instances that no joint moves (the ground); every further joint between two reached instances closes a loop. */
function planJoints(joints: readonly Joint[]): Plan {
  const movedByJoint = new Set(joints.map((joint) => joint.b.instanceId));
  const reached = new Set(joints.map((joint) => joint.a.instanceId).filter((id) => !movedByJoint.has(id)));
  if (reached.size === 0 && joints[0] !== undefined) reached.add(joints[0].a.instanceId);
  const moved = new Set<string>();
  const [tree, closing]: [Joint[], Joint[]] = [[], []];
  let pending = [...joints];
  for (;;) {
    const next = pending.find((joint) => reached.has(joint.a.instanceId));
    if (next === undefined) break;
    pending = pending.filter((joint) => joint !== next);
    if (reached.has(next.b.instanceId)) closing.push(next);
    else {
      tree.push(next);
      reached.add(next.b.instanceId);
      moved.add(next.b.instanceId);
    }
  }
  return { tree, closing, moved };
}

interface Frames {
  readonly pivot: (joint: Joint) => Vec3;
  readonly position: (instanceId: string) => Vec3;
}

/** Instance motions for the joint values `values`, and the loop-closure residual of the closing joints. */
function pose(
  plan: Plan,
  values: Record<string, number[]>,
  frames: Frames,
  scale: number,
): { motions: Map<string, RigidMotion>; residual: number[] } {
  const motions = new Map<string, RigidMotion>();
  const motionOf = (instanceId: string): RigidMotion => motions.get(instanceId) ?? REST;
  const relative = (joint: Joint): RigidMotion =>
    jointMotion(joint, values[joint.id] ?? [], frames.pivot(joint), frames.position(joint.b.instanceId));
  for (const joint of plan.tree) motions.set(joint.b.instanceId, compose(motionOf(joint.a.instanceId), relative(joint)));
  const residual: number[] = [];
  for (const joint of plan.closing) {
    const predicted = compose(motionOf(joint.a.instanceId), relative(joint));
    const actual = motionOf(joint.b.instanceId);
    const pivot = frames.pivot(joint);
    for (const offset of [
      [0, 0, 0],
      [scale, 0, 0],
      [0, scale, 0],
    ] as const) {
      const point: Vec3 = [pivot[0] + offset[0], pivot[1] + offset[1], pivot[2] + offset[2]];
      const [p, q] = [moveBy(predicted, point), moveBy(actual, point)];
      residual.push(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    }
  }
  return { motions, residual };
}

/** Solve the passive joints so every loop closes; returns the values to pose with and the loop report. */
function closeLoops(
  plan: Plan,
  doc: CadDocument,
  values: Record<string, number[]>,
  frames: Frames,
  guess: Readonly<Record<string, readonly number[]>>,
): { values: Record<string, number[]>; loop: LoopReport } {
  const points = [...plan.tree, ...plan.closing].flatMap((joint) => [frames.pivot(joint), frames.position(joint.b.instanceId)]);
  const first = points[0] ?? [0, 0, 0];
  const extent = Math.max(0, ...points.map((p) => Math.hypot(p[0] - first[0], p[1] - first[1], p[2] - first[2])));
  const scale = extent > 0 ? extent : 1;
  const passive = [...plan.tree, ...plan.closing].filter((joint) => joint.passive === true && JOINT_DOF[joint.kind].length > 0);
  const assemble = (x: readonly number[]): Record<string, number[]> => {
    let cursor = 0;
    const next = { ...values };
    for (const joint of passive) {
      const count = JOINT_DOF[joint.kind].length;
      next[joint.id] = x.slice(cursor, cursor + count);
      cursor += count;
    }
    return next;
  };
  const x0 = passive.flatMap((joint) =>
    guess[joint.id]?.length === JOINT_DOF[joint.kind].length ? [...(guess[joint.id] ?? [])] : (values[joint.id] ?? []),
  );
  const angular = passive.flatMap((joint) => JOINT_DOF[joint.kind].map((dof) => dof === 'r'));
  const base = { loops: plan.closing.length };
  const closed = (x: number[]): Record<string, number[]> =>
    Object.fromEntries(passive.map((joint) => [joint.id, assemble(x)[joint.id] ?? []]));
  if (passive.length === 0) {
    const residual = Math.hypot(...pose(plan, values, frames, scale).residual);
    const ok = residual <= 1e-9 * scale;
    const message = ok
      ? 'loop closes at the given joint values'
      : `loop does not close at the given joint values (gap ${residual.toPrecision(3)}); mark a joint passive to solve it`;
    return { values, loop: { ...base, closed: ok, residual, message, passive: {} } };
  }
  const solution = solveLoop((x) => pose(plan, assemble(x), frames, scale).residual, x0, angular, scale, 1e-9 * scale);
  const solved = assemble(solution.x);
  const outOfLimits = passive.find((joint) => violatedLimit(joint, solved[joint.id] ?? []) >= 0);
  const ok = solution.norm <= 1e-9 * scale && outOfLimits === undefined;
  const message = ok
    ? `loop closed (residual ${solution.norm.toExponential(2)})`
    : outOfLimits !== undefined && solution.norm <= 1e-9 * scale
      ? `loop closes only outside the limits of joint '${outOfLimits.id}'`
      : `the loop cannot close at the driven joint values (best residual ${solution.norm.toPrecision(3)} ${doc.units}); the mechanism is locked or a link is too short`;
  return { values: solved, loop: { ...base, closed: ok, residual: solution.norm, message, passive: closed(solution.x) } };
}

/**
 * Evaluate all joints + drive relations and compute new instance positions/rotations.
 *
 * 1. Collect joint values (expressions via doc.parameters, `overrides` replace the first DOF, limits clamp); propagate drive relations
 *   (driven = driver * ratio + offset, never into an overridden joint) and cam followers.
 * 2. Plan a spanning tree from the ground (instances no joint moves). Tree joints pose b as M_b = M_a ∘ joint motion about the pivot.
 * 3. Joints beyond the tree close loops. When some joint is `passive` its values are solved (Levenberg–Marquardt on the closure residual,
 *   starting from `guess` or the stored values); `loop.closed` is false when no solution exists.
 *
 * Returns EvaluatedMotion. Never mutates doc.
 */
export function evaluateMotionInternal(
  doc: CadDocument,
  overrides: Readonly<Record<string, number>> = {},
  guess: Readonly<Record<string, readonly number[]>> = {},
): EvaluatedMotion {
  const resolved = resolveValues(doc, overrides);
  const isInstance = (id: string): boolean => typeof entityOfKind(doc, id, ['instance']) === 'object';
  const plan = planJoints(Object.values(doc.joints).filter((joint) => isInstance(joint.a.instanceId) && isInstance(joint.b.instanceId)));
  const instanceOf = (id: string): Vec3 => {
    const found = entityOfKind(doc, id, ['instance']);
    return typeof found === 'string' ? [0, 0, 0] : found.position;
  };
  const frames: Frames = { pivot: (joint) => joint.pivot ?? instanceOf(joint.a.instanceId), position: instanceOf };
  const solved = plan.closing.length > 0 ? closeLoops(plan, doc, resolved, frames, guess) : { values: resolved, loop: undefined };
  const { motions } = pose(plan, solved.values, frames, 1);
  const instancePositions: Record<string, Vec3> = {};
  const instanceRotations: Record<string, Vec3> = {};
  for (const instanceId of plan.moved) {
    const instance = entityOfKind(doc, instanceId, ['instance']);
    const motion = motions.get(instanceId);
    if (typeof instance === 'string' || motion === undefined) continue;
    instancePositions[instanceId] = moveBy(motion, instance.position);
    instanceRotations[instanceId] = eulerFromMat(mulMat3(motion.rotation, matFromEulerXYZ(instance.rotation)));
  }
  const resolvedJoints = Object.fromEntries(Object.entries(solved.values).map(([jid, v]) => [jid, v[0] ?? 0]));
  return {
    resolvedJoints,
    resolvedValues: solved.values,
    instancePositions,
    instanceRotations,
    ...(solved.loop ? { loop: solved.loop } : {}),
  };
}
