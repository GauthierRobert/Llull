/**
 * Rails (guide curves) of a sweep (TECHNICAL_SPEC 5.3): at every path station the rail point is where the rail crosses the plane through the
 * path point normal to the tangent; the section is mapped so its anchor points land on those rail points. One rail orients / scales / stretches
 * the section about the path point; two rails also place it (a similarity, or a stretch along the anchor line with `maintainHeight`).
 */

import type { SweepEntity, Vec2, Vec3 } from '../../model/types';
import type { SweepSection } from '../../model/sweepOrientation';
import { curveDerivatives, curveDomain } from '../../lib/nurbs/evaluate';
import { closestOnCurve } from '../../lib/nurbs/closest';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { dot3, len3, sub3 } from '../../lib/vec3';
import type { SweepFrame } from './frames';
import type { Affine2, SectionTransform } from './sectionTransform';

/** What the rails of a sweep depend on (a SweepEntity satisfies it). */
export type RailShape = Pick<SweepEntity, 'section' | 'stations' | 'rails' | 'guideMode' | 'maintainHeight' | 'anchors'>;

export interface RailIssue {
  readonly code: 'SWG_GUIDE_PLANE_NO_INTERSECTION' | 'SWG_GUIDE_ANCHOR_UNDEFINED' | 'SWG_LAW_NONPOSITIVE';
  readonly message: string;
  /** Path fraction of the first bad station, when the issue is positional. */
  readonly t?: number;
}

/** How far from the plane (relative to the rail size) a rail end may be and still count as lying in it: rails drawn to the end of a fitted spine. */
const END_TOLERANCE = 1e-5;
const NEWTON_STEPS = 24;
/** Largest rail-parameter jump (fraction of the domain) a continued Newton step may make between stations before the rail is rescanned. */
const MAX_JUMP = 0.12;

/** Plane-crossing function g(u) = (C(u) - P) . T and its derivative. */
function planeFunction(rail: NurbsCurveData, point: Vec3, tangent: Vec3): (u: number) => [number, number] {
  return (u) => {
    const [c, d] = curveDerivatives(rail, u, 1) as [Vec3, Vec3];
    return [dot3(sub3(c, point), tangent), dot3(d, tangent)];
  };
}

/** Root of g near `hint` by clamped Newton, or null when it does not converge close by. */
function continued(g: (u: number) => [number, number], hint: number, domain: readonly [number, number], scale: number): number | null {
  let u = hint;
  for (let step = 0; step < NEWTON_STEPS; step++) {
    const [value, slope] = g(u);
    if (Math.abs(value) <= 1e-13 * scale) return Math.abs(u - hint) <= MAX_JUMP * (domain[1] - domain[0]) ? u : null;
    if (!(Math.abs(slope) > 1e-14 * scale)) return null;
    u = Math.min(domain[1], Math.max(domain[0], u - value / slope));
  }
  return Math.abs(g(u)[0]) <= 1e-11 * scale && Math.abs(u - hint) <= MAX_JUMP * (domain[1] - domain[0]) ? u : null;
}

/** Every root of g on the rail (sign changes of a dense scan, refined by bisection and Newton), in increasing order. */
function scanRoots(g: (u: number) => [number, number], domain: readonly [number, number], samples: number, scale: number): number[] {
  const roots: number[] = [];
  let [u0, f0] = [domain[0], g(domain[0])[0]];
  if (Math.abs(f0) <= END_TOLERANCE * scale) roots.push(u0);
  for (let k = 1; k <= samples; k++) {
    const u1 = domain[0] + ((domain[1] - domain[0]) * k) / samples;
    const f1 = g(u1)[0];
    if (Math.abs(f1) <= END_TOLERANCE * scale && k === samples) roots.push(u1);
    else if (f0 * f1 < 0) {
      let [lo, hi, flo] = [u0, u1, f0];
      for (let step = 0; step < 70; step++) {
        const mid = (lo + hi) / 2;
        const fm = g(mid)[0];
        if (flo * fm <= 0) hi = mid;
        else [lo, flo] = [mid, fm];
      }
      roots.push((lo + hi) / 2);
    }
    [u0, f0] = [u1, f1];
  }
  return roots;
}

/**
 * Where `rail` crosses the plane through each frame point normal to its tangent, as rail parameters (continuation from the previous station).
 * @failure a plane that misses the rail -> SWG_GUIDE_PLANE_NO_INTERSECTION with the path fraction
 */
