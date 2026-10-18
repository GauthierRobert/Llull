/**
 * The `check_motion_clearance` sweep (TECHNICAL_SPEC 5.6): part meshes carried by the simulated body poses, BVH minimum distance per
 * pair and moment, contact intervals, and the exact overlap volume at the worst pose of each interval.
 * @invariant deterministic: fixed pair order (part order, i < j), fixed sample order, no random
 * @invariant a pair never reports interference from surface contact alone: the overlap volume decides (touch = no volume)
 */

import type { CadDocument, Vec3 } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import { type MeshBvh, buildMeshBvh, bvhMinDistance } from '../../geometry/meshBvh';
import type { AssemblyPart } from '../../geometry/assemblyCheck/partTypes';
import { overlapOf } from '../../geometry/assemblyCheck/pairClassify';
import { type CheckItem, findingKey } from '../../model/checkResult';
import { type BodyPoseAt, documentAtPose, pointAtPose } from '../../dynamics/bodyPose';
import { STATIC_POSE, type PoseTrack, isMoving, poseAt, relativeTransform, travelBound } from '../../dynamics/motionPoses';
import { collectParts } from '../inspect/assemblyParts';
import { intentOf } from '../inspect/assemblyGraph';

/** Most substeps between two recorded samples (pose interpolation against tunnelling). */
const MAX_SUBSTEPS = 16;
/** Most contact intervals per pair whose overlap volume is computed with the kernel. */
const MAX_CLASSIFIED = 12;
const VOLUME_RELATIVE = 1e-6;
const MAX_REPORTED_INTERVALS = 50;

export interface MotionPart {
  readonly part: AssemblyPart;
  readonly bvh: MeshBvh;
  /** Rigid body that carries the part while it moves; null = it never moves. */
  readonly body: string | null;
  /** Largest distance from the body's start centre of mass to a corner of the part's bounds (document units). */
  readonly radius: number;
  /** Smallest side of the part's bounds (document units): the tunnelling guard. */
  readonly thin: number;
}

export interface MotionPlan {
  readonly doc: CadDocument;
  readonly kernel: GeometryKernel;
  readonly parts: readonly MotionPart[];
  readonly pairs: ReadonlyArray<readonly [MotionPart, MotionPart]>;
  /** Strided run: sample times (s), unwrapped crank angle (deg, or null) and the pose tracks per body. */
  readonly times: readonly number[];
  readonly crankDeg: readonly number[] | null;
  readonly tracks: Readonly<Record<string, PoseTrack>>;
  /** Document units: touch tolerance, required clearance. */
  readonly eps: number;
  readonly clearance: number;
  readonly mmPerUnit: number;
}

export interface MotionPlanInput {
  readonly doc: CadDocument;
  readonly kernel: GeometryKernel;
  readonly parts: readonly AssemblyPart[];
  readonly bodyOf: ReadonlyMap<string, string>;
  readonly poses: { readonly times: readonly number[]; readonly bodies: Readonly<Record<string, PoseTrack>> };
  readonly crankDeg: readonly number[] | null;
  readonly focus: ReadonlySet<string> | null;
  readonly includeStatic: boolean;
  readonly stride: number;
  readonly eps: number;
  readonly clearance: number;
  readonly mmPerUnit: number;
}

export function planMotion(input: MotionPlanInput): MotionPlan {
  const { poses, stride } = input;
  const keep = poses.times.map((_, i) => i).filter((i) => i % stride === 0 || i === poses.times.length - 1);
  const tracks = Object.fromEntries(
    Object.entries(poses.bodies).map(([id, track]) => [
      id,
      {
        position: keep.map((i) => track.position[i] ?? STATIC_POSE.position),
        orientation: keep.map((i) => track.orientation[i] ?? STATIC_POSE.orientation),
      },
    ]),
  );
  const movingBodies = new Set(
    Object.entries(tracks)
      .filter(([, track]) => isMoving(track))
      .map(([id]) => id),
  );
  const parts: MotionPart[] = input.parts.map((part) => {
    const owner = input.bodyOf.get(part.id);
    const body = owner !== undefined && tracks[owner] !== undefined ? owner : null;
    const centre = body === null ? STATIC_POSE.start : (tracks[body]?.position[0] ?? STATIC_POSE.start);
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) =>
      Math.hypot(
        (c & 1 ? part.max[0] : part.min[0]) - centre[0],
        (c & 2 ? part.max[1] : part.min[1]) - centre[1],
        (c & 4 ? part.max[2] : part.min[2]) - centre[2],
      ),
    );
    const thin = Math.min(part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]);
    return { part, bvh: buildMeshBvh(part.mesh ?? { positions: [], indices: [] }), body, radius: Math.max(...corners), thin };
  });
  const moves = (p: MotionPart): boolean => p.body !== null && movingBodies.has(p.body);
  const pairs: Array<readonly [MotionPart, MotionPart]> = [];
  parts.forEach((a, i) => {
    for (const b of parts.slice(i + 1)) {
      if (a.body !== null && a.body === b.body) continue;
      if (!input.includeStatic && !moves(a) && !moves(b)) continue;
      if (input.focus !== null && !input.focus.has(a.part.id) && !input.focus.has(b.part.id)) continue;
      pairs.push([a, b]);
    }
  });
  const times = keep.flatMap((i) => poses.times[i] ?? []);
  const crankDeg = input.crankDeg === null ? null : keep.flatMap((i) => input.crankDeg?.[i] ?? []);
  return { ...input, parts, pairs, times, crankDeg, tracks };
}

