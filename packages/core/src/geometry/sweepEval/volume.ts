/**
 * Closed-form volume of a sweep with a round section centred on the path (TECHNICAL_SPEC 5.4, validation 4.1): V = ∫ A(s) ds for any path and
 * twist while the section stays normal to the path; a `fixed` section is a Cavalieri sweep, V = A × extent of the path along the plane normal.
 */

import type { SweepEntity, Vec2, Vec3 } from '../../model/types';
import { polygonCentroid } from '../../lib/polygon';
import { add3, dot3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { integrateLaw } from '../../lib/law/integrate';
import { baseSectionArea, type SweepLawShape } from './laws';
import { evaluateSweep, pathLength, type SweepShape } from './evaluate';
import { pathBendAt } from './pathCurvature';
import { transformPoint } from './sectionTransform';
import { orientedFrames, type SweepFrame } from './frames';

/** Volume when it has a closed form, else null (stations, stretch, non-round sections, fixed sections on a non-monotone path). */
export function sweepAnalyticVolume(sweep: SweepShape): number | null {
  const { section, orientation } = sweep;
  if (section.shape !== 'circle' || sweep.stations !== undefined || sweep.stretch !== undefined || sweep.rails !== undefined) return null;
  // a mitre cuts the legs at the bisector: A (L1 + L2) holds for a constant section only
  if (sweep.corners === 'miter' && (sweep.scale !== undefined || sweep.area !== undefined)) return null;
  // a screw section is not centred on the path (Pappus about the axis, not A L): the kernel measures it
  if (orientation?.mode === 'axis_plane') return null;
  const length = pathLength(sweep);
  const area = baseSectionArea(sweep);
  if (orientation?.mode === 'fixed') return fixedVolume(sweep, area);
  const laws: SweepLawShape = sweep;
  if (laws.area !== undefined) return length * integrateLaw(laws.area, (a) => a, length);
  if (laws.scale !== undefined) return area * length * integrateLaw(laws.scale, (s) => s * s, length);
  return area * length;
}

/** A × |extent of the path along the plane normal| for a path that never turns back along it, with no law. */
function fixedVolume(sweep: SweepShape, area: number): number | null {
  if (sweep.scale !== undefined || sweep.area !== undefined) return null;
  const frames = orientedFrames(sweep.path, sweep.orientation, 1);
  if (!Array.isArray(frames) || frames.length < 2) return null;
  const direction = normalize3((sweep.orientation?.mode === 'fixed' ? sweep.orientation.direction : undefined) ?? ([0, 0, 1] as Vec3));
  const rises = frames.map((frame) => dot3(frame.tangent, direction));
  if (!(rises.every((r) => r > 0) || rises.every((r) => r < 0))) return null;
  const first = frames[0];
  const last = frames[frames.length - 1];
  return first === undefined || last === undefined ? null : area * Math.abs(dot3(sub3(last.point, first.point), direction));
}

/** True when `profile` (straight edges only) is centred on the path: its area centroid lies within 1e-9 of its extent from the section origin. */
function centred(profile: ReadonlyArray<Vec2>): boolean {
  const [cx, cy] = polygonCentroid(profile);
  const extent = Math.max(...profile.map(([x, y]) => Math.hypot(x, y)), 1e-12);
  return Math.hypot(cx, cy) <= 1e-9 * extent;
}

/**
 * The exact volume of a section with straight edges (or a circle) whose placement moves its centroid off the path: V = ∫ A(s) (1 - b(s) . c(s)) ds, with
 * A(s) the area under the station's transform, b = dT/ds the curvature vector and c the section centroid under that transform, lifted to the frame (validation
 * 4.1: the slab's volume element is (1 - kappa xi) dA ds, whose first moment is the centroid's). Trapezoid over the frames' chord fractions, whose lengths share
 * the exact path length. Null when a slab folds (1 - b . c <= 0 at a frame) or the sweep cannot be evaluated.
 */
function pappusVolume(sweep: SweepEntity, centroid: Vec2): number | null {
  const evaluation = evaluateSweep(sweep);
  if (!('frames' in evaluation)) return null;
  const { frames, fractions, transforms, length } = evaluation;
  const bends = pathBendAt(sweep.path, fractions, sweep.helix);
  const baseArea = baseSectionArea(sweep);
  const integrand = (k: number): number => {
    const transform = transforms?.[k];
    const [x, y] = transform === undefined ? centroid : transformPoint(centroid, transform);
    const frame = frames[k] as SweepFrame;
    const lifted = add3(scale3(frame.normal, x), scale3(frame.binormal, y));
    return baseArea * (transform === undefined ? 1 : transform.sx * transform.sy) * (1 - dot3(bends[k] as Vec3, lifted));
  };
  let volume = 0;
  for (let k = 0; k + 1 < frames.length; k++) {
    const [left, right] = [integrand(k), integrand(k + 1)];
    if (!(left > 0 && right > 0)) return null;
    volume += (((fractions[k + 1] as number) - (fractions[k] as number)) * length * (left + right)) / 2;
  }
  return volume;
}

/**
 * The volume a sweep must have while its section is normal to the path (validation 4.1), or null when that premise does not hold: another frame mode than
 * minimal / frenet / binormal, stations, a stretch, a section with curved edges, a mitre with a law, a mitre with rails or an off-centre profile.
 * A section centred on the path has V = ∫ A(s) ds (a round section or a constant / scale / area law in closed form); rails, which may move the centroid, and
 * an off-centre profile are integrated with the Pappus term of the curved path (`pappusVolume`, exact for any translation, so no bound on the rails is needed).
 * Accuracy floor: the frames' trapezoid, about 1e-6 on the pack's rail cases and exact (rounding) where the integrand is constant.
 */
export function sweepConsistencyVolume(sweep: SweepEntity): number | null {
  const { section, orientation } = sweep;
  if (orientation !== undefined && !['minimal', 'frenet', 'binormal'].includes(orientation.mode)) return null;
  if (sweep.stations !== undefined || sweep.stretch !== undefined) return null;
  const profile = section.shape === 'profile' ? (section.profile as Vec2[]) : null;
  const straight = section.shape === 'profile' ? (section.curves ?? []).every((segment) => segment.type === 'line') : true;
  if (!straight) return null;
  const mitred = sweep.corners === 'miter';
  if (sweep.rails !== undefined || (profile !== null && !centred(profile))) {
    return mitred ? null : pappusVolume(sweep, profile === null ? [0, 0] : polygonCentroid(profile));
  }
  if (section.shape === 'circle') return sweepAnalyticVolume(sweep);
  if (mitred && (sweep.scale !== undefined || sweep.area !== undefined)) return null;
  const length = pathLength(sweep);
  const area = baseSectionArea(sweep);
  if (sweep.area !== undefined) return length * integrateLaw(sweep.area, (a) => a, length);
  if (sweep.scale !== undefined) return area * length * integrateLaw(sweep.scale, (s) => s * s, length);
  return area * length;
}