function crossingParameters(
  rail: NurbsCurveData,
  frames: readonly SweepFrame[],
  fractions: readonly number[],
  label: string,
): number[] | RailIssue {
  const domain = curveDomain(rail);
  const scale = Math.max(...rail.poles.map((p) => len3(sub3(p, rail.poles[0] as Vec3))), 1e-9);
  const samples = Math.max(256, 48 * (rail.knots.length - 1));
  const found: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i] as SweepFrame;
    const g = planeFunction(rail, frame.point, frame.tangent);
    const previous = found[i - 1];
    let root = previous === undefined ? null : continued(g, previous, domain, scale);
    if (root === null) {
      const roots = scanRoots(g, domain, samples, scale);
      const hint = previous ?? closestOnCurve(rail, frame.point).t;
      root = roots.length === 0 ? null : roots.reduce((best, r) => (Math.abs(r - hint) < Math.abs(best - hint) ? r : best));
    }
    if (root === null)
      return {
        code: 'SWG_GUIDE_PLANE_NO_INTERSECTION',
        message: `the section plane at path fraction ${(fractions[i] as number).toFixed(4)} misses ${label}; extend the rail over the whole path`,
        t: fractions[i] as number,
      };
    found.push(root);
  }
  return found;
}

/** Section-coordinate positions of the rail crossings at every frame: `result[j][i]` is the crossing of rail j in frame i, as an offset in (normal, binormal). */
export function railOffsets(
  rails: ReadonlyArray<{ readonly curve: NurbsCurveData }>,
  frames: readonly SweepFrame[],
  fractions: readonly number[],
): Vec2[][] | RailIssue {
  const offsets: Vec2[][] = [];
  for (const [index, rail] of rails.entries()) {
    const parameters = crossingParameters(rail.curve, frames, fractions, `rail ${index}`);
    if (!Array.isArray(parameters)) return parameters as RailIssue;
    offsets.push(
      (parameters as number[]).map((u, i): Vec2 => {
        const frame = frames[i] as SweepFrame;
        const [point] = curveDerivatives(rail.curve, u, 0) as [Vec3];
        const relative = sub3(point, frame.point);
        return [dot3(relative, frame.normal), dot3(relative, frame.binormal)];
      }),
    );
  }
  return offsets;
}

/** Outline of a section for anchor derivation: an exact circle, or a polyline (closed: the last point joins the first). */
export type Outline =
  | { readonly kind: 'circle'; readonly radius: number }
  | { readonly kind: 'polyline'; readonly points: readonly Vec2[]; readonly closed: boolean };

/** The outline of a sweep section. */
export const sectionOutline = (section: SweepSection): Outline =>
  section.shape === 'circle' ? { kind: 'circle', radius: section.radius } : { kind: 'polyline', points: section.profile, closed: true };

/** Nearest point of the outline to `q`, and its distance (a circle is exact; a polyline is measured edge by edge). */
function nearestOutline(outline: Outline, q: Vec2): { point: Vec2; distance: number } | null {
  if (outline.kind === 'circle') {
    const radius = Math.hypot(q[0], q[1]);
    if (radius < 1e-12) return null;
    return { point: [(q[0] / radius) * outline.radius, (q[1] / radius) * outline.radius], distance: Math.abs(radius - outline.radius) };
  }
  let best: { point: Vec2; distance: number } | null = null;
  const edges = outline.closed ? outline.points.length : outline.points.length - 1;
  for (let i = 0; i < edges; i++) {
    const a = outline.points[i] as Vec2;
    const b = outline.points[(i + 1) % outline.points.length] as Vec2;
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const span = dx * dx + dy * dy;
    const t = span > 0 ? Math.min(1, Math.max(0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / span)) : 0;
    const point: Vec2 = [a[0] + t * dx, a[1] + t * dy];
    const distance = Math.hypot(q[0] - point[0], q[1] - point[1]);
    if (best === null || distance < best.distance) best = { point, distance };
  }
  return best;
}

/**
 * Anchors when the caller gave none: the section outline point nearest each rail at the first station.
 * @failure a rail farther than `tolerance` from the outline (or through the path point) -> SWG_GUIDE_ANCHOR_UNDEFINED
 */
export function deriveAnchors(outline: Outline, first: readonly Vec2[], tolerance: number): Vec2[] | RailIssue {
  const anchors: Vec2[] = [];
  for (const [index, q] of first.entries()) {
    const nearest = nearestOutline(outline, q);
    if (nearest === null || nearest.distance > tolerance)
      return {
        code: 'SWG_GUIDE_ANCHOR_UNDEFINED',
        message: `rail ${index} is ${nearest === null ? 'through the path point' : `${nearest.distance.toExponential(2)} away from the section outline (tolerance ${tolerance.toExponential(2)})`} at the start; give anchors`,
      };
    anchors.push(nearest.point);
  }
  return anchors;
}

/** `R(angle) * M0` with `M0` scaling by `along` along the unit `direction` and by `across` normal to it, then moved by `offset(R M0)`. */
function map(
  angle: number,
  along: number,
  across: number,
  direction: Vec2,
  offset: (m: readonly [number, number, number, number]) => Vec2,
): { affine: Affine2; scale: number } {
  const [ex, ey] = direction;
  const m0: [number, number, number, number] = [
    along * ex * ex + across * ey * ey,
    (along - across) * ex * ey,
    (along - across) * ex * ey,
    along * ey * ey + across * ex * ex,
  ];
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const m: [number, number, number, number] = [c * m0[0] - s * m0[2], c * m0[1] - s * m0[3], s * m0[0] + c * m0[2], s * m0[1] + c * m0[3]];
  const [dx, dy] = offset(m);
  return { affine: [m[0], m[1], m[2], m[3], dx, dy], scale: Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) };
}