/** A place on the strided run: `u` = sample index plus fraction. */
interface Moment {
  readonly u: number;
  readonly timeS: number;
  readonly crankDeg: number | null;
}

function momentAt(plan: MotionPlan, u: number): Moment {
  const last = plan.times.length - 1;
  const i = Math.min(Math.floor(u), last);
  const f = i >= last ? 0 : u - i;
  const lerp = (series: readonly number[]): number => (series[i] ?? 0) + ((series[Math.min(i + 1, last)] ?? 0) - (series[i] ?? 0)) * f;
  const raw = plan.crankDeg === null ? null : lerp(plan.crankDeg);
  return { u, timeS: lerp(plan.times), crankDeg: raw === null ? null : ((raw % 360) + 360) % 360 };
}

function poseOf(plan: MotionPlan, part: MotionPart, u: number): BodyPoseAt {
  const track = part.body === null ? undefined : plan.tracks[part.body];
  if (track === undefined) return STATIC_POSE;
  const i = Math.min(Math.floor(u), plan.times.length - 1);
  return poseAt(track, i, u - i);
}

type Kind = 'interference' | 'touch' | 'unknown';

interface Interval {
  readonly from: Moment;
  to: Moment;
  samples: number;
  kind: Kind;
  volume: number | null;
  depth: number | null;
}

interface Closest {
  readonly distance: number;
  readonly moment: Moment;
  readonly witness: readonly [Vec3, Vec3];
}

export interface PairReport {
  readonly a: string;
  readonly b: string;
  readonly minClearanceMm: number | null;
  readonly timeS: number | null;
  readonly crankDeg: number | null;
  readonly witnessMm: readonly [Vec3, Vec3] | null;
  readonly status: 'interference' | 'allowed' | 'touch' | 'clearance_low' | 'clear';
  readonly collisions: ReadonlyArray<{
    readonly kind: Kind;
    readonly startTimeS: number;
    readonly endTimeS: number;
    readonly startCrankDeg: number | null;
    readonly endCrankDeg: number | null;
    readonly samples: number;
    readonly overlapVolumeMm3: number | null;
    readonly penetrationEstimateMm: number | null;
  }>;
}

const mmPoint = (p: Vec3, k: number): Vec3 => [p[0] * k, p[1] * k, p[2] * k];

function volumeAt(plan: MotionPlan, a: MotionPart, b: MotionPart, u: number): { volume: number; depth: number } | null {
  const poses: Record<string, BodyPoseAt> = {};
  for (const part of [a, b]) if (part.body !== null) poses[part.body] = poseOf(plan, part, u);
  const placed = collectParts(documentAtPose(plan.doc, poses), plan.kernel, new Set([a.part.id, b.part.id])).parts;
  const [first, second] = [placed.find((p) => p.id === a.part.id), placed.find((p) => p.id === b.part.id)];
  return first === undefined || second === undefined ? null : overlapOf(plan.kernel, first, second);
}

