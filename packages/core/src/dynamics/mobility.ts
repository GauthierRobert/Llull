/**
 * Mobility of a loop-closed mechanism (TR-FPR-09): Gruebler count, numerical rank of the loop-constraint Jacobian at the start pose
 * (finite differences in tree coordinates, column-pivoted Gram-Schmidt = pivoted QR), redundant constraint rows, and the start-pose gap of
 * every loop. Lengths in metres.
 */

import { GROUND, type DynamicJoint, type DynamicsModel } from '../model/dynamics';
import type { Vec3 } from '../model/vectors';
import type { Topology } from './topology';
import { elementAt } from '../lib/elementAt';
import { cross3, dot3, scale3 } from '../lib/vec3';

/** Central-difference step in tree coordinates (rad or m). */
const DIFFERENCE_STEP = 1e-7;
/** A pivot below this fraction of the largest one is numerically zero: sqrt(machine epsilon), the noise floor of the central differences. */
const RANK_TOLERANCE = 1e-6;
/** Largest start-pose distance (m) between the two pins of a loop that still counts as closed (FR-FPR-12). */
export const LOOP_OPEN_TOLERANCE_M = 1e-6;

type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
interface Pose {
  readonly rotation: Mat3;
  readonly translation: Vec3;
}

const IDENTITY: Pose = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] };

const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

function multiply(a: Mat3, b: Mat3): Mat3 {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const [b0, b1, b2, b3, b4, b5, b6, b7, b8] = b;
  return [
    a0 * b0 + a1 * b3 + a2 * b6,
    a0 * b1 + a1 * b4 + a2 * b7,
    a0 * b2 + a1 * b5 + a2 * b8,
    a3 * b0 + a4 * b3 + a5 * b6,
    a3 * b1 + a4 * b4 + a5 * b7,
    a3 * b2 + a4 * b5 + a5 * b8,
    a6 * b0 + a7 * b3 + a8 * b6,
    a6 * b1 + a7 * b4 + a8 * b7,
    a6 * b2 + a7 * b5 + a8 * b8,
  ];
}

const transform = (pose: Pose, point: Vec3): Vec3 => {
  const v = apply(pose.rotation, point);
  return [v[0] + pose.translation[0], v[1] + pose.translation[1], v[2] + pose.translation[2]];
};

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1];
}

/** Rodrigues rotation matrix of `angle` about unit `u`. */
function rotationAbout(u: Vec3, angle: number): Mat3 {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const [x, y, z] = u;
  const k = 1 - c;
  return [
    c + x * x * k,
    x * y * k - z * s,
    x * z * k + y * s,
    y * x * k + z * s,
    c + y * y * k,
    y * z * k - x * s,
    z * x * k - y * s,
    z * y * k + x * s,
    c + z * z * k,
  ];
}

/** Motion of a child relative to its parent in the start layout: rotation about the anchor line, or translation along the axis. */
function jointMotion(joint: DynamicJoint, q: number, metresPerUnit: number): Pose {
  const axis = unit(joint.axis);
  if (joint.kind === 'prismatic') return { rotation: IDENTITY.rotation, translation: [axis[0] * q, axis[1] * q, axis[2] * q] };
  const anchor = scale3(joint.anchor, metresPerUnit);
  const rotation = rotationAbout(axis, q);
  const turned = apply(rotation, anchor);
  return { rotation, translation: [anchor[0] - turned[0], anchor[1] - turned[1], anchor[2] - turned[2]] };
}

/** World pose of every body for tree coordinates `q` (one per tree joint, declared sense). */
function bodyPoses(topology: Topology, q: readonly number[], metresPerUnit: number): Map<string, Pose> {
  const poses = new Map<string, Pose>();
  for (const id of topology.bodyOrder) {
    const entry = topology.jointOfBody.get(id);
    if (entry === undefined) {
      poses.set(id, IDENTITY);
      continue;
    }
    const parent = entry.parent === GROUND ? IDENTITY : (poses.get(entry.parent) ?? IDENTITY);
    const value = elementAt(q, topology.tree.indexOf(entry)) * (entry.flipped ? -1 : 1);
    const motion = jointMotion(entry.joint, value, metresPerUnit);
    const rotated = apply(parent.rotation, motion.translation);
    poses.set(id, {
      rotation: multiply(parent.rotation, motion.rotation),
      translation: [rotated[0] + parent.translation[0], rotated[1] + parent.translation[1], rotated[2] + parent.translation[2]],
    });
  }
  return poses;
}

