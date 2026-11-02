/** Overlap of two platforms at the same elevation (STA_PLATFORM_OVERLAP): grating panels sharing area, not merely an edge. */

import type { CadDocument, Vec2 } from '@core/model/types';
import { toMm } from '@core/model/units';
import { pointInPolygon, segmentsIntersect } from '@lib/polygon';
import { triangulatePolygon } from '@lib/triangulate';
import type { BuildingModel, GratingElement } from '@aec/building/types';
import { elementsOf } from '../../../building/model';

/** Platforms whose walking surfaces differ by less than this are at the same elevation, mm. */
const SAME_ELEVATION_MM = 1;

type Ring = ReadonlyArray<Vec2>;

/** A point strictly inside a simple polygon (the centroid of its first ear), or null when it cannot be triangulated. */
function interiorPoint(ring: Ring): Vec2 | null {
  const { vertices, triangles } = triangulatePolygon([...ring]);
  const first = triangles[0];
  if (first === undefined) return null;
  const [a, b, c] = first.map((index) => vertices[index] as Vec2) as [Vec2, Vec2, Vec2];
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
}

/** True when two simple polygons share area: an edge pair crosses, or an interior point of one lies inside the other. */
function ringsOverlap(a: Ring, b: Ring): boolean {
  const crossing = a.some((p, i) => {
    const q = a[(i + 1) % a.length] as Vec2;
    return b.some((r, j) => segmentsIntersect(p, q, r, b[(j + 1) % b.length] as Vec2));
  });
  if (crossing) return true;
  const [pa, pb] = [interiorPoint(a), interiorPoint(b)];
  return (pa !== null && pointInPolygon(pa, b)) || (pb !== null && pointInPolygon(pb, a));
}

/** The other platform whose gratings overlap `panels` (document units, absolute walking-surface height `topMm`), or undefined. */
export function overlappingPlatform(
  doc: CadDocument,
  building: BuildingModel,
  ownId: string | undefined,
  topMm: number,
  panels: ReadonlyArray<Ring>,
): string | undefined {
  for (const assembly of elementsOf(building, 'assembly')) {
    if (assembly.id === ownId) continue;
    for (const id of assembly.partIds) {
      const grating = building.elements[id];
      if (grating?.category !== 'grating') continue;
      const level = building.levels[grating.levelId];
      if (level === undefined || Math.abs(toMm(doc, level.elevation + grating.topOffset) - topMm) > SAME_ELEVATION_MM) continue;
      if (panels.some((panel) => ringsOverlap(panel, (grating as GratingElement).boundary))) return assembly.id;
    }
  }
  return undefined;
}
