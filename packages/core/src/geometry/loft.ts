/**
 * Loft tessellation: each section ring is sampled as its closed curve (./sectionRing), then the rings are skinned (./skin). A smooth loft
 * also blends between sections along every vertex column with a centripetal Catmull-Rom curve (LOFT_SPAN_STEPS rings per span); a ruled
 * loft joins neighbouring sections with straight lines.
 */

import type { CurveSegment } from '../model/curve';
import type { LoftEntity, Vec3 } from '../model/types';
import { add3 } from '../lib/vec3';
import { catmullRomBeziers, segmentPoint } from './curveSegments';
import { sampleRing } from './sectionRing';
import { skinTriangles } from './skin';
import type { Triangle } from './triangles';

/** Interpolated rings per span of a smooth loft. */
const LOFT_SPAN_STEPS = 8;

/** Dense rings of a loft (local coordinates). */
export function loftRings(loft: Pick<LoftEntity, 'rings' | 'ruled'>): Vec3[][] {
  const sections = loft.rings.map(sampleRing);
  const first = sections[0];
  if (loft.ruled || sections.length < 3 || first === undefined) return sections;
  const columns = first.map((_, j) =>
    catmullRomBeziers(
      sections.map((ring) => ring[j] as Vec3),
      false,
    ),
  );
  const rings: Vec3[][] = [];
  for (let span = 0; span + 1 < sections.length; span++) {
    for (let s = span === 0 ? 0 : 1; s <= LOFT_SPAN_STEPS; s++)
      rings.push(columns.map((column) => segmentPoint(column[span] as CurveSegment<Vec3>, s / LOFT_SPAN_STEPS)));
  }
  return rings;
}

/** Closed, outward-wound triangles of a loft; `origin` is added to every vertex. */
export function loftTriangles(loft: Pick<LoftEntity, 'rings' | 'ruled'>, origin: Vec3 = [0, 0, 0]): Triangle[] {
  return skinTriangles(loftRings(loft).map((ring) => ring.map((p) => add3(p, origin))));
}