/** Two unit vectors orthogonal to unit `u` and to each other. */
function orthogonalPair(u: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(cross3(u, helper));
  return [e1, cross3(u, e1)];
}

/** Constraint rows of every loop at tree coordinates `q`: 3 position rows, plus 2 axis-alignment rows for a revolute loop. */
function loopResidual(topology: Topology, q: readonly number[], metresPerUnit: number): number[] {
  const poses = bodyPoses(topology, q, metresPerUnit);
  const poseOf = (id: string): Pose => (id === GROUND ? IDENTITY : (poses.get(id) ?? IDENTITY));
  const rows: number[] = [];
  for (const loop of topology.loops) {
    const [a, b] = [poseOf(loop.parent), poseOf(loop.child)];
    const anchor = scale3(loop.anchor, metresPerUnit);
    const onChild = scale3(loop.anchorOnChild ?? loop.anchor, metresPerUnit);
    const [pa, pb] = [transform(a, anchor), transform(b, onChild)];
    rows.push(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
    if (loop.kind === 'revolute') {
      const axis = unit(loop.axis);
      const axisB = apply(b.rotation, axis);
      for (const e of orthogonalPair(axis)) rows.push(dot3(apply(a.rotation, e), axisB));
    }
  }
  return rows;
}

interface Pivot {
  readonly index: number;
  readonly size: number;
}

/** Column-pivoted Gram-Schmidt of the given columns: pivot order with the residual norm of each chosen column. */
function pivotedColumns(columns: readonly number[][]): Pivot[] {
  const residual = columns.map((column) => [...column]);
  const remaining = new Set(columns.keys());
  const pivots: Pivot[] = [];
  const norm = (v: readonly number[]): number => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  while (remaining.size > 0) {
    let best = -1;
    let bestNorm = -1;
    for (const i of remaining) {
      const n = norm(elementAt(residual, i));
      if (n > bestNorm) [best, bestNorm] = [i, n];
    }
    remaining.delete(best);
    pivots.push({ index: best, size: bestNorm });
    const direction = elementAt(residual, best);
    if (bestNorm > 0)
      for (const i of remaining) {
        const target = elementAt(residual, i);
        const projection = target.reduce((sum, x, k) => sum + x * elementAt(direction, k), 0) / (bestNorm * bestNorm);
        residual[i] = target.map((x, k) => x - projection * elementAt(direction, k));
      }
  }
  return pivots;
}

interface RedundantRow {
  readonly loop: string;
  readonly component: string;
  readonly message: string;
}

export interface MobilityResult {
  /** 6 · movable bodies − Σ joint constraints (revolute 5, prismatic 5, spherical 3). Can be wrong in either direction (planar loops). */
  readonly gruebler: number;
  readonly treeCoordinates: number;
  readonly constraintRows: number;
  readonly rank: number;
  readonly dof: number;
  readonly redundant: readonly RedundantRow[];
  readonly suggestions: readonly string[];
  /** Start-pose distance (m) between the two pins of each loop. */
  readonly loopGapsM: Readonly<Record<string, number>>;
  /** Gear couplings with a loop joint on one side: no tree coordinate to constrain, so they add no row. */
  readonly skippedGears: readonly string[];
}

const CONSTRAINTS: Readonly<Record<DynamicJoint['kind'], number>> = { revolute: 5, prismatic: 5, spherical: 3 };
const AXIS_NAMES = ['x', 'y', 'z'] as const;

/** Tree joints on the path between the two ends of a loop joint (what the loop closes against). */
function treePath(topology: Topology, loop: DynamicJoint): string[] {
  const chain = (start: string): string[] => {
    const ids: string[] = [];
    for (let id = start, guard = 0; id !== GROUND && guard < 1000; guard++) {
      const entry = topology.jointOfBody.get(id);
      if (entry === undefined) break;
      ids.push(entry.joint.id);
      id = entry.parent;
    }
    return ids;
  };
  const [up, down] = [chain(loop.parent), chain(loop.child)];
  const common = new Set(up.filter((id) => down.includes(id)));
  return [...up, ...down].filter((id) => !common.has(id));
}

/** Jacobian of the loop rows with respect to the tree coordinates at the start pose: `rows` arrays of length nq (central differences). */
function loopJacobian(topology: Topology, rows: number, metresPerUnit: number): number[][] {
  const nq = topology.tree.length;
  const base = new Array<number>(nq).fill(0);
  const jacobian: number[][] = Array.from({ length: rows }, () => []);
  for (let j = 0; j < nq; j++) {
    const [plus, minus] = [[...base], [...base]];
    plus[j] = DIFFERENCE_STEP;
    minus[j] = -DIFFERENCE_STEP;
    const [fp, fm] = [loopResidual(topology, plus, metresPerUnit), loopResidual(topology, minus, metresPerUnit)];
    jacobian.forEach((row, i) => row.push((elementAt(fp, i) - elementAt(fm, i)) / (2 * DIFFERENCE_STEP)));
  }
  return jacobian;
}

/** Solve the symmetric positive definite system `a x = b` (Gaussian elimination; no row exchange is needed for such a system). */
function solveSystem(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, elementAt(b, i)]);
  for (let col = 0; col < n; col++) {
    const pivotRow = elementAt(m, col);
    for (let r = col + 1; r < n; r++) {
      const row = elementAt(m, r);
      const factor = elementAt(row, col) / elementAt(pivotRow, col);
      for (let c = col; c <= n; c++) row[c] = elementAt(row, c) - factor * elementAt(pivotRow, c);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    const r = elementAt(m, row);
    let sum = elementAt(r, n);
    for (let c = row + 1; c < n; c++) sum -= elementAt(r, c) * elementAt(x, c);
    x[row] = sum / elementAt(r, row);
  }
  return x;
}

