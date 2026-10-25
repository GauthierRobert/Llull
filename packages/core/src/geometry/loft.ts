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
import { ringWalls, skinTriangles } from './skin';
import type { Triangle } from './triangles';

/** Interpolated rings per span of a smooth loft. */
const LOFT_SPAN_STEPS = 8;

/**
 * The section rings of a loft as the model reads them (one per section, no span interpolation): the polygons themselves when every exact face
 * is straight in u, else each ring's closed curve. Smoothing the corners of a polygon section would round a square into a bulging ring (+25 % across the edge midpoints).
 */
export function loftSectionRings(loft: Pick<LoftEntity, 'rings' | 'faces'>): Vec3[][] {
  const polygons = loft.faces !== undefined && loft.faces.length > 0 && loft.faces.every((face) => face.degreeU === 1);
  return loft.rings.map((ring) => (polygons ? [...ring] : sampleRing(ring)));
}

/**
 * Dense rings of a loft (local coordinates). Section rings: see `loftSectionRings`.
 */
export function loftRings(loft: Pick<LoftEntity, 'rings' | 'ruled' | 'closed' | 'faces'>): Vec3[][] {
  const sections = loftSectionRings(loft);
  const first = sections[0];
  if (loft.ruled || loft.closed === true || sections.length < 3 || first === undefined) return sections;
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
export function loftTriangles(loft: Pick<LoftEntity, 'rings' | 'ruled' | 'closed' | 'faces'>, origin: Vec3 = [0, 0, 0]): Triangle[] {
  const rings = loftRings(loft).map((ring) => ring.map((p) => add3(p, origin)));
  if (loft.closed !== true) return skinTriangles(rings);
  // a closed loft has no end caps: the last ring joins the first
  return rings.flatMap((ring, i) => ringWalls(ring, rings[(i + 1) % rings.length] as Vec3[], false));
}
