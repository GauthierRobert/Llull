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

/** Centroid (mean of the element's nodes, exact for linear and quadratic tetrahedra) of every element, in element order. */
function elementCentroids(ctx: DeckContext): readonly (readonly [elementId: number, centroid: Vec3])[] {
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
  return out;
}

/**
 * `*DLOAD` data lines of the inertial terms of a step. Without angular acceleration: the uniform field is the caller's `EALL, GRAV` line, only
 * the `CENTRIF` line is added here. With it the field is not uniform (CalculiX has no body-force field): one `GRAV` line per element with the
 * field of its centroid, `gravity - alpha x (centroid - O)`, replaces the uniform line (`perElement` true).
 * @failure more than one rotation about different axes in one step -> FEA_LOAD_INVALID (CENTRIF takes one axis per element)
 */
export function inertialDloadLines(
  ctx: DeckContext,
  gravity: Vec3,
  terms: InertialTerms,
): { readonly lines: string[]; readonly perElement: boolean } | DeckRefusal {
  if (terms.centrifugal.length > 1)
    return {
      code: 'FEA_LOAD_INVALID',
      message: 'one load case carries more than one rotating inertial load: CalculiX CENTRIF takes one axis per step',
    };
  const lines: string[] = [];
  const centrifugal = terms.centrifugal[0];
  if (terms.angular.length > 0) {
    for (const [elementId, centroid] of elementCentroids(ctx)) {
      const field: [number, number, number] = [...gravity];
      for (const { alpha, point } of terms.angular) {
        const moment = cross(alpha, [centroid[0] - point[0], centroid[1] - point[1], centroid[2] - point[2]]);
        field[0] -= moment[0];
        field[1] -= moment[1];
        field[2] -= moment[2];
      }
      const magnitude = Math.hypot(field[0], field[1], field[2]);
      if (magnitude > 0)
        lines.push(`${elementId}, GRAV, ${num(magnitude)}, ${field.map((component) => num(component / magnitude)).join(', ')}`);
    }
  }
  if (centrifugal !== undefined)
    lines.push(`${ALL_ELEMENTS}, CENTRIF, ${row(centrifugal.omegaSquared, ...centrifugal.point, ...centrifugal.axis)}`);
  return { lines, perElement: terms.angular.length > 0 };
}
