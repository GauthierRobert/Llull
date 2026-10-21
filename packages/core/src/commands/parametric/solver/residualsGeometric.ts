import type { EntityRef } from '../../../model/types';
import { cross2, dot2 } from '../../../lib/vec2';
import { at } from './linalg';
import { directionOf, pointOf, subKindOf, type Pt } from './layout';
import {
  build,
  circleFn,
  fail,
  isLineForm,
  lineFn,
  lineOffset,
  pointFn,
  type CompileContext,
  type CompileOutcome,
  type LineFn,
  type PointFn,
} from './compileContext';

const missing = (kind: string, what: string): CompileOutcome => fail(`'${kind}' needs ${what}`);

/** The two points a point-pair kind relates: the endpoints of the line in line form, else the `a` and `b` references. */
function pointPair(ctx: CompileContext): [PointFn, PointFn] | null {
  const { a, b } = ctx.constraint;
  if (isLineForm(ctx)) {
    const start = pointFn(ctx, { entityId: a.entityId, kind: 'start' });
    const end = pointFn(ctx, { entityId: a.entityId, kind: 'end' });
    return start && end ? [start, end] : null;
  }
  const pa = pointFn(ctx, a);
  const pb = pointFn(ctx, b);
  return pa && pb ? [pa, pb] : null;
}

export function compileCoincident(ctx: CompileContext): CompileOutcome {
  const pair = pointPair(ctx);
  if (!pair) return missing('coincident', 'two existing entities');
  const [pa, pb] = pair;
  return build(ctx, 2, (x, out, row) => {
    const p = pa(x);
    const q = pb(x);
    out[row] = p[0] - q[0];
    out[row + 1] = p[1] - q[1];
  });
}

/** horizontal: equal y; vertical: equal x. Line form (one line) or point form (two points). */
export function compileAxisAligned(ctx: CompileContext, axis: 0 | 1): CompileOutcome {
  const { a, b } = ctx.constraint;
  const sameEntity = a.entityId === b.entityId && subKindOf(a) === undefined && subKindOf(b) === undefined;
  const pair = sameEntity && !isLineForm(ctx) ? null : pointPair(ctx);
  if (!pair) return missing(ctx.constraint.kind, 'a line (a = b = line id, no kind) or two points');
  const [pa, pb] = pair;
  return build(ctx, 1, (x, out, row) => {
    out[row] = pa(x)[axis] - pb(x)[axis];
  });
}

function twoLines(ctx: CompileContext): [LineFn, LineFn] | null {
  const la = lineFn(ctx, ctx.constraint.a);
  const lb = lineFn(ctx, ctx.constraint.b);
  return la && lb ? [la, lb] : null;
}

/** parallel (sine of the angle) and perpendicular (cosine of the angle) between two lines; direction sense is free. */
export function compileDirectionRelation(ctx: CompileContext, perpendicular: boolean): CompileOutcome {
  const lines = twoLines(ctx);
  if (!lines) return missing(ctx.constraint.kind, 'two lines');
  const [la, lb] = lines;
  return build(ctx, 1, (x, out, row) => {
    const da = directionOf(la(x));
    const db = directionOf(lb(x));
    out[row] = perpendicular ? dot2(da, db) : cross2(da, db);
  });
}

export function compileEqual(ctx: CompileContext): CompileOutcome {
  const lines = twoLines(ctx);
  if (lines) {
    const [la, lb] = lines;
    const length = (f: typeof la, x: Float64Array): number => {
      const { start, end } = f(x);
      return Math.hypot(end[0] - start[0], end[1] - start[1]);
    };
    return build(ctx, 1, (x, out, row) => {
      out[row] = length(la, x) - length(lb, x);
    });
  }
  const ca = circleFn(ctx, ctx.constraint.a);
  const cb = circleFn(ctx, ctx.constraint.b);
  if (!ca || !cb) return missing('equal', 'two lines (equal length) or two circles/arcs (equal radius)');
  return build(ctx, 1, (x, out, row) => {
    out[row] = ca(x).radius - cb(x).radius;
  });
}

export function compileConcentric(ctx: CompileContext): CompileOutcome {
  const ca = circleFn(ctx, ctx.constraint.a);
  const cb = circleFn(ctx, ctx.constraint.b);
  if (!ca || !cb) return missing('concentric', 'two circles or arcs');
  return build(ctx, 2, (x, out, row) => {
    out[row] = ca(x).center[0] - cb(x).center[0];
    out[row + 1] = ca(x).center[1] - cb(x).center[1];
  });
}

