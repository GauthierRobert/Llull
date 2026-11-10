/** 14 FLL: the d'Alembert body force of an `inertial` load (a, omega, alpha about a reference point) as CalculiX `*DLOAD` lines. */

import type { FeaLoad } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { ALL_ELEMENTS, type DeckContext, type DeckRefusal } from './context';
import { num, row } from './format';

/** Rotation terms of the inertial loads of one step (the linear acceleration goes into the gravity field of the step). */
export interface InertialTerms {
  /** omega^2 (rad^2/s^2), a point on the axis (analysis length) and the unit axis. */
  readonly centrifugal: readonly { readonly omegaSquared: number; readonly point: Vec3; readonly axis: Vec3 }[];
  /** Angular acceleration (rad/s^2) and the reference point it acts about (analysis length). */
  readonly angular: readonly { readonly alpha: Vec3; readonly point: Vec3 }[];
}

const component = (values: readonly number[], index: number): number => values[index] ?? 0;
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Field acceleration to add to the gravity field for an inertial load scaled by `factor`: `-a` (body force -rho a); the rotation terms are
 * collected into `terms`.
 * @invariant body force = rho (g - a - alpha x r - omega x (omega x r)); -omega x (omega x r) = omega^2 r_perp is CalculiX CENTRIF
 */
export function inertialContribution(
  ctx: DeckContext,
  load: FeaLoad,
  factor: number,
): {
  readonly field: Vec3;
  readonly centrifugal?: InertialTerms['centrifugal'][number];
  readonly angular?: InertialTerms['angular'][number];
} {
  const scale = ctx.lengthToAnalysis;
  const point = (load.referencePoint ?? [0, 0, 0]).map((value) => value * scale) as unknown as Vec3;
  const linear = load.vector ?? [0, 0, 0];
  const omega = load.angularVelocity ?? [0, 0, 0];
  const speed = Math.hypot(omega[0], omega[1], omega[2]);
  const alpha = load.angularAccel ?? [0, 0, 0];
  return {
    field: [-linear[0] * factor, -linear[1] * factor, -linear[2] * factor],
    ...(speed > 0
      ? { centrifugal: { omegaSquared: speed * speed * factor, point, axis: omega.map((value) => value / speed) as unknown as Vec3 } }
      : {}),
    ...(alpha.some((value) => value !== 0) ? { angular: { alpha: alpha.map((value) => value * factor) as unknown as Vec3, point } } : {}),
  };
}

const centroidCache = new WeakMap<DeckContext['mesh'], readonly (readonly [elementId: number, centroid: Vec3])[]>();

/** Centroid (mean of the element's nodes, exact for linear and quadratic tetrahedra) of every element, in element order. */
function elementCentroids(ctx: DeckContext): readonly (readonly [elementId: number, centroid: Vec3])[] {
  const cached = centroidCache.get(ctx.mesh);
  if (cached !== undefined) return cached;
  const coordinates = new Map(ctx.mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]] as const]));
  const out: [number, Vec3][] = [];
  for (const block of ctx.mesh.blocks)
    for (const element of block.elements) {
      const sum: [number, number, number] = [0, 0, 0];
      let count = 0;
      for (const nodeId of element.slice(1)) {
        const at = coordinates.get(nodeId);
        if (at === undefined) continue;
        sum[0] += at[0];
        sum[1] += at[1];
        sum[2] += at[2];
        count += 1;
      }
      if (count > 0) out.push([element[0] ?? 0, [sum[0] / count, sum[1] / count, sum[2] / count]]);
    }
  centroidCache.set(ctx.mesh, out);
  return out;
}

/** A rotation term whose largest acceleration over the part is at most this fraction of the uniform field is numerical noise of the flown state. */
const NEGLIGIBLE_ROTATION = 1e-9;
/**
 * Most elements with their own `GRAV` line: CalculiX 2.21 sizes its body-load index with the product of the body-load count and the element
 * count in 32-bit integers (`u_calloc ipobody`, a negative size at 121 685 elements), so a per-element field beyond this is refused, not written.
 */
const MAX_PER_ELEMENT_BODY_LOADS = 30_000;

/** Largest distance (analysis length) from `point` to an element centroid. */
function reachFrom(centroids: readonly (readonly [number, Vec3])[], point: Vec3): number {
  let reach = 0;
  for (const [, centroid] of centroids)
    reach = Math.max(reach, Math.hypot(centroid[0] - point[0], centroid[1] - point[1], centroid[2] - point[2]));
  return reach;
}

