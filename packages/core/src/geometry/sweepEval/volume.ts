/**
 * Closed-form volume of a sweep with a round section centred on the path (TECHNICAL_SPEC 5.4, validation 4.1): V = ∫ A(s) ds for any path and
 * twist while the section stays normal to the path; a `fixed` section is a Cavalieri sweep, V = A × extent of the path along the plane normal.
 */

import type { Vec3 } from '../../model/types';
import { dot3, normalize3, sub3 } from '../../lib/vec3';
import { integrateLaw } from '../../lib/law/integrate';
import { baseSectionArea, type SweepLawShape } from './laws';
import { pathLength, type SweepShape } from './evaluate';
import { orientedFrames } from './frames';

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