/** Both endpoints of line b lie on the infinite line a. */
export function compileCollinear(ctx: CompileContext): CompileOutcome {
  const lines = twoLines(ctx);
  if (!lines) return missing('collinear', 'two lines');
  const [la, lb] = lines;
  return build(ctx, 2, (x, out, row) => {
    const reference = la(x);
    const dir = directionOf(reference);
    const other = lb(x);
    out[row] = lineOffset(reference.start, dir, other.start);
    out[row + 1] = lineOffset(reference.start, dir, other.end);
  });
}

/** Point a is the midpoint of line b. */
export function compileMidpoint(ctx: CompileContext): CompileOutcome {
  const pa = pointFn(ctx, ctx.constraint.a);
  const lb = lineFn(ctx, ctx.constraint.b);
  if (!pa || !lb) return missing('midpoint', 'a = a point reference and b = a line');
  return build(ctx, 2, (x, out, row) => {
    const p = pa(x);
    const { start, end } = lb(x);
    out[row] = p[0] - (start[0] + end[0]) / 2;
    out[row + 1] = p[1] - (start[1] + end[1]) / 2;
  });
}

/** Points a and b mirror each other across `axis`: a line (no kind) or a point (a named sub-point). */
export function compileSymmetric(ctx: CompileContext): CompileOutcome {
  const { constraint } = ctx;
  if (!('axis' in constraint)) return fail("'symmetric' needs an 'axis' reference (a line, or a point with a sub-point kind)");
  const pa = pointFn(ctx, constraint.a);
  const pb = pointFn(ctx, constraint.b);
  if (!pa || !pb) return missing('symmetric', 'two existing point references');
  const axisLine = subKindOf(constraint.axis) === undefined ? lineFn(ctx, constraint.axis) : null;
  if (axisLine) {
    return build(ctx, 2, (x, out, row) => {
      const p = pa(x);
      const q = pb(x);
      const axis = axisLine(x);
      const dir = directionOf(axis);
      out[row] = lineOffset(axis.start, dir, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
      out[row + 1] = dot2([q[0] - p[0], q[1] - p[1]], dir);
    });
  }
  const center = pointFn(ctx, constraint.axis);
  if (!center) return fail("'symmetric' axis must be an existing line (no kind) or point (kind start|end|center|mid)");
  return build(ctx, 2, (x, out, row) => {
    const p = pa(x);
    const q = pb(x);
    const c = center(x);
    out[row] = (p[0] + q[0]) / 2 - c[0];
    out[row + 1] = (p[1] + q[1]) / 2 - c[1];
  });
}

/** Keep a point (sub-point or position) where it is now, or a whole curve (curve reference without a sub-point). */
export function compileFix(ctx: CompileContext): CompileOutcome {
  const ref: EntityRef = ctx.constraint.a;
  const block = ctx.layout.blocks.get(ref.entityId);
  if (!block) return missing('fix', 'an existing entity');
  const x0 = ctx.layout.x0;
  if (block.kind !== 'point' && subKindOf(ref) === undefined) {
    const indices = [
      ...Array.from({ length: block.size }, (_, k) => block.offset + k),
      ...(block.posOffset >= 0 ? [block.posOffset, block.posOffset + 1] : []),
    ];
    return build(ctx, indices.length, (x, out, row) => {
      indices.forEach((index, k) => {
        out[row + k] = at(x, index) - at(x0, index);
      });
    });
  }
  const anchor: Pt = pointOf(ctx.layout, x0, ref) ?? [0, 0];
  const point = pointFn(ctx, ref);
  if (!point) return missing('fix', 'an existing entity');
  return build(ctx, 2, (x, out, row) => {
    const p = point(x);
    out[row] = p[0] - anchor[0];
    out[row + 1] = p[1] - anchor[1];
  });
}

/** Point a lies on curve b: the infinite line, or the full circle of a circle/arc. */
export function compilePointOnCurve(ctx: CompileContext): CompileOutcome {
  const pa = pointFn(ctx, ctx.constraint.a);
  if (!pa) return missing('point_on_curve', 'a = an existing point reference');
  const line = lineFn(ctx, ctx.constraint.b);
  if (line) {
    return build(ctx, 1, (x, out, row) => {
      const l = line(x);
      out[row] = lineOffset(l.start, directionOf(l), pa(x));
    });
  }
  const circle = circleFn(ctx, ctx.constraint.b);
  if (!circle) return missing('point_on_curve', 'b = a line, circle or arc');
  return build(ctx, 1, (x, out, row) => {
    const c = circle(x);
    const p = pa(x);
    out[row] = Math.hypot(p[0] - c.center[0], p[1] - c.center[1]) - c.radius;
  });
}
