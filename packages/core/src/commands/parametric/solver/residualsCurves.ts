import type { EntityRef } from '../../../model/types';
import { at } from './linalg';
import { directionOf, subKindOf, type Pt } from './layout';
import {
  build,
  circleFn,
  cross,
  fail,
  lineFn,
  lineOffset,
  pointFn,
  signOf,
  type CompileContext,
  type CompileOutcome,
} from './compileContext';

const distance = (p: Pt, q: Pt): number => Math.hypot(p[0] - q[0], p[1] - q[1]);

/**
 * Line–circle/arc: the center is one radius from the infinite line, on the side it is on now. Circle/arc–circle/arc: external tangency
 * when the centers are currently at least `max(r1, r2)` apart, else internal; the branch is kept.
 */
export function compileTangent(ctx: CompileContext): CompileOutcome {
  const { a, b } = ctx.constraint;
  const x0 = ctx.layout.x0;
  const ca = circleFn(ctx, a);
  const cb = circleFn(ctx, b);
  if (ca && cb) {
    const first = ca(x0);
    const second = cb(x0);
    const external = distance(first.center, second.center) >= Math.max(first.radius, second.radius);
    return build(ctx, 1, (x, out, row) => {
      const p = ca(x);
      const q = cb(x);
      out[row] = distance(p.center, q.center) - (external ? p.radius + q.radius : Math.abs(p.radius - q.radius));
    });
  }
  const line = lineFn(ctx, a) ?? lineFn(ctx, b);
  const circle = ca ?? cb;
  if (!line || !circle) return fail("'tangent' needs a line and a circle/arc, or two circles/arcs");
  const offsetAt = (x: Float64Array): number => {
    const l = line(x);
    return lineOffset(l.start, directionOf(l), circle(x).center);
  };
  const side = signOf(offsetAt(x0));
  return build(ctx, 1, (x, out, row) => {
    out[row] = side * offsetAt(x) - circle(x).radius;
  });
}

interface Joint {
  /** Unit tangent in the common direction of travel a → joint → b. */
  readonly tangent: (x: Float64Array) => Pt;
  /** +1 when the curve is traversed forward (CCW for arcs) along that travel, else −1. */
  readonly orientation: 1 | -1;
  readonly radius: ((x: Float64Array) => number) | null;
}

/** `arriving`: the curve is entered at the joint (a); otherwise it is left at the joint (b). */
function jointOf(ctx: CompileContext, ref: EntityRef, arriving: boolean): Joint | null {
  const end = subKindOf(ref);
  if (end !== 'start' && end !== 'end') return null;
  const forward = arriving ? end === 'end' : end === 'start';
  const orientation = forward ? 1 : -1;
  const block = ctx.layout.blocks.get(ref.entityId);
  const line = lineFn(ctx, ref);
  if (line) return { tangent: (x) => scale(directionOf(line(x)), orientation), orientation, radius: null };
  if (block?.kind !== 'arc' || !circleFn(ctx, ref)) return null;
  const angleIndex = block.offset + (end === 'start' ? 3 : 4);
  const radiusIndex = block.offset + 2;
  return {
    tangent: (x) => scale([-Math.sin(at(x, angleIndex)), Math.cos(at(x, angleIndex))], orientation),
    orientation,
    radius: (x) => Math.abs(at(x, radiusIndex)),
  };
}

const scale = (v: Pt, factor: number): Pt => [v[0] * factor, v[1] * factor];

/**
 * Continuity at the shared end of curve a (arriving) and curve b (leaving): coincident ends (2 rows), parallel tangents (1 row, G1) and,
 * for two arcs, equal signed curvature (1 row, G2). A line has zero curvature, so line–arc reaches G1 only: that jump is geometric.
 */
export function compileCurvature(ctx: CompileContext): CompileOutcome {
  const { a, b } = ctx.constraint;
  const ja = jointOf(ctx, a, true);
  const jb = jointOf(ctx, b, false);
  const pa = pointFn(ctx, a);
  const pb = pointFn(ctx, b);
  if (!ja || !jb || !pa || !pb)
    return fail("'curvature' needs a and b to be line/arc ends: { entityId, kind: 'start' | 'end' } (splines are not supported)");
  const { radius: radiusA } = ja;
  const { radius: radiusB } = jb;
  const rows = radiusA && radiusB ? 4 : 3;
  return build(ctx, rows, (x, out, row) => {
    const p = pa(x);
    const q = pb(x);
    out[row] = p[0] - q[0];
    out[row + 1] = p[1] - q[1];
    out[row + 2] = cross(ja.tangent(x), jb.tangent(x));
    if (radiusA && radiusB) out[row + 3] = ja.orientation * radiusB(x) - jb.orientation * radiusA(x);
  });
}
