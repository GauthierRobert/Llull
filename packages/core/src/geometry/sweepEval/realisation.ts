/**
 * How the exact kernel builds a sweep: the analytic pipe (constant section, twist-free frame, planar path or round section, not along a helix) or the
 * fitted-face path (everything else). VC-SWG-25b measured why a non-round section on a non-planar path cannot use the pipe: OCC's corrected Frenet frame
 * follows the Frenet frame, the evaluator's frame is rotation-minimizing, and they turn apart by the integral of the torsion (0.4984 rad per turn on
 * the R 20, p 10 helix: the 10 x 2 rectangle ended 86 degrees from the evaluator's after 3 turns).
 */

import type { CurveSegment } from '../../model/curve';
import type { SweepEntity, Vec3 } from '../../model/types';
import { cross3, dot3, len3, sub3 } from '../../lib/vec3';
import { sampleChain } from '../curveSegments';
import { hasSweepLaws } from './laws';

export type SweepRealisation = 'analytic' | 'fitted';

/** True when every sampled point of the chain lies in one plane (a straight chain is planar). */
function planarPath(path: ReadonlyArray<CurveSegment<Vec3>>): boolean {
  const points = sampleChain(path, false);
  const origin = points[0] as Vec3;
  const far = points.reduce((best, p) => (len3(sub3(p, origin)) > len3(sub3(best, origin)) ? p : best), origin);
  const extent = Math.max(len3(sub3(far, origin)), 1e-12);
  // the plane through the origin, the farthest point and the point that turns most away from their line
  const normal = points.reduce<Vec3>(
    (best, p) => {
      const candidate = cross3(sub3(far, origin), sub3(p, origin));
      return len3(candidate) > len3(best) ? candidate : best;
    },
    [0, 0, 0],
  );
  if (len3(normal) <= 1e-9 * extent * extent) return true;
  return points.every((p) => Math.abs(dot3(sub3(p, origin), normal)) <= 1e-9 * extent * len3(normal));
}

/**
 * True when a sweep needs more than the kernel's pipe operation: any law, station blend, non-default frame, a helical path (MakePipe is only ~2e-6
 * exact on one), or a non-round section on a non-planar path (the pipe's frame is not the evaluator's).
 */
export function needsFittedFaces(sweep: SweepEntity): boolean {
  const mode = sweep.orientation?.mode ?? 'minimal';
  if (hasSweepLaws(sweep) || mode !== 'minimal' || sweep.helix !== undefined) return true;
  return sweep.section.shape !== 'circle' && !planarPath(sweep.path);
}

export const sweepRealisation = (sweep: SweepEntity): SweepRealisation => (needsFittedFaces(sweep) ? 'fitted' : 'analytic');
