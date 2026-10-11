/**
 * @layer core/commands
 * Section specs shared by variable sweeps (`stations`) and lofts (`sections`): one of a circle
 * (`radius`), an ellipse (`radiusX` + `radiusY`), a polygon (`section` points) or a closed sketch
 * (`sectionId`), resolved to a section ring (geometry/sectionRing). Pure helpers.
 */

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
  radiusX: z
    .number()
    .describe('Elliptical section: half-width along section x (> 0); give with radiusY.')
    .optional(),
  radiusY: z
    .number()
    .describe('Elliptical section: half-height along section y (> 0); give with radiusX.')
    .optional(),
  section: untypedArray('Polygon section: closed [x, y] points (>= 3).').optional(),
  sectionId: z
    .string()
    .describe('Id of a closed 2D sketch (circle, ellipse, rectangle, closed polyline/spline).')
    .optional(),
};

export interface SectionSpec {
  readonly radius?: number | undefined;
  readonly radiusX?: number | undefined;
  readonly radiusY?: number | undefined;
  readonly section?: ReadonlyArray<unknown> | undefined;
  readonly sectionId?: string | undefined;
}

const ELLIPSE_POINTS = 96;

/** Dense closed polygon of a spec, or an error message. */
export function specPolygon(doc: CadDocument, spec: SectionSpec): Vec2[] | string {
  const { radius, radiusX, radiusY, section, sectionId } = spec;
  const ellipse = radiusX !== undefined || radiusY !== undefined;
  const given = [radius !== undefined, ellipse, section !== undefined, sectionId !== undefined];
  if (given.filter(Boolean).length !== 1)
    return 'give exactly one of radius, radiusX+radiusY, section or sectionId';
  let polygon: Vec2[];
  if (radius !== undefined || ellipse) {
    const rx = radius ?? radiusX ?? 0;
    const ry = radius ?? radiusY ?? 0;
    if (!(rx > 0 && ry > 0)) return `radii must be > 0 (got ${rx} × ${ry})`;
    polygon = Array.from({ length: ELLIPSE_POINTS }, (_, k): Vec2 => {
      const angle = (2 * Math.PI * k) / ELLIPSE_POINTS;
      return [rx * Math.cos(angle), ry * Math.sin(angle)];
    });
  } else if (section !== undefined) {
    const bad = section.findIndex((point) => !isVec2(point));
    if (bad >= 0) return `section point ${bad} must be a finite [x, y] pair`;
    if (section.length < 3 || section.length > MAX_PROFILE_POINTS)
      return `section needs 3..${MAX_PROFILE_POINTS} points (got ${section.length})`;
    polygon = section as Vec2[];
  } else {
    const loop = sketchLoop(doc, [sectionId as string]);
    if (typeof loop === 'string') return `section ${loop}`;
    polygon = loop.profile;
  }
  if (polygonArea(polygon) <= 1e-12) return 'section encloses no area';
  return polygon;
}

/** Section ring of a spec (or an error message), and its half-size (max distance from 0,0). */
export function specRing(
  doc: CadDocument,
  spec: SectionSpec,
): { ring: Vec2[]; halfSize: number } | string {
  const polygon = specPolygon(doc, spec);
  if (typeof polygon === 'string') return polygon;
  return {
    ring: resampleRing(polygon),
    halfSize: Math.max(...polygon.map(([x, y]) => Math.hypot(x, y))),
  };
}
