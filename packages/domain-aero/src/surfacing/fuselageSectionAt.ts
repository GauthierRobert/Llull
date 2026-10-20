/** fuselage_section_at: the cross-section of a lofted fuselage at a station, measured on its exact skin. */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { placedSurface } from '@core/geometry/nurbsSurface';
import type { Vec3 } from '@core/model/types';
import { interpolatePoints } from '@lib/nurbs/interpolate';
import { evaluateSurface, surfaceDomain } from '@lib/nurbs/surface';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { briefNumbers, sig } from '../shared/results';
import { frameOf, toAircraft } from './aircraftFrame';
import { aeroOf } from './aeroState';
import { refuseAero } from './codes';

const RING_SAMPLES = 128;
const BISECTIONS = 60;

/** One ring of `count` points (aircraft coordinates) where the skin crosses the plane FS = `fs`; the ring is closed (first = last). */
function ringAt(surface: NurbsSurfaceData, toFrame: (point: Vec3) => Vec3, fs: number, count: number): Vec3[] {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const points: Vec3[] = [];
  for (let k = 0; k <= count; k++) {
    const u = k === count ? u0 : u0 + ((u1 - u0) * k) / count;
    let [low, high] = [v0, v1];
    const sign = Math.sign((toFrame(evaluateSurface(surface, u, low))[0] as number) - fs) || -1;
    for (let step = 0; step < BISECTIONS; step++) {
      const mid = (low + high) / 2;
      const side = Math.sign((toFrame(evaluateSurface(surface, u, mid))[0] as number) - fs);
      if (side === 0) {
        [low, high] = [mid, mid];
        break;
      }
      if (side === sign) low = mid;
      else high = mid;
    }
    points.push(toFrame(evaluateSurface(surface, u, (low + high) / 2)));
  }
  return points;
}

/** Area and perimeter of the polygon through `ring` (aircraft BL, WL coordinates). */
function polygonMeasures(ring: ReadonlyArray<Vec3>): { area: number; perimeter: number } {
  let [twiceArea, perimeter] = [0, 0];
  for (let i = 1; i < ring.length; i++) {
    const [a, b] = [ring[i - 1] as Vec3, ring[i] as Vec3];
    twiceArea += (a[1] as number) * (b[2] as number) - (b[1] as number) * (a[2] as number);
    perimeter += Math.hypot((b[1] as number) - (a[1] as number), (b[2] as number) - (a[2] as number));
  }
  return { area: Math.abs(twiceArea) / 2, perimeter };
}

/**
 * @affects none; data = { bodyId, fs, halfBreadth, crownWl, keelWl, wlMaxBreadth, area, perimeter, fsRange, curve { degree, poles }, unit, areaUnit, provenance }
 * @invariant measured on the exact skin (bisection per ring point); area and perimeter are Richardson-extrapolated polygon sums (error well below 1e-4 relative)
 * @failure unknown body -> AERO_BODY_NOT_FOUND; fs outside the stations -> AERO_FS_OUT_OF_RANGE; non-finite fs -> AERO_PARAM_INVALID
 */