/**
 * Initial tree-joint speeds consistent with the loop constraints: joints with a prescribed non-zero speed keep it, the others take the
 * minimum-norm speeds that keep the loops closed (J_free q' = -J_prescribed q'). Without loops the prescribed speeds are returned.
 */
export function consistentSpeeds(
  topology: Topology,
  prescribed: Readonly<Record<string, number>>,
  metresPerUnit: number,
): Record<string, number> {
  const prescribedSpeed = (id: string): number => prescribed[id] ?? 0;
  const speeds = Object.fromEntries(topology.tree.map((entry) => [entry.joint.id, prescribedSpeed(entry.joint.id)]));
  if (topology.loops.length === 0) return speeds;
  const rows = topology.loops.reduce((sum, loop) => sum + (loop.kind === 'revolute' ? 5 : 3), 0);
  const jacobian = loopJacobian(topology, rows, metresPerUnit);
  const free = topology.tree.flatMap((entry, i) => (prescribedSpeed(entry.joint.id) === 0 ? [i] : []));
  if (free.length === 0 || free.length === topology.tree.length) return speeds;
  const driven = topology.tree.map((entry, i) => (free.includes(i) ? 0 : prescribedSpeed(entry.joint.id)));
  const rhs = jacobian.map((row) => -row.reduce((sum, value, i) => sum + value * elementAt(driven, i), 0));
  const a = free.map((i) => free.map((j) => jacobian.reduce((sum, row) => sum + elementAt(row, i) * elementAt(row, j), 0)));
  const scale = Math.max(1e-300, ...a.map((row, i) => elementAt(row, i)));
  const regular = a.map((row, i) => row.map((value, j) => value + (i === j ? 1e-12 * scale : 0)));
  const b = free.map((i) => jacobian.reduce((sum, row, r) => sum + elementAt(row, i) * elementAt(rhs, r), 0));
  const solution = solveSystem(regular, b);
  free.forEach((i, k) => {
    const entry = topology.tree[i];
    if (entry !== undefined) speeds[entry.joint.id] = elementAt(solution, k);
  });
  return speeds;
}

/**
 * One unit-norm row per gear coupling whose two joints are both tree joints: q'(driven) - ratio · q'(driver) = 0 (tree coordinates are
 * in the declared sense of their joint). A coupling with a loop joint on either side has no tree coordinate to constrain and is returned
 * in `skipped`.
 */