function classify(plan: MotionPlan, a: MotionPart, b: MotionPart, intervals: Interval[]): void {
  const volumeOf = (part: MotionPart): number => plan.kernel.analyze?.(part.part.shape)?.volume ?? 0;
  const tolerance = VOLUME_RELATIVE * Math.min(volumeOf(a), volumeOf(b));
  const step = Math.max(1, Math.ceil(intervals.length / MAX_CLASSIFIED));
  intervals.forEach((interval, index) => {
    if (index % step !== 0) return;
    const [u0, u1] = [interval.from.u, interval.to.u];
    const found = [u0, (u0 + u1) / 2, u1].map((u) => volumeAt(plan, a, b, u));
    if (found.some((entry) => entry === null)) return;
    const worst = found.reduce(
      (top, entry) => (entry !== null && (top === null || entry.volume > top.volume) ? entry : top),
      found[0] ?? null,
    );
    interval.volume = worst?.volume ?? 0;
    interval.depth = worst?.depth ?? 0;
    interval.kind = (worst?.volume ?? 0) > tolerance ? 'interference' : 'touch';
  });
}

interface Sweep {
  readonly best: Closest | null;
  readonly intervals: Interval[];
  readonly undersampled: boolean;
  readonly evaluations: number;
  readonly maxStepMm: number;
}

function sweep(plan: MotionPlan, a: MotionPart, b: MotionPart): Sweep {
  const lowBound = plan.clearance + plan.eps;
  const limit = Math.max(Math.min(a.thin, b.thin) / 2, 1e-9);
  const state: { best: Closest | null; bound: number; open: Interval | null } = { best: null, bound: Infinity, open: null };
  const intervals: Interval[] = [];
  let evaluations = 0;
  const evaluate = (u: number): void => {
    evaluations++;
    const poseA = poseOf(plan, a, u);
    const hit = bvhMinDistance(a.bvh, b.bvh, state.bound, relativeTransform(poseA, poseOf(plan, b, u)));
    const moment = momentAt(plan, u);
    if (hit !== null && (state.best === null || hit.distance < state.best.distance)) {
      state.best = { distance: hit.distance, moment, witness: [pointAtPose(hit.pointA, poseA), pointAtPose(hit.pointB, poseA)] };
      state.bound = Math.max(hit.distance, lowBound);
    }
    if (hit !== null && hit.distance <= plan.eps) {
      if (state.open === null) {
        state.open = { from: moment, to: moment, samples: 0, kind: 'unknown', volume: null, depth: null };
        intervals.push(state.open);
      }
      state.open.to = moment;
      state.open.samples++;
    } else state.open = null;
  };
  let undersampled = false;
  let maxStep = 0;
  evaluate(0);
  for (let i = 0; i + 1 < plan.times.length; i++) {
    const travel = [a, b].reduce((sum, part) => {
      const track = part.body === null ? undefined : plan.tracks[part.body];
      return track === undefined ? sum : sum + travelBound(track, i, part.radius);
    }, 0);
    const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(travel / limit)));
    if (travel / substeps > Math.min(a.thin, b.thin)) undersampled = true;
    maxStep = Math.max(maxStep, travel / substeps);
    for (let k = 1; k <= substeps; k++) evaluate(i + k / substeps);
  }
  classify(plan, a, b, intervals);
  return { best: state.best, intervals, undersampled, evaluations, maxStepMm: maxStep * plan.mmPerUnit };
}

const item = (
  code: string,
  status: CheckItem['status'],
  ids: readonly string[],
  remediation: string,
  extra: Partial<CheckItem>,
): CheckItem => ({
  code,
  status,
  ids: [...ids].sort(),
  findingKey: findingKey('motion_clearance', code, ids),
  values: {},
  remediation,
  ...extra,
});

export interface MotionOutcome {
  readonly pairs: PairReport[];
  readonly items: CheckItem[];
  readonly evaluations: number;
}

