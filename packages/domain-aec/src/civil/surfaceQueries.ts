/**
 * Read-only terrain queries: spot elevations / slopes and a surface statistics report.
 * @layer domain-aec/civil
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { civilObject, getCivil } from './model';
import { surfaceTin } from './surfaceTin';
import { elevationAt, slopeAt, tinBounds, tinPlanArea, triangleCount } from './tin';
import { toMetres } from '../model';

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

/**
 * @command surface_elevation
 * @pure
 * @affects none (read-only)
 * @failure unknown surface -> no-op
 */
export const surfaceElevation = defineCommand({
  name: 'surface_elevation',
  description:
    'Spot elevations and slopes of a terrain surface at plan points. data.points lists ' +
    '{ at, elevation (document units, null outside the TIN), slopePercent }.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    surfaceId: z.string().describe('Surface id, e.g. "surface-1".'),
    points: z.array(vec2('Plan point [x, y].')).min(1).describe('Plan points to sample.'),
  }),
  run: (doc, { surfaceId, points }): CommandResult => {
    const civil = getCivil(doc);
    const surface = civilObject(civil, surfaceId, 'surface');
    if (!surface) return noop(doc, `surface_elevation failed: no surface ${surfaceId}.`);
    const tin = surfaceTin(civil, surface);
    const samples = points.map((at) => {
      const elevation = elevationAt(tin, at);
      const slope = slopeAt(tin, at);
      return {
        at,
        elevation: elevation === null ? null : round(elevation),
        slopePercent: slope === null ? null : round(slope * 100, 2),
      };
    });
    const outside = samples.filter((sample) => sample.elevation === null).length;
    const listed = samples
      .slice(0, 5)
      .map((sample) =>
        sample.elevation === null
          ? 'outside'
          : `${toMetres(doc, sample.elevation).toFixed(3)} m (${sample.slopePercent} %)`,
      )
      .join('; ');
    return {
      document: doc,
      summary: `${surface.name}: ${listed}${samples.length > 5 ? '; …' : ''}${outside > 0 ? ` (${outside} outside the surface)` : ''}.`,
      affected: [],
      data: { surfaceId, points: samples },
    };
  },
});

/**
 * @command surface_report
 * @pure
 * @affects none (read-only)
 * @failure unknown surface -> no-op
 */
export const surfaceReport = defineCommand({
  name: 'surface_report',
  description:
    'Statistics of a terrain surface: point and triangle counts, plan area (m²), minimum / maximum / ' +
    'mean elevation (m) and mean slope (%).',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({ surfaceId: z.string().describe('Surface id, e.g. "surface-1".') }),
  run: (doc, { surfaceId }): CommandResult => {
    const civil = getCivil(doc);
    const surface = civilObject(civil, surfaceId, 'surface');
    if (!surface) return noop(doc, `surface_report failed: no surface ${surfaceId}.`);
    const tin = surfaceTin(civil, surface);
    const bounds = tinBounds(tin);
    const metres = (value: number): number => toMetres(doc, value);
    const area = metres(metres(tinPlanArea(tin)));
    let weighted = 0;
    let slopeSum = 0;
    let areaSum = 0;
    for (let t = 0; t < triangleCount(tin); t++) {
      const [a, b, c] = [0, 1, 2].map((k) => tin.points[tin.triangles[t * 3 + k] as number]) as [
        readonly [number, number, number],
        readonly [number, number, number],
        readonly [number, number, number],
      ];
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uz = b[2] - a[2];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      const vz = c[2] - a[2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const plan = Math.abs(nz) / 2;
      weighted += plan * ((a[2] + b[2] + c[2]) / 3);
      slopeSum += plan * (nz === 0 ? 0 : Math.hypot(nx, ny) / Math.abs(nz));
      areaSum += plan;
    }
    const data = {
      surfaceId,
      points: tin.points.length,
      triangles: triangleCount(tin),
      planAreaM2: round(area, 2),
      minElevationM: bounds ? round(metres(bounds.min[2])) : null,
      maxElevationM: bounds ? round(metres(bounds.max[2])) : null,
      meanElevationM: areaSum > 0 ? round(metres(weighted / areaSum)) : null,
      meanSlopePercent: areaSum > 0 ? round((slopeSum / areaSum) * 100, 2) : null,
    };
    return {
      document: doc,
      summary:
        `${surface.name}: ${data.points} points, ${data.triangles} triangles, ${data.planAreaM2} m²; ` +
        `elevation ${data.minElevationM}–${data.maxElevationM} m (mean ${data.meanElevationM} m); ` +
        `mean slope ${data.meanSlopePercent} %.`,
      affected: [],
      data,
    };
  },
});