export const fuselageSectionAt = defineCommand({
  name: 'fuselage_section_at',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only cross-section of a fuselage made by loft_fuselage, cut by the plane FS = `fs` of the aircraft frame (set_aircraft_frame; default FS along +x). ' +
    'Measured on the exact skin, not on a mesh. Returns, in aircraft coordinates and document units: halfBreadth (half the BL extent), crownWl ' +
    '(highest WL), keelWl (lowest WL), wlMaxBreadth (WL where the section is widest), area (document units squared) and perimeter, plus a closed cubic ' +
    '`curve` (degree and poles [fs, bl, wl]) through 128 points of the section. At an apex (point station) the area is 0 and `curve` is null. ' +
    'Reference: a circle station of radius 2 gives area 12.566 and perimeter 12.566. `bodyId` is the id returned by loft_fuselage.',
  params: z.object({
    bodyId: z.string().describe('Id of the fuselage (the nurbs_surface id returned by loft_fuselage).'),
    fs: z.number().describe('Fuselage station of the cutting plane, document units; within the first and last station of the body.'),
  }),
  run: (doc, { bodyId, fs }): CommandResult => {
    const refuse = (code: string, message: string, path: string): CommandResult =>
      refuseAero(doc, 'fuselage_section_at', code, message, [bodyId], [`params.${path}`]);
    if (!Number.isFinite(fs)) return refuse('AERO_PARAM_INVALID', 'fs must be a finite number', 'fs');
    const body = aeroOf(doc).bodies?.[bodyId];
    const entity = doc.entities[bodyId];
    if (body === undefined || entity?.kind !== 'nurbs_surface')
      return refuse('AERO_BODY_NOT_FOUND', `"${bodyId}" is not a fuselage made by loft_fuselage (or its surface was deleted)`, 'bodyId');
    const range: [number, number] = [body.stations[0]?.fs as number, body.stations[body.stations.length - 1]?.fs as number];
    const slack = 1e-9 * Math.max(1, Math.abs(range[1] - range[0]));
    if (fs < range[0] - slack || fs > range[1] + slack)
      return refuse('AERO_FS_OUT_OF_RANGE', `fs ${fs} is outside the body stations ${range[0]}..${range[1]}`, 'fs');
    const frame = frameOf(doc);
    const toFrame = (point: Vec3): Vec3 => toAircraft(frame, point);
    // the stations are in frame coordinates: the cutting plane is FS = fs in that frame
    const surface = placedSurface(entity);
    const ring = ringAt(surface, toFrame, fs, RING_SAMPLES);
    const coarse = ringAt(surface, toFrame, fs, RING_SAMPLES / 2);
    const [fine, rough] = [polygonMeasures(ring), polygonMeasures(coarse)];
    const area = (4 * fine.area - rough.area) / 3;
    const perimeter = (4 * fine.perimeter - rough.perimeter) / 3;
    const [bls, wls] = [ring.map((p) => p[1] as number), ring.map((p) => p[2] as number)];
    const [minBl, maxBl, minWl, maxWl] = [Math.min(...bls), Math.max(...bls), Math.min(...wls), Math.max(...wls)];
    const widest = ring.reduce((best, p) =>
      Math.abs((p[1] as number) - (minBl + maxBl) / 2) > Math.abs((best[1] as number) - (minBl + maxBl) / 2) ? p : best,
    );
    const apex = perimeter < 1e-9 * Math.max(1, Math.abs(range[1] - range[0]));
    const through = apex ? null : interpolatePoints(ring.slice(0, -1).concat([ring[0] as Vec3]), { degree: 3, parameterization: 'chord' });
    const curve =
      through === null || 'code' in through
        ? null
        : { degree: through.curve.degree, poles: through.curve.poles.map((p) => [sig(p[0]), sig(p[1]), sig(p[2])]) };
    const data = {
      bodyId,
      fs,
      halfBreadth: sig((maxBl - minBl) / 2),
      crownWl: sig(maxWl),
      keelWl: sig(minWl),
      wlMaxBreadth: sig(widest[2] as number),
      area: sig(apex ? 0 : area),
      perimeter: sig(apex ? 0 : perimeter),
      fsRange: range,
      curve,
      unit: doc.units,
      areaUnit: `${doc.units}^2`,
      unverified: false,
      provenance: {
        method: 'bisection of the exact skin along each ring isoline at FS = fs; Richardson-extrapolated polygon area and perimeter',
        reference: 'Piegl & Tiller, The NURBS Book, A4.3 (rational surface point)',
        inputs: { bodyId, fs, samples: RING_SAMPLES },
      },
    };
    return report(
      doc,
      briefNumbers(
        `fuselage_section_at ${bodyId} FS ${fs}: half breadth ${data.halfBreadth}, crown WL ${data.crownWl}, keel WL ${data.keelWl}, area ${data.area} ${doc.units}^2, perimeter ${data.perimeter} ${doc.units}.`,
      ),
      data,
    );
  },
});
