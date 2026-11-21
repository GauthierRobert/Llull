/**
 * Exact ruled polygon lofts (ASC M5, TR-ASC-16): when every section of a `ruled: true` loft is a polygon (inline `section` points, or a sketch made only of
 * straight segments: rectangle, closed polyline) the loft keeps the polygon vertices: no resampling to 24 points, no Catmull-Rom. Corresponding
 * vertices are paired by index after a cyclic seam alignment, so the ruled skin has planar or bilinear faces.
 */

import type { CadDocument, Vec2, Vec3 } from '../../model/types';
import { centroid3, dot3, sub3 } from '../../lib/vec3';
import { toCounterClockwise } from '../../lib/polygon';
import { alignRing } from '../../geometry/sectionRing';
import { ringNormal } from '../../geometry/skin';
import { planeToWorld } from '../../geometry/workPlane';
import { sketchLoop } from './sketchCurves';
import { sectionLoop, type SectionSpec } from './sectionSpecs';

/** One section as a polygon in its plane: the vertices plus the plane origin and Euler rotation. */
export interface PolygonSection {
  readonly polygon: readonly Vec2[];
  readonly origin: Vec3;
  readonly rotation: Vec3;
}

/** The vertices of a section given as a sketch id when it is made only of straight segments, else null. */
function sketchPolygon(doc: CadDocument, sectionId: string): Vec2[] | null {
  const loop = sketchLoop(doc, [sectionId]);
  if (typeof loop === 'string' || loop.curves.length < 3) return null;
  return loop.curves.every((curve) => curve.type === 'line') ? loop.curves.map((curve) => curve.points[0]) : null;
}

/** The vertices of an inline section spec when it is an explicit `section` polygon or a straight-edged sketch, else null. */
function specVertices(doc: CadDocument, spec: SectionSpec): Vec2[] | null {
  if (spec.radius !== undefined || spec.radiusX !== undefined || spec.radiusY !== undefined) return null;
  if (spec.section !== undefined && spec.sectionId === undefined) {
    const loop = sectionLoop(doc, spec.section, undefined);
    return typeof loop === 'string' ? null : loop.profile;
  }
  return spec.sectionId !== undefined && spec.section === undefined ? sketchPolygon(doc, spec.sectionId) : null;
}

/** The vertices of a sketch-id section (rectangle, closed polyline) with its plane, or null when it has a curved edge or does not resolve. */
function sketchSection(doc: CadDocument, sectionId: string): PolygonSection | null {
  const loop = sketchLoop(doc, [sectionId]);
  const polygon = sketchPolygon(doc, sectionId);
  return typeof loop === 'string' || polygon === null ? null : { polygon, origin: loop.origin, rotation: loop.rotation };
}

type InlineSection = SectionSpec & { center: Vec3; rotation?: Vec3 | undefined };

/**
 * The sections as polygons when EVERY one is (inline `section` points or a straight-edged sketch) and the section list is well formed
 * (exactly one of the two lists, 2..`maxSections`); null otherwise, so the general loft reports its own errors.
 */
export function polygonSectionsOf(
  doc: CadDocument,
  sectionIds: readonly string[] | undefined,
  sections: readonly InlineSection[] | undefined,
  maxSections: number,
): PolygonSection[] | null {
  if ((sectionIds === undefined) === (sections === undefined)) return null;
  const count = (sectionIds ?? sections ?? []).length;
  if (count < 2 || count > maxSections) return null;
  const found: PolygonSection[] = [];
  for (let i = 0; i < count; i++) {
    if (sectionIds !== undefined) {
      const section = sketchSection(doc, sectionIds[i] as string);
      if (section === null) return null;
      found.push(section);
      continue;
    }
    const spec = (sections as readonly InlineSection[])[i] as InlineSection;
    const polygon = specVertices(doc, spec);
    if (polygon === null || polygon.length < 3) return null;
    found.push({ polygon, origin: spec.center, rotation: spec.rotation ?? [0, 0, 0] });
  }
  return found;
}

/** The first section whose vertex count differs from section 0, with both counts, or null when all agree. */
export function vertexCountMismatch(sections: readonly PolygonSection[]): { index: number; count: number; expected: number } | null {
  const expected = (sections[0] as PolygonSection).polygon.length;
  const index = sections.findIndex((section) => section.polygon.length !== expected);
  return index < 0 ? null : { index, count: (sections[index] as PolygonSection).polygon.length, expected };
}

/**
 * World rings of a polygon loft: the vertices themselves, wound counter-clockwise about the direction of travel and cyclically shifted to the
 * previous ring (vertex k of every ring is paired by index). Error message when two neighbouring sections share a centre.
 * @invariant every section has the same vertex count (see `vertexCountMismatch`)
 */
export function polygonLoftRings(sections: readonly PolygonSection[]): Vec3[][] | string {
  const raw = sections.map(({ polygon, origin, rotation }) =>
    toCounterClockwise(polygon).map((local) => planeToWorld(origin, rotation, local)),
  );
  const centres = raw.map((ring) => centroid3(ring));
  for (let i = 1; i < centres.length; i++) {
    const gap = sub3(centres[i] as Vec3, centres[i - 1] as Vec3);
    if (Math.hypot(gap[0], gap[1], gap[2]) < 1e-6) return `sections ${i - 1} and ${i} share the same centre; space them along the loft`;
  }
  const rings: Vec3[][] = [];
  raw.forEach((ring, i) => {
    const travel = sub3(centres[Math.min(i + 1, centres.length - 1)] as Vec3, centres[Math.max(i - 1, 0)] as Vec3);
    const oriented = dot3(ringNormal(ring), travel) >= 0 ? ring : [ring[0] as Vec3, ...ring.slice(1).reverse()];
    const previous = rings[i - 1];
    rings.push(previous === undefined ? oriented : alignRing(oriented, previous));
  });
  return rings;
}