/**
 * `*DLOAD` data lines of the inertial terms of a step. Without angular acceleration: the uniform field is the caller's `EALL, GRAV` line, only
 * the `CENTRIF` line is added here. With it the field is not uniform (CalculiX has no body-force field): one `GRAV` line per element with the
 * field of its centroid, `gravity - alpha x (centroid - O)`, replaces the uniform line (`perElement` true).
 * @param keepZero nonlinear steps restate loads with OP=MOD: an element whose field is zero still gets `GRAV, 0` so an earlier value is replaced, not kept
 * @invariant at most one inertial load per step (the caller refuses more: CENTRIF takes one axis, and a second GRAV line of an element would replace the first)
 * @invariant deck size with angular acceleration: one line of about 60 bytes per element
 * @invariant a rotation term below NEGLIGIBLE_ROTATION x |gravity| at the farthest centroid is omitted and named in a `**` comment (a flown hover carries ~1e-8 rad/s^2 of noise)
 * @failure a real angular-acceleration field on more than MAX_PER_ELEMENT_BODY_LOADS elements -> FLL_INERTIAL_FIELD_TOO_LARGE
 */
export function inertialDloadLines(
  ctx: DeckContext,
  gravity: readonly number[],
  terms: InertialTerms,
  keepZero = false,
): { readonly lines: string[]; readonly perElement: boolean } | DeckRefusal {
  const lines: string[] = [];
  const fieldScale = Math.hypot(component(gravity, 0), component(gravity, 1), component(gravity, 2));
  const negligible = (acceleration: number): boolean => fieldScale > 0 && acceleration <= NEGLIGIBLE_ROTATION * fieldScale;
  const centroids = terms.angular.length > 0 || terms.centrifugal.length > 0 ? elementCentroids(ctx) : [];
  const significantAngular = terms.angular.filter(
    ({ alpha, point }) => !negligible(Math.hypot(alpha[0], alpha[1], alpha[2]) * reachFrom(centroids, point)),
  );
  if (significantAngular.length < terms.angular.length)
    lines.push(
      `** angular acceleration negligible (< ${NEGLIGIBLE_ROTATION} of the ${num(fieldScale)} field at the farthest element): omitted, uniform field`,
    );
  const candidate = terms.centrifugal[0];
  const centrifugal =
    candidate !== undefined && negligible(candidate.omegaSquared * reachFrom(centroids, candidate.point)) ? undefined : candidate;
  if (candidate !== undefined && centrifugal === undefined)
    lines.push(
      `** angular velocity negligible (< ${NEGLIGIBLE_ROTATION} of the ${num(fieldScale)} field at the farthest element): CENTRIF omitted`,
    );
  if (significantAngular.length > 0 && centroids.length > MAX_PER_ELEMENT_BODY_LOADS)
    return {
      code: 'FLL_INERTIAL_FIELD_TOO_LARGE',
      message: `the angular acceleration needs one GRAV line per element and the mesh has ${centroids.length} elements: CalculiX 2.21 overflows its body-load index above about ${MAX_PER_ELEMENT_BODY_LOADS}; coarsen the mesh or export the instant without angular acceleration (state)`,
    };
  if (significantAngular.length > 0) {
    for (const [elementId, centroid] of centroids) {
      const field: [number, number, number] = [component(gravity, 0), component(gravity, 1), component(gravity, 2)];
      for (const { alpha, point } of significantAngular) {
        const moment = cross(alpha, [centroid[0] - point[0], centroid[1] - point[1], centroid[2] - point[2]]);
        field[0] -= moment[0];
        field[1] -= moment[1];
        field[2] -= moment[2];
      }
      const magnitude = Math.hypot(field[0], field[1], field[2]);
      if (magnitude > 0)
        lines.push(`${elementId}, GRAV, ${num(magnitude)}, ${field.map((component) => num(component / magnitude)).join(', ')}`);
      else if (keepZero) lines.push(`${elementId}, GRAV, 0, 0, 0, 1`);
    }
  }
  if (centrifugal !== undefined)
    lines.push(`${ALL_ELEMENTS}, CENTRIF, ${row(centrifugal.omegaSquared, ...centrifugal.point, ...centrifugal.axis)}`);
  return { lines, perElement: significantAngular.length > 0 };
}