export function runMotion(plan: MotionPlan): MotionOutcome {
  const { mmPerUnit } = plan;
  const pairs: PairReport[] = [];
  const items: CheckItem[] = [];
  const undersampled = new Set<string>();
  let evaluations = 0;
  let maxStepMm = 0;
  for (const [a, b] of plan.pairs) {
    const ids = [a.part.id, b.part.id];
    const result = sweep(plan, a, b);
    evaluations += result.evaluations;
    maxStepMm = Math.max(maxStepMm, result.maxStepMm);
    if (result.undersampled) ids.forEach((id) => undersampled.add(id));
    const { best, intervals } = result;
    const hard = intervals.filter((interval) => interval.kind !== 'touch');
    const intent = intentOf(plan.doc, a.part.id, b.part.id);
    const unknown = hard.some((interval) => interval.kind === 'unknown');
    const worst = hard.reduce<Interval | null>(
      (top, interval) => ((interval.volume ?? Infinity) > (top?.volume ?? -1) ? interval : top),
      null,
    );
    const lowClearance = hard.length === 0 && best !== null && best.distance < plan.clearance;
    let status: PairReport['status'] = 'clear';
    if (hard.length > 0 && intent !== undefined && !unknown) status = 'allowed';
    else if (hard.length > 0) status = 'interference';
    else if (intervals.length > 0) status = 'touch';
    else if (lowClearance) status = 'clearance_low';
    if (worst !== null) {
      const values: Record<string, number> = {
        intervals: hard.length,
        firstContactTimeS: hard[0]?.from.timeS ?? 0,
        minDistanceMm: 0,
        ...(worst.volume === null ? {} : { maxOverlapVolumeMm3: worst.volume * mmPerUnit ** 3 }),
        ...(worst.depth === null ? {} : { maxPenetrationEstimateMm: worst.depth * mmPerUnit }),
      };
      const witness = {
        pointsMm: (best?.witness ?? []).map((p) => mmPoint(p, mmPerUnit)),
        timeS: worst.from.timeS,
        ...(worst.from.crankDeg === null ? {} : { crankDeg: worst.from.crankDeg }),
      };
      if (status === 'allowed' && intent !== undefined)
        items.push(
          item(
            'FPR_MOTION_ALLOWED',
            'pass',
            ids,
            `Declared ${intent.kind}: ${intent.reason}. Remove with remove_interference_intent when it no longer applies.`,
            { values, witness, intent: { id: intent.id, kind: intent.kind, reason: intent.reason, declaredBy: intent.declaredBy } },
          ),
        );
      else
        items.push(
          item(
            'FPR_MOTION_INTERFERENCE',
            'fail',
            ids,
            'Move or resize a part, change the mechanism geometry, or declare an intended overlap (press fit, weld) with allow_interference and a reason.',
            {
              values,
              witness,
              ...(unknown
                ? {
                    unverified: true,
                    note: 'contact found but the overlap volume could not be computed (kernel without analyze, or too many intervals)',
                  }
                : {}),
            },
          ),
        );
    } else if (status === 'touch')
      items.push(
        item('FPR_MOTION_TOUCH', 'info', ids, 'Parts touch during the motion with zero overlap volume (e.g. a pin in its bore).', {
          values: { intervals: intervals.length, firstContactTimeS: intervals[0]?.from.timeS ?? 0 },
        }),
      );
    else if (status === 'clearance_low' && best !== null)
      items.push(
        item('FPR_MOTION_CLEARANCE_LOW', 'warn', ids, 'Increase the gap at the reported time / crank angle, or lower clearanceMm.', {
          values: { minDistanceMm: best.distance * mmPerUnit, timeS: best.moment.timeS },
          witness: {
            pointsMm: best.witness.map((p) => mmPoint(p, mmPerUnit)),
            timeS: best.moment.timeS,
            ...(best.moment.crankDeg === null ? {} : { crankDeg: best.moment.crankDeg }),
          },
          threshold: { value: plan.clearance * mmPerUnit, unit: 'mm', source: 'clearanceMm parameter', grade: 'A', defaulted: false },
        }),
      );
    pairs.push({
      a: a.part.id,
      b: b.part.id,
      minClearanceMm: best === null ? null : best.distance * mmPerUnit,
      timeS: best?.moment.timeS ?? null,
      crankDeg: best?.moment.crankDeg ?? null,
      witnessMm: best === null ? null : [mmPoint(best.witness[0], mmPerUnit), mmPoint(best.witness[1], mmPerUnit)],
      status,
      collisions: intervals
        .slice(0, MAX_REPORTED_INTERVALS)
        .map((interval) => ({
          kind: interval.kind,
          startTimeS: interval.from.timeS,
          endTimeS: interval.to.timeS,
          startCrankDeg: interval.from.crankDeg,
          endCrankDeg: interval.to.crankDeg,
          samples: interval.samples,
          overlapVolumeMm3: interval.volume === null ? null : interval.volume * mmPerUnit ** 3,
          penetrationEstimateMm: interval.depth === null ? null : interval.depth * mmPerUnit,
        })),
    });
  }
  if (undersampled.size > 0)
    items.push(
      item(
        'FPR_MOTION_UNDERSAMPLED',
        'warn',
        [...undersampled],
        'Parts move further between samples than their thinnest side even after interpolation: raise sampleRate or shorten duration so a thin obstacle cannot be skipped.',
        { values: { maxStepMm }, unverified: true, note: 'a pass for these parts may miss a short contact' },
      ),
    );
  return { pairs, items, evaluations };
}