function gearConstraintRows(dynamics: DynamicsModel, topology: Topology): { rows: { gear: string; row: number[] }[]; skipped: string[] } {
  const nq = topology.tree.length;
  const indexOf = (id: string): number => topology.tree.findIndex((entry) => entry.joint.id === id);
  const rows: { gear: string; row: number[] }[] = [];
  const skipped: string[] = [];
  for (const gear of Object.values(dynamics.gears)) {
    const [driver, driven] = [indexOf(gear.driver), indexOf(gear.driven)];
    if (driver < 0 || driven < 0) {
      skipped.push(gear.id);
      continue;
    }
    const row = new Array<number>(nq).fill(0);
    const norm = Math.hypot(1, gear.ratio);
    row[driven] = 1 / norm;
    row[driver] = (row[driver] ?? 0) - gear.ratio / norm;
    rows.push({ gear: gear.id, row });
  }
  return { rows, skipped };
}

/** Mobility analysis of `topology` at the start pose; `metresPerUnit` converts anchors. */
export function analyseMobility(dynamics: DynamicsModel, topology: Topology, metresPerUnit: number): MobilityResult {
  const joints = Object.values(dynamics.joints);
  const movable = Object.values(dynamics.bodies).filter((body) => !body.fixed).length;
  const gruebler = 6 * movable - joints.reduce((sum, joint) => sum + CONSTRAINTS[joint.kind], 0);
  const nq = topology.tree.length;
  const base = new Array<number>(nq).fill(0);
  const rows0 = loopResidual(topology, base, metresPerUnit);
  const loopGapsM: Record<string, number> = {};
  const labels: { loop: DynamicJoint; component: string; rotation: boolean }[] = [];
  let cursor = 0;
  for (const loop of topology.loops) {
    loopGapsM[loop.id] = Math.hypot(elementAt(rows0, cursor), elementAt(rows0, cursor + 1), elementAt(rows0, cursor + 2));
    for (let k = 0; k < 3; k++) labels.push({ loop, component: `position ${AXIS_NAMES[k]}`, rotation: false });
    cursor += 3;
    if (loop.kind === 'revolute') {
      labels.push({ loop, component: 'axis tilt 1', rotation: true }, { loop, component: 'axis tilt 2', rotation: true });
      cursor += 2;
    }
  }
  const gears = gearConstraintRows(dynamics, topology);
  const columns = [...loopJacobian(topology, labels.length, metresPerUnit), ...gears.rows.map((entry) => entry.row)];
  const pivots = nq === 0 ? columns.map((_, index) => ({ index, size: 0 })) : pivotedColumns(columns);
  const largest = pivots[0]?.size ?? 0;
  const rank = largest > 0 ? pivots.filter((pivot) => pivot.size > RANK_TOLERANCE * largest).length : 0;
  const redundant: RedundantRow[] = [];
  const suggestions = new Set<string>();
  for (const pivot of pivots.slice(rank).sort((a, b) => a.index - b.index)) {
    const label = labels[pivot.index];
    if (label === undefined) {
      const gear = gears.rows[pivot.index - labels.length]?.gear;
      if (gear !== undefined)
        redundant.push({
          loop: gear,
          component: 'gear ratio',
          message: `gear coupling '${gear}' repeats a constraint already fixed by the joints and other couplings`,
        });
      continue;
    }
    const by = treePath(topology, label.loop).map((id) => `'${id}'`);
    const through = by.length > 0 ? ` by ${by.join(', ')}` : '';
    redundant.push({
      loop: label.loop.id,
      component: label.component,
      message: label.rotation
        ? `joint '${label.loop.id}' repeats a rotation (${label.component}) already fixed${through}`
        : `joint '${label.loop.id}' repeats the ${label.component} of its pin, already fixed${through}`,
    });
    if (label.loop.kind === 'revolute')
      suggestions.add(`make joint '${label.loop.id}' kind 'spherical' (a ball pin removes the redundant rotations)`);
  }
  return {
    gruebler,
    treeCoordinates: nq,
    constraintRows: columns.length,
    rank,
    dof: nq - rank,
    redundant,
    suggestions: [...suggestions],
    loopGapsM,
    skippedGears: gears.skipped,
  };
}
