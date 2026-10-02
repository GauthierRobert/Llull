import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { formatLength } from './units';
// ---------------------------------------------------------------------------
// 3. measure_area
// ---------------------------------------------------------------------------

interface MeasureAreaData {
  area: number;
  unit: string;
}

/** Shoelace formula for a polygon in 2D. Returns the absolute area. */
export function polygonArea(pts: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum / 2);
}

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

    if (points) {
      if (points.length < 3) {
        return {
          document: doc,
          summary: `measure_area: points must have >= 3 vertices, got ${points.length}.`,
          affected: [],
        };
      }
      const area = polygonArea(points);
      const data: MeasureAreaData = { area, unit: areaUnit };
      return {
        document: doc,
        summary: `Area = ${area.toFixed(doc.displayPrecision)} ${areaUnit}.`,
        affected: [],
        data,
      };
    }

    if (!entityId) {
      return {
        document: doc,
        summary: 'measure_area: provide either entityId or points.',
        affected: [],
      };
    }

    const e = doc.entities[entityId];
    if (!e) {
      return {
        document: doc,
        summary: `measure_area: entity '${entityId}' not found.`,
        affected: [],
      };
    }

    let area: number;
    switch (e.kind) {
      case 'circle':
        area = Math.PI * e.radius * e.radius;
        break;
      case 'rectangle':
        area = e.width * e.height;
        break;
      case 'polyline': {
        if (!e.closed) {
          return {
            document: doc,
            summary: `measure_area: polyline '${entityId}' is not closed — cannot compute area.`,
            affected: [],
          };
        }
        if (e.points.length < 3) {
          return {
            document: doc,
            summary: `measure_area: polyline '${entityId}' has fewer than 3 points.`,
            affected: [],
          };
        }
        area = polygonArea(e.points);
        break;
      }
      default:
        return {
          document: doc,
          summary: `measure_area: entity '${entityId}' is kind '${e.kind}'; supported kinds are 'circle', 'rectangle', 'polyline'.`,
          affected: [],
        };
    }

    const data: MeasureAreaData = { area, unit: areaUnit };
    return {
      document: doc,
      summary: `Area of ${entityId} = ${area.toFixed(doc.displayPrecision)} ${areaUnit}.`,
      affected: [],
      data,
    };
  },
});

// ---------------------------------------------------------------------------
// 4. measure_perimeter
// ---------------------------------------------------------------------------

interface MeasurePerimeterData {
  perimeter: number;
  unit: string;
}

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
    if (!e) {
      return {
        document: doc,
        summary: `measure_perimeter: entity '${entityId}' not found.`,
        affected: [],
      };
    }

    let perimeter: number;
    switch (e.kind) {
      case 'line': {
        const dx = e.end[0] - e.start[0];
        const dy = e.end[1] - e.start[1];
        perimeter = Math.sqrt(dx * dx + dy * dy);
        break;
      }
      case 'polyline': {
        perimeter = 0;
        const pts = e.points;
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i]!;
          const b = pts[i + 1]!;
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          perimeter += Math.sqrt(dx * dx + dy * dy);
        }
        if (e.closed && pts.length >= 2) {
          const last = pts[pts.length - 1]!;
          const first = pts[0]!;
          const dx = first[0] - last[0];
          const dy = first[1] - last[1];
          perimeter += Math.sqrt(dx * dx + dy * dy);
        }
        break;
      }
      case 'rectangle':
        perimeter = 2 * (e.width + e.height);
        break;
      case 'circle':
        perimeter = 2 * Math.PI * e.radius;
        break;
      case 'arc': {
        // Normalize angle span to [0, 2π].
        let span = e.endAngle - e.startAngle;
        if (span < 0) span += 2 * Math.PI;
        perimeter = e.radius * span;
        break;
      }
      default:
        return {
          document: doc,
          summary:
            `measure_perimeter: entity '${entityId}' is kind '${e.kind}'; ` +
            "supported kinds are 'line', 'polyline', 'rectangle', 'circle', 'arc'.",
          affected: [],
        };
    }

    const data: MeasurePerimeterData = { perimeter, unit: doc.units };
    return {
      document: doc,
      summary: `Perimeter of ${entityId} = ${formatLength(doc, perimeter)}.`,
      affected: [],
      data,
    };
  },
});
