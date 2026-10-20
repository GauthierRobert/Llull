/** loft_fuselage_from_master_lines: Liming's master-line workflow - crown, keel and max-breadth lines plus a rho law give a conic section at ANY station. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { execute } from '@core/commands/registry';
import { placedCurve } from '@core/geometry/nurbsSurface';
import type { Vec3 } from '@core/model/types';
import { curveDomain, evaluateCurve } from '@lib/nurbs/evaluate';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { frameOf, toAircraft } from './aircraftFrame';
import { refuseAero } from './codes';

const MAX_STATIONS = 60;
const DEFAULT_RHO = Math.SQRT2 - 1;

/** The point of `line` (aircraft coordinates) whose FS equals `fs`, by bisection on the curve parameter; null when `fs` is outside its extent. */
function pointAt(line: NurbsCurveData, toFrame: (p: Vec3) => Vec3, fs: number): Vec3 | null {
  const [t0, t1] = curveDomain(line);
  const [f0, f1] = [toFrame(evaluateCurve(line, t0))[0] as number, toFrame(evaluateCurve(line, t1))[0] as number];
  const slack = 1e-9 * Math.max(1, Math.abs(f1 - f0));
  if (fs < Math.min(f0, f1) - slack || fs > Math.max(f0, f1) + slack) return null;
  let [low, high] = [t0, t1];
  const increasing = f1 >= f0;
  for (let step = 0; step < 80; step++) {
    const mid = (low + high) / 2;
    const value = toFrame(evaluateCurve(line, mid))[0] as number;
    if (value < fs === increasing) low = mid;
    else high = mid;
  }
  return toFrame(evaluateCurve(line, (low + high) / 2));
}

/** Piecewise-linear law through `table` ([fs, value] pairs sorted by fs), constant outside. */
function law(table: ReadonlyArray<readonly [number, number]>, fs: number): number {
  const first = table[0] as readonly [number, number];
  const last = table[table.length - 1] as readonly [number, number];
  if (fs <= first[0]) return first[1];
  if (fs >= last[0]) return last[1];
  const k = table.findIndex(([x]) => x >= fs);
  const [a, b] = [table[k - 1] as readonly [number, number], table[k] as readonly [number, number]];
  return a[1] + ((b[1] - a[1]) * (fs - a[0])) / (b[0] - a[0] || 1);
}

const rhoTable = z
  .array(z.tuple([z.number(), z.number()]))
  .describe('Rho law as [fs, rho] pairs sorted by increasing fs, each rho in (0, 1); linear between the pairs, constant outside.');

/**
 * @affects creates 1 nurbs_surface (the fuselage skin) and doc.aero.bodies[id], through loft_fuselage
 * @invariant every station section is the conic section of the three master lines at that FS with the rho of the law there (exact rational NURBS)
 * @failure fs not increasing / master line missing a station / crown not above the max-breadth point above the keel -> AERO_PARAM_INVALID / AERO_MASTER_INCONSISTENT; a non-curve id -> SRF_NOT_NURBS; rho outside (0, 1) -> SRF_CONIC_RHO_RANGE
 */
