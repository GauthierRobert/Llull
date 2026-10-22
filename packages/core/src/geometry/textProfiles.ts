/**
 * Planar extrusion profiles of a text outline (03 WRP M1): every region as one outer chain of exact line and cubic-Bezier segments (a quadratic
 * TrueType segment is degree-elevated exactly) plus one chain per hole, all counter-clockwise, with the polygon tessellation the mesh kernels use.
 */

import type { CurveSegment } from '../model/curve';
import type { Vec2 } from '../model/vectors';
import type { OutlineLoop } from '../lib/font/outline';
import { loopArea } from '../lib/font/outline';
import { reverseChain, sampleProfile } from './curveSegments';
import type { TextOutline } from './textOutline';

export interface ProfileChain {
  readonly curves: CurveSegment<Vec2>[];
  /** Polygon tessellation of `curves` (the last point is not repeated). */
  readonly profile: Vec2[];
}

export interface TextProfile {
  readonly outer: ProfileChain;
  readonly holes: readonly ProfileChain[];
}

const TWO_THIRDS = 2 / 3;

/** The loop as an exact counter-clockwise chain; a quadratic [p0, c, p1] becomes the cubic [p0, p0 + 2/3 (c - p0), p1 + 2/3 (c - p1), p1]. */
function chainOf(loop: OutlineLoop): ProfileChain {
  const curves: CurveSegment<Vec2>[] = loop.map((segment) =>
    segment.kind === 'line'
      ? { type: 'line', points: [segment.from, segment.to] }
      : {
          type: 'bezier',
          points: [
            segment.from,
            [
              segment.from[0] + TWO_THIRDS * (segment.control[0] - segment.from[0]),
              segment.from[1] + TWO_THIRDS * (segment.control[1] - segment.from[1]),
            ],
            [
              segment.to[0] + TWO_THIRDS * (segment.control[0] - segment.to[0]),
              segment.to[1] + TWO_THIRDS * (segment.control[1] - segment.to[1]),
            ],
            segment.to,
          ],
        },
  );
  const oriented = loopArea(loop) < 0 ? reverseChain(curves) : curves;
  return { curves: oriented, profile: sampleProfile(oriented) };
}

/** The regions of `outline` as extrusion profiles, in region order. */
export function textProfiles(outline: Pick<TextOutline, 'regions'>): TextProfile[] {
  return outline.regions.map((region) => ({ outer: chainOf(region.outer), holes: region.holes.map(chainOf) }));
}
