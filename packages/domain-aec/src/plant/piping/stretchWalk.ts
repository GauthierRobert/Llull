/**
 * The orthogonal stretch walk (02 RTE §5.7) on the points of one run: given the displacement some points must take, find how every point of intersection
 * moves so that each leg keeps its direction and only its length changes. A displacement is absorbed by the legs parallel to it; what a leg cannot absorb
 * is carried, perpendicular to it, to the next point of intersection.
 * @invariant for the returned displacements d: (d[i+1] - d[i]) is parallel to leg i, so every leg keeps its direction (and slope); deterministic
 */

import type { Vec3 } from '@core/model/vectors';
import { add3, cross3, dot3, len3, scale3, sub3 } from '@lib/vec3';

export type Disp = Vec3;
const ZERO: Disp = [0, 0, 0];
/** Sideways change of a leg, mm, below which a walk counts as keeping its directions (rounding of the displacements). */
const EXACT = 1e-9;

/** `v` without its component along the unit vector `u`; exact zero when what is left is below `eps`. */
function perp(v: Disp, u: Vec3, eps: number): Disp {
  const rest = sub3(v, scale3(u, dot3(v, u)));
  return len3(rest) <= eps ? ZERO : rest;
}

export interface WalkFailure {
  readonly ok: false;
  /** Which end of the chain the unabsorbed remainder reaches. */
  readonly at: 'first' | 'last';
  readonly remainder: Vec3;
}

export interface WalkOk {
  readonly ok: true;
  readonly displacements: Disp[];
}

/** Two unit vectors perpendicular to the unit `u` (and to each other). */
function perpendicularPair(u: Vec3): [Vec3, Vec3] {
  const weakest = Math.abs(u[0]) <= Math.abs(u[1]) && Math.abs(u[0]) <= Math.abs(u[2]) ? 0 : Math.abs(u[1]) <= Math.abs(u[2]) ? 1 : 2;
  const axis: Vec3 = weakest === 0 ? [1, 0, 0] : weakest === 1 ? [0, 1, 0] : [0, 0, 1];
  const first = cross3(u, axis);
  const e1 = scale3(first, 1 / len3(first));
  return [e1, cross3(u, e1)];
}

/**
 * The smallest displacements (least squares over all points) that keep every leg's direction, honour the pinned ends and leave the free ends free: the
 * general form of the walk, which also covers legs that are not parallel to the move (a sloped leg takes a horizontal move by changing its plan length
 * and its drop together, the slope being its direction). Gram-Schmidt on the constraint rows: dependent rows must agree, else there is no solution.
 * @returns the displacements, or null when the pins cannot be met with every leg keeping its direction
 */
function solveKeepingDirections(dirs: readonly Vec3[], first: Disp | null, last: Disp | null, eps: number): Disp[] | null {
  const m = dirs.length;
  const columns = 3 * (m + 1);
  const rows: Array<{ row: number[]; rhs: number }> = [];
  const pin = (point: number, value: Disp): void => {
    for (let axis = 0; axis < 3; axis++) {
      const row = new Array<number>(columns).fill(0);
      row[3 * point + axis] = 1;
      rows.push({ row, rhs: value[axis] as number });
    }
  };
  dirs.forEach((u, leg) => {
    for (const e of perpendicularPair(u)) {
      const row = new Array<number>(columns).fill(0);
      for (let axis = 0; axis < 3; axis++) {
        row[3 * (leg + 1) + axis] = e[axis] as number;
        row[3 * leg + axis] = -(e[axis] as number);
      }
      rows.push({ row, rhs: 0 });
    }
  });
  if (first !== null) pin(0, first);
  if (last !== null) pin(m, last);
  const basis: Array<{ q: number[]; c: number }> = [];
  for (const { row, rhs } of rows) {
    const v = [...row];
    let reduced = rhs;
    for (const { q, c } of basis) {
      const dot = q.reduce((sum, value, index) => sum + value * (v[index] as number), 0);
      reduced -= dot * c;
      for (let index = 0; index < columns; index++) v[index] = (v[index] as number) - dot * (q[index] as number);
    }
    const norm = Math.hypot(...v);
    if (norm > 1e-9) basis.push({ q: v.map((value) => value / norm), c: reduced / norm });
    else if (Math.abs(reduced) > 10 * eps) return null;
  }
  const x = new Array<number>(columns).fill(0);
  for (const { q, c } of basis) for (let index = 0; index < columns; index++) x[index] = (x[index] as number) + c * (q[index] as number);
  return Array.from(
    { length: m + 1 },
    (_, point): Disp => [x[3 * point] as number, x[3 * point + 1] as number, x[3 * point + 2] as number],
  );
}