export const loftFuselageFromMasterLines = defineCommand({
  name: 'loft_fuselage_from_master_lines',
  description:
    'Fuselage from Liming master lines: three longitudinal nurbs_curve lines in the aircraft frame (FS = x by default) define the conic sections at ANY ' +
    'station - `crownId` (the crown, WL of the top of the section along FS), `keelId` (the keel, WL of the bottom) and `breadthId` (the maximum-breadth ' +
    'line: its BL is the half breadth and its WL the water line of the widest point). `stations` lists the FS values to cut (2..60, strictly increasing, ' +
    'each inside the extent of all three lines); the conic shoulder `rho` follows `rhoUpper` / `rhoLower` laws (default the circular 0.4142). A station where ' +
    'crown, keel and breadth coincide becomes an apex (nose or tail, first or last station only). The sections are then lofted exactly like loft_fuselage ' +
    '(same result, definition stored in doc.aero.bodies). Make the master lines with interpolate_curve through points [fs, 0, wl] (crown, keel) and ' +
    '[fs, halfBreadth, wl] (breadth). Reference: crown z = r(x), keel z = -r(x), breadth y = r(x) at wl 0 with r the Sears-Haack radius gives the Sears-Haack body.',
  params: z.object({
    crownId: z.string().describe('nurbs_curve id of the crown line (points [fs, 0, wl]).'),
    keelId: z.string().describe('nurbs_curve id of the keel line (points [fs, 0, wl]).'),
    breadthId: z.string().describe('nurbs_curve id of the max-breadth line (points [fs, halfBreadth, wl]; the BL is the half breadth).'),
    stations: z
      .array(z.number())
      .describe('2..60 strictly increasing FS values (aircraft frame, document units) where sections are derived.'),
    rhoUpper: rhoTable.optional(),
    rhoLower: rhoTable.optional(),
    degreeV: z.number().describe('Degree of the skin along the fuselage, integer 1..5. Default 3.').optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { crownId, keelId, breadthId, stations, degreeV } = params;
    const refuse = (code: string, message: string, path: string, ids: string[] = []): CommandResult =>
      refuseAero(doc, 'loft_fuselage_from_master_lines', code, message, ids, [`params.${path}`]);
    if (stations.length < 2 || stations.length > MAX_STATIONS)
      return refuse('SRF_LOFT_SECTIONS_TOO_FEW', `a fuselage needs 2..${MAX_STATIONS} stations (got ${stations.length})`, 'stations');
    const unordered = stations.findIndex((fs, i) => i > 0 && !(fs > (stations[i - 1] as number)));
    if (unordered > 0)
      return refuse('AERO_FS_NOT_INCREASING', `station ${unordered} is not beyond station ${unordered - 1}`, `stations.${unordered}`);
    const lines: NurbsCurveData[] = [];
    for (const [path, id] of [
      ['crownId', crownId],
      ['keelId', keelId],
      ['breadthId', breadthId],
    ] as const) {
      const entity = doc.entities[id];
      if (entity?.kind !== 'nurbs_curve') return refuse('SRF_NOT_NURBS', `"${id}" is not a nurbs_curve`, path, [id]);
      lines.push(placedCurve(entity));
    }
    for (const [path, table] of [
      ['rhoUpper', params.rhoUpper],
      ['rhoLower', params.rhoLower],
    ] as const) {
      if (table === undefined) continue;
      if (
        table.length === 0 ||
        table.some(([fs, rho], i) => !(rho > 0 && rho < 1) || (i > 0 && !(fs > (table[i - 1] as [number, number])[0])))
      )
        return refuse('SRF_CONIC_RHO_RANGE', `${path} needs pairs with increasing fs and rho in (0, 1)`, path);
    }
    const frame = frameOf(doc);
    const toFrame = (p: Vec3): Vec3 => toAircraft(frame, p);
    const [crown, keel, breadth] = lines as [NurbsCurveData, NurbsCurveData, NurbsCurveData];
    const size = Math.max((stations[stations.length - 1] as number) - (stations[0] as number), 1e-9);
    const built: Array<{ fs: number; section: Record<string, unknown> }> = [];
    for (const [index, fs] of stations.entries()) {
      const [top, bottom, widest] = [pointAt(crown, toFrame, fs), pointAt(keel, toFrame, fs), pointAt(breadth, toFrame, fs)];
      if (top === null || bottom === null || widest === null)
        return refuse('AERO_PARAM_INVALID', `FS ${fs} is outside the extent of the crown, keel or max-breadth line`, `stations.${index}`, [
          crownId,
          keelId,
          breadthId,
        ]);
      const halfBreadth = Math.abs(widest[1]);
      const eps = 1e-9 * size;
      if (halfBreadth <= eps && top[2] - bottom[2] <= eps) {
        if (index !== 0 && index !== stations.length - 1)
          return refuse(
            'AERO_MASTER_INCONSISTENT',
            `station ${index} (FS ${fs}) collapses to a point: an apex is only allowed first or last`,
            `stations.${index}`,
          );
        built.push({ fs, section: { type: 'point', wl: top[2] } });
        continue;
      }
      if (!(halfBreadth > eps && top[2] > widest[2] && widest[2] > bottom[2]))
        return refuse(
          'AERO_MASTER_INCONSISTENT',
          `at FS ${fs} the crown WL ${top[2]}, max-breadth WL ${widest[2]} and keel WL ${bottom[2]} must descend strictly with a half breadth > 0 (got ${halfBreadth})`,
          `stations.${index}`,
          [crownId, keelId, breadthId],
        );
      built.push({
        fs,
        section: {
          type: 'conic',
          halfBreadth,
          wlMaxBreadth: widest[2],
          upper: { wlExtreme: top[2], rho: params.rhoUpper === undefined ? DEFAULT_RHO : law(params.rhoUpper, fs) },
          lower: { wlExtreme: bottom[2], rho: params.rhoLower === undefined ? DEFAULT_RHO : law(params.rhoLower, fs) },
        },
      });
    }
    const result = execute(doc, 'loft_fuselage', { stations: built, ...(degreeV === undefined ? {} : { degreeV }) }, ctx);
    return result.affected.length === 0
      ? result
      : { ...result, summary: result.summary.replace(/^loft_fuselage:/, 'loft_fuselage_from_master_lines:') };
  },
});
