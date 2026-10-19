import type { DimensionConstraintKind } from '../../../model/types';
import { positiveSweep, wrapSignedAngle } from '../../../lib/angle';
import { at } from './linalg';
import { directionOf, type Pt } from './layout';
import {
  build,
  circleFn,
  cross,
  dot,
  fail,
  isLineForm,
  lineFn,
  lineOffset,
  pointFn,
  signOf,
  type CompileContext,
  type CompileOutcome,
} from './compileContext';

const distance = (p: Pt, q: Pt): number => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** Point-to-point (a, b) or, for the line form of `aligned`, the length of the line. */
function compilePointDistance(ctx: CompileContext, target: number, allowLineForm: boolean): CompileOutcome {
  const { a, b } = ctx.constraint;
  if (allowLineForm && isLineForm(ctx)) {
    const line = lineFn(ctx, a);
    if (line)
      return build(ctx, 1, (x, out, row) => {
        const { start, end } = line(x);
        out[row] = distance(start, end) - target;
      });
  }
  const pa = pointFn(ctx, a);
  const pb = pointFn(ctx, b);
  if (!pa || !pb) return fail(`'${ctx.constraint.kind}' needs two existing point references (a and b)`);
  return build(ctx, 1, (x, out, row) => {
    out[row] = distance(pa(x), pb(x)) - target;
  });
}

/** Signed x (axis 0) or y (axis 1) offset b − a held at ±|target|, on the side the sketch is on now. */
function compileAxisDistance(ctx: CompileContext, target: number, axis: 0 | 1): CompileOutcome {
  const pa = pointFn(ctx, ctx.constraint.a);
  const pb = pointFn(ctx, ctx.constraint.b);
  if (!pa || !pb) return fail(`'${ctx.constraint.kind}' needs two existing point references (a and b)`);
  const side = signOf(pb(ctx.layout.x0)[axis] - pa(ctx.layout.x0)[axis]);
  return build(ctx, 1, (x, out, row) => {
    out[row] = pb(x)[axis] - pa(x)[axis] - side * Math.abs(target);
  });
}

function compileAngle(ctx: CompileContext, target: number): CompileOutcome {
  const la = lineFn(ctx, ctx.constraint.a);
  const lb = lineFn(ctx, ctx.constraint.b);
  if (!la || !lb) return fail("'angle' needs two lines");
  return build(ctx, 1, (x, out, row) => {
    const da = directionOf(la(x));
    const db = directionOf(lb(x));
    out[row] = wrapSignedAngle(Math.atan2(cross(da, db), dot(da, db)) - target);
  });
}

function compilePointToLine(ctx: CompileContext, target: number): CompileOutcome {
  const pa = pointFn(ctx, ctx.constraint.a);
  const line = lineFn(ctx, ctx.constraint.b);
  if (!pa || !line) return fail("'point_to_line' needs a = a point reference and b = a line");
  const offsetAt = (x: Float64Array): number => {
    const l = line(x);
    return lineOffset(l.start, directionOf(l), pa(x));
  };
  const side = signOf(offsetAt(ctx.layout.x0));
  return build(ctx, 1, (x, out, row) => {
    out[row] = offsetAt(x) - side * Math.abs(target);
  });
}

/** Radius-based kinds on a circle/arc `a`. */
function compileRadial(ctx: CompileContext, target: number, factor: number): CompileOutcome {
  const circle = circleFn(ctx, ctx.constraint.a);
  if (!circle) return fail(`'${ctx.constraint.kind}' needs a circle or arc`);
  if (target <= 0) return fail(`'${ctx.constraint.kind}' value must be > 0`);
  return build(ctx, 1, (x, out, row) => {
    out[row] = factor * circle(x).radius - target;
  });
}

/** arc_sweep: end − start angle; arc_length: radius × sweep. The 2π turns of the current arc are kept. */
function compileArcExtent(ctx: CompileContext, target: number, length: boolean): CompileOutcome {
  const block = ctx.layout.blocks.get(ctx.constraint.a.entityId);
  if (block?.kind !== 'arc') return fail(`'${ctx.constraint.kind}' needs an arc`);
  const { offset } = block;
  const x0 = ctx.layout.x0;
  const turns = positiveSweep(at(x0, offset + 4) - at(x0, offset + 3)) - (at(x0, offset + 4) - at(x0, offset + 3));
  if (target <= 0) return fail(`'${ctx.constraint.kind}' value must be > 0`);
  return build(ctx, 1, (x, out, row) => {
    const sweep = at(x, offset + 4) - at(x, offset + 3) + turns;
    out[row] = length ? Math.abs(at(x, offset + 2)) * sweep - target : sweep - target;
  });
}

/** slot_length: distance between the cap centers of a slot (two circles/arcs a and b). */
function compileSlotLength(ctx: CompileContext, target: number): CompileOutcome {
  const ca = circleFn(ctx, ctx.constraint.a);
  const cb = circleFn(ctx, ctx.constraint.b);
  if (!ca || !cb) return fail("'slot_length' needs the two end-cap circles/arcs as a and b");
  return build(ctx, 1, (x, out, row) => {
    out[row] = distance(ca(x).center, cb(x).center) - target;
  });
}

export function compileDimension(ctx: CompileContext, kind: DimensionConstraintKind, target: number): CompileOutcome {
  switch (kind) {
    case 'distance':
      return compilePointDistance(ctx, target, false);
    case 'aligned':
      return compilePointDistance(ctx, target, true);
    case 'horizontal_distance':
      return compileAxisDistance(ctx, target, 0);
    case 'vertical_distance':
      return compileAxisDistance(ctx, target, 1);
    case 'angle':
      return compileAngle(ctx, target);
    case 'point_to_line':
      return compilePointToLine(ctx, target);
    case 'radius':
      return compileRadial(ctx, target, 1);
    case 'diameter':
      return compileRadial(ctx, target, 2);
    case 'arc_sweep':
      return compileArcExtent(ctx, target, false);
    case 'arc_length':
      return compileArcExtent(ctx, target, true);
    case 'slot_length':
      return compileSlotLength(ctx, target);
  }
}
