/**
 * The orthogonal stretch walk (02 RTE §5.7) on the points of one run: given the displacement some points must take, find how every point of intersection
 * moves so that each leg keeps its direction and only its length changes. A displacement is absorbed by the legs parallel to it; what a leg cannot absorb
 * is carried, perpendicular to it, to the next point of intersection.
 * @invariant for the returned displacements d: (d[i+1] - d[i]) is parallel to leg i, so every leg keeps its direction (and slope); deterministic
 */

import type { Vec3 } from '@core/model/vectors';
import { add3, dot3, len3, scale3, sub3 } from '@lib/vec3';

export type Disp = Vec3;
const ZERO: Disp = [0, 0, 0];

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

/**
 * Displacements of the m + 1 points of a chain of m legs with directions `dirs`.
 * @param first displacement the first point must take, or null when that point is free (an open end follows what the legs need)
 * @param last displacement the last point must take, or null when free
 * @failure the chain cannot take both displacements with each leg keeping its direction -> the remainder that reaches a pinned end
 *
 * Both pinned: walk forward from `first` (each point takes what the leg before did not absorb), then walk back from the end with what is still missing.
 * Only the last pinned: walk back from it (the §5.7 walk); only the first: forward; neither: nothing moves.
 */
export function walkChain(dirs: readonly Vec3[], first: Disp | null, last: Disp | null, eps: number): WalkOk | WalkFailure {
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