/**
 * Displacements of the m + 1 points of a chain of m legs with directions `dirs`.
 * @param first displacement the first point must take, or null when that point is free (an open end follows what the legs need)
 * @param last displacement the last point must take, or null when free
 * @failure the chain cannot take both displacements with each leg keeping its direction -> the remainder that reaches a pinned end
 *
 * When the walk fails (a leg is not parallel to what it must absorb, as a sloped leg is not parallel to a horizontal move) the general least-squares
 * solution that keeps every leg direction is tried; it fails too only when no solution exists.
 *
 * Both pinned: walk forward from `first` (each point takes what the leg before did not absorb), then walk back from the end with what is still missing.
 * Only the last pinned: walk back from it (the §5.7 walk); only the first: forward; neither: nothing moves.
 */
export function walkChain(dirs: readonly Vec3[], first: Disp | null, last: Disp | null, eps: number): WalkOk | WalkFailure {
  const walked = orthogonalWalk(dirs, first, last, eps);
  // The walk drops remainders below eps; for a leg that is not parallel to what it carries that leaves the leg slightly off its direction, so it is exact only
  // when every leg keeps its direction to rounding: otherwise the general solution is the answer.
  if (walked.ok && directionError(walked.displacements, dirs) <= EXACT) return walked;
  const general = solveKeepingDirections(dirs, first, last, eps);
  if (general === null) return walked;
  // The pins are exact by definition: keep them as given, not as the solver rounded them.
  const displacements = general.map((d, point) =>
    point === 0 && first !== null ? first : point === dirs.length && last !== null ? last : len3(d) <= eps ? ZERO : d,
  );
  return { ok: true, displacements };
}

/** Largest sideways change of a leg between two consecutive displacements (zero when every leg keeps its direction). */
function directionError(displacements: readonly Disp[], dirs: readonly Vec3[]): number {
  return dirs.reduce(
    (worst, u, leg) => Math.max(worst, len3(perp(sub3(displacements[leg + 1] as Disp, displacements[leg] as Disp), u, 0))),
    0,
  );
}

function orthogonalWalk(dirs: readonly Vec3[], first: Disp | null, last: Disp | null, eps: number): WalkOk | WalkFailure {
  const m = dirs.length;
  const d: Disp[] = Array.from({ length: m + 1 }, () => ZERO);
  if (first !== null) {
    d[0] = first;
    for (let i = 0; i < m; i++) d[i + 1] = perp(d[i] as Disp, dirs[i] as Vec3, eps);
  }
  if (last !== null) {
    const missing = sub3(last, d[m] as Disp);
    if (len3(missing) > eps) {
      let carry: Disp = missing;
      d[m] = add3(d[m] as Disp, carry);
      for (let i = m - 1; i >= 0; i--) {
        carry = perp(carry, dirs[i] as Vec3, eps);
        d[i] = add3(d[i] as Disp, carry);
      }
      if (first !== null && len3(carry) > eps) return { ok: false, at: 'first', remainder: carry };
    }
  }
  return { ok: true, displacements: d };
}

export interface InjectionFailure extends WalkFailure {
  /** `before`: the legs between the run start and the moved point; `after`: between the moved point and the run end. */
  readonly side: 'before' | 'after';
}

/**
 * The walk of a whole run with the point `index` moved by `by`: the legs before it are one chain (start follows `startMove`), the legs after it another
 * (end follows `endMove`); null = that end is free. A failure says which side could not absorb the move and the remainder left over.
 */
export function walkWithInjection(
  dirs: readonly Vec3[],
  index: number,
  by: Disp,
  startMove: Disp | null,
  endMove: Disp | null,
  eps: number,
): WalkOk | InjectionFailure {
  const before = index === 0 ? null : walkChain(dirs.slice(0, index), startMove, by, eps);
  if (before !== null && !before.ok) return { ...before, side: 'before' };
  const after = index === dirs.length ? null : walkChain(dirs.slice(index), by, endMove, eps);
  if (after !== null && !after.ok) return { ...after, side: 'after' };
  const head = before === null ? [] : before.displacements;
  const tail = after === null ? [] : after.displacements.slice(before === null ? 0 : 1);
  return { ok: true, displacements: [...head, ...tail] };
}
