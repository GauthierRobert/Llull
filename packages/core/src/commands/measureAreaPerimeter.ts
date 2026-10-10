import { distance, polygonArea, polygonPerimeter } from '../lib/polygon';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { formatLength } from './units';
import { noop, report } from './noop';
import { elementAt } from '../lib/elementAt';

/**
 * @command measure_area
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { area: number, unit: string } where unit is derived (e.g. "mm²")
 * @failure open profile, non-2D entity, < 3 points, or missing id -> no-op, affected:[], no data
 */
export const measureArea = defineCommand({
  name: 'measure_area',
  annotations: { readOnly: true },
  description:
    'Compute the area of a closed 2D shape. Provide either: (a) an entityId for a closed ' +
    'polyline, rectangle, or circle entity; or (b) an explicit polygon as points ([[x,y],...], >= 3 points). ' +
    'Returns data: { area, unit } where unit is the squared document unit (e.g. "mm²"). ' +
    'Open polylines are rejected with an explanatory message. Does not modify the document.',
  params: z.object({
    entityId: z
      .string()
      .optional()
      .describe(
        "Id of a closed 2D shape entity: 'polyline' (must have closed:true), 'rectangle', or 'circle'.",
      ),
    points: z
      .array(z.tuple([z.number(), z.number()]))
      .optional()
      .describe(
        'Explicit polygon vertices [[x,y],...] in the local 2D plane. Must have at least 3 points. ' +
          'The polygon is implicitly closed (last → first).',
      ),
  }),
  run: (doc, { entityId, points }): CommandResult => {
    const areaUnit = `${doc.units}²`;
    const measured = (area: number, subject: string): CommandResult =>
      report(doc, `Area${subject} = ${area.toFixed(doc.displayPrecision)} ${areaUnit}.`, {
        area,
        unit: areaUnit,
      });

    if (points) {
      if (points.length < 3)
        return noop(doc, `measure_area: points must have >= 3 vertices, got ${points.length}.`);
      return measured(polygonArea(points), '');
    }

    if (!entityId) return noop(doc, 'measure_area: provide either entityId or points.');

    const e = doc.entities[entityId];
    if (!e) return noop(doc, `measure_area: entity '${entityId}' not found.`);

    switch (e.kind) {
      case 'circle':
        return measured(Math.PI * e.radius * e.radius, ` of ${entityId}`);
      case 'rectangle':
        return measured(e.width * e.height, ` of ${entityId}`);
      case 'polyline':
        if (!e.closed) {
          return noop(
            doc,
            `measure_area: polyline '${entityId}' is not closed — cannot compute area.`,
          );
        }
        if (e.points.length < 3)
          return noop(doc, `measure_area: polyline '${entityId}' has fewer than 3 points.`);
        return measured(polygonArea(e.points), ` of ${entityId}`);
      default:
        return noop(
          doc,
          `measure_area: entity '${entityId}' is kind '${e.kind}'; supported kinds are 'circle', 'rectangle', 'polyline'.`,
        );
    }
  },
});

/**
 * @command measure_perimeter
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is { perimeter: number, unit: string }
 * @failure non-2D entity or missing id -> no-op, affected:[], no data
 */
export const measurePerimeter = defineCommand({
  name: 'measure_perimeter',
  annotations: { readOnly: true },
  description:
    "Compute the perimeter or total length of a 2D shape. Supported entity kinds: 'line' (segment length), " +
    "'polyline' (sum of segment lengths; closed polyline adds last→first segment), " +
    "'rectangle' (2*(width+height)), 'circle' (circumference 2πr), 'arc' (arc length r*|angle|). " +
    'Returns data: { perimeter, unit }. Does not modify the document.',
  params: z.object({
    entityId: z
      .string()
      .describe(
        "Id of the 2D shape entity to measure. Supported kinds: 'line', 'polyline', 'rectangle', 'circle', 'arc'.",
      ),
  }),
  run: (doc, { entityId }): CommandResult => {
    const e = doc.entities[entityId];
    if (!e) return noop(doc, `measure_perimeter: entity '${entityId}' not found.`);

    let perimeter: number;
    switch (e.kind) {
      case 'line':
        perimeter = distance(e.start, e.end);
        break;
      case 'polyline':
        perimeter = e.closed
          ? polygonPerimeter(e.points)
          : e.points.reduce(
              (sum, p, i, pts) => (i === 0 ? 0 : sum + distance(elementAt(pts, i - 1), p)),
              0,
            );
        break;
      case 'rectangle':
        perimeter = 2 * (e.width + e.height);
        break;
      case 'circle':
        perimeter = 2 * Math.PI * e.radius;
        break;
      case 'arc': {
        // Arcs sweep CCW; a non-positive span wraps into (0, 2π] (start === end is a full circle, as rendered).
        let span = e.endAngle - e.startAngle;
        if (span <= 0) span = ((span % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
        perimeter = e.radius * span;
        break;
      }
      default:
        return noop(
          doc,
          `measure_perimeter: entity '${entityId}' is kind '${e.kind}'; ` +
            "supported kinds are 'line', 'polyline', 'rectangle', 'circle', 'arc'.",
        );
    }

    return report(doc, `Perimeter of ${entityId} = ${formatLength(doc, perimeter)}.`, {
      perimeter,
      unit: doc.units,
    });
  },
});