const angleOf = (v: Vec2): number => Math.atan2(v[1], v[0]);
const norm2 = (v: Vec2): number => Math.hypot(v[0], v[1]);

function oneRail(mode: 'orient' | 'scale' | 'stretch', a: Vec2, q: Vec2): SectionTransform | RailIssue {
  if (norm2(a) < 1e-12)
    return { code: 'SWG_GUIDE_ANCHOR_UNDEFINED', message: 'the anchor of a single rail must not be the section origin' };
  const ratio = norm2(q) / norm2(a);
  if (!(ratio > 1e-9))
    return { code: 'SWG_LAW_NONPOSITIVE', message: 'the rail crosses the path point, which would scale the section to 0' };
  const angle = angleOf(q) - angleOf(a);
  const direction: Vec2 = [a[0] / norm2(a), a[1] / norm2(a)];
  const none = (): Vec2 => [0, 0];
  const made =
    mode === 'orient'
      ? map(angle, 1, 1, direction, none)
      : mode === 'scale'
        ? map(angle, ratio, ratio, direction, none)
        : map(angle, ratio, 1, direction, none);
  return { twist: angle, sx: made.scale, sy: made.scale, affine: made.affine };
}

function twoRails(
  mode: 'orient' | 'scale' | 'stretch',
  maintainHeight: boolean,
  a: readonly [Vec2, Vec2],
  q: readonly [Vec2, Vec2],
): SectionTransform | RailIssue {
  const v: Vec2 = [a[1][0] - a[0][0], a[1][1] - a[0][1]];
  const w: Vec2 = [q[1][0] - q[0][0], q[1][1] - q[0][1]];
  if (norm2(v) < 1e-12) return { code: 'SWG_GUIDE_ANCHOR_UNDEFINED', message: 'the two anchors coincide; give two distinct anchors' };
  if (!(norm2(w) > 1e-9))
    return { code: 'SWG_LAW_NONPOSITIVE', message: 'the two rails meet at a path station, which would scale the section to 0' };
  const ratio = norm2(w) / norm2(v);
  const angle = angleOf(w) - angleOf(v);
  const direction: Vec2 = [v[0] / norm2(v), v[1] / norm2(v)];
  const stretch = maintainHeight || mode === 'stretch';
  const made = map(angle, mode === 'orient' ? 1 : ratio, mode === 'orient' || stretch ? 1 : ratio, direction, (m) => [
    q[0][0] - (m[0] * a[0][0] + m[1] * a[0][1]),
    q[0][1] - (m[2] * a[0][0] + m[3] * a[0][1]),
  ]);
  return { twist: angle, sx: made.scale, sy: made.scale, affine: made.affine };
}

/**
 * Section transform at every frame that puts the anchors on the rail crossings.
 * @invariant the anchors of each rail map exactly onto its crossing at every station (two rails); a single rail pulls the anchor direction / distance
 * @failure a plane missing a rail -> SWG_GUIDE_PLANE_NO_INTERSECTION; anchors missing or degenerate -> SWG_GUIDE_ANCHOR_UNDEFINED; a rail through the path point -> SWG_LAW_NONPOSITIVE
 */
export function railTransforms(
  shape: RailShape,
  frames: readonly SweepFrame[],
  fractions: readonly number[],
): SectionTransform[] | RailIssue {
  const rails = shape.rails ?? [];
  const anchors = shape.anchors;
  if (anchors === undefined || anchors.length !== rails.length)
    return { code: 'SWG_GUIDE_ANCHOR_UNDEFINED', message: `give one anchor per rail (${rails.length}) in section coordinates` };
  const offsets = railOffsets(rails, frames, fractions);
  if (!Array.isArray(offsets)) return offsets as RailIssue;
  const mode = shape.guideMode ?? 'scale';
  const transforms: SectionTransform[] = [];
  for (let i = 0; i < frames.length; i++) {
    const made =
      rails.length === 1
        ? oneRail(mode, anchors[0] as Vec2, (offsets as Vec2[][])[0]?.[i] as Vec2)
        : twoRails(
            mode,
            shape.maintainHeight === true,
            [anchors[0] as Vec2, anchors[1] as Vec2],
            [(offsets as Vec2[][])[0]?.[i] as Vec2, (offsets as Vec2[][])[1]?.[i] as Vec2],
          );
    if ('code' in made) return { ...made, t: fractions[i] as number };
    transforms.push(made);
  }
  return transforms;
}
