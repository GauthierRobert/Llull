/**
 * Section specs shared by variable sweeps (`stations`) and lofts (`sections`): one of a circle (`radius`), an ellipse (`radiusX` +
 * `radiusY`), a polygon (`section` points) or a closed sketch (`sectionId`), resolved to a section ring (geometry/sectionRing). Pure
 * helpers.
 */

import type { CurveSegment } from '../../model/curve';
import type { CadDocument, Vec2 } from '../../model/types';
import { isVec2 } from '../../lib/vec2';
import { polygonArea } from '../../lib/polygon';
import { resampleRing } from '../../geometry/sectionRing';
import { untypedArray, z } from '../schema';
import { MAX_PROFILE_POINTS } from '../limits';
import { sketchLoop } from './sketchCurves';

/** Zod fields of one section spec (each described for agents). */
export const sectionSpecFields = {
  radius: z.number().describe('Round section radius (> 0).').optional(),
  radiusX: z.number().describe('Elliptical section: half-width along section x (> 0); give with radiusY.').optional(),
  radiusY: z.number().describe('Elliptical section: half-height along section y (> 0); give with radiusX.').optional(),
  section: untypedArray('Polygon section: closed [x, y] points (>= 3).').optional(),
  sectionId: z.string().describe('Id of a closed 2D sketch (circle, ellipse, rectangle, closed polyline/spline).').optional(),
};

export interface SectionSpec {
  readonly radius?: number | undefined;
  readonly radiusX?: number | undefined;
  readonly radiusY?: number | undefined;
  readonly section?: ReadonlyArray<unknown> | undefined;
  readonly sectionId?: string | undefined;
}

const ELLIPSE_POINTS = 96;

/** The points without a point equal (within 1e-9 of the section size) to the one before it or, at the end, to the first (a closing repeat): the loop is closed implicitly. */
function withoutRepeats(points: readonly Vec2[]): Vec2[] {
  const tolerance = Math.max(...points.map(([x, y]) => Math.hypot(x, y)), 1e-12) * 1e-9;
  const same = (a: Vec2, b: Vec2): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
  const kept = points.filter((p, i) => i === 0 || !same(p, points[i - 1] as Vec2));
  const first = kept[0];
  return first !== undefined && kept.length > 1 && same(kept[kept.length - 1] as Vec2, first) ? kept.slice(0, -1) : kept;
}

/**
 * The closed loop of an explicit `section` point list (no exact curves) or of the `sectionId` sketch (with its exact curves), or an error
 * message; exactly one of the two must be given.
 */
export function sectionLoop(
  doc: CadDocument,
  section: ReadonlyArray<unknown> | undefined,
  sectionId: string | undefined,
): { profile: Vec2[]; curves: CurveSegment<Vec2>[] } | string {
  if (section !== undefined) {
    const bad = section.findIndex((point) => !isVec2(point));
    if (bad >= 0) return `section point ${bad} must be a finite [x, y] pair`;
    if (section.length < 3 || section.length > MAX_PROFILE_POINTS)
      return `section needs 3..${MAX_PROFILE_POINTS} points (got ${section.length})`;
    const profile = withoutRepeats(section as Vec2[]);
    if (profile.length < 3) return `section needs 3 distinct points (got ${profile.length} after dropping repeated points)`;
    return { profile, curves: [] };
  }
  const loop = sketchLoop(doc, [sectionId as string]);
  return typeof loop === 'string' ? `section ${loop}` : loop;
}
/** Dense closed polygon of a spec, or an error message. */
export function specPolygon(doc: CadDocument, spec: SectionSpec): Vec2[] | string {
  const { radius, radiusX, radiusY, section, sectionId } = spec;
  const ellipse = radiusX !== undefined || radiusY !== undefined;
  const given = [radius !== undefined, ellipse, section !== undefined, sectionId !== undefined];
  if (given.filter(Boolean).length !== 1) return 'give exactly one of radius, radiusX+radiusY, section or sectionId';
  let polygon: Vec2[];
  if (radius !== undefined || ellipse) {
    const rx = radius ?? radiusX ?? 0;
    const ry = radius ?? radiusY ?? 0;
    if (!(rx > 0 && ry > 0)) return `radii must be > 0 (got ${rx} × ${ry})`;
    polygon = Array.from({ length: ELLIPSE_POINTS }, (_, k): Vec2 => {
      const angle = (2 * Math.PI * k) / ELLIPSE_POINTS;
      return [rx * Math.cos(angle), ry * Math.sin(angle)];
    });
  } else {
    const loop = sectionLoop(doc, section, sectionId);
    if (typeof loop === 'string') return loop;
    polygon = loop.profile;
  }
  if (polygonArea(polygon) <= 1e-12) return 'section encloses no area';
  return polygon;
}

/** Section ring of a spec (or an error message), and its half-size (max distance from 0,0). */
export function specRing(doc: CadDocument, spec: SectionSpec): { ring: Vec2[]; halfSize: number } | string {
  const polygon = specPolygon(doc, spec);
  if (typeof polygon === 'string') return polygon;
  return { ring: resampleRing(polygon), halfSize: Math.max(...polygon.map(([x, y]) => Math.hypot(x, y))) };
}
