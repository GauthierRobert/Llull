/**
 * Hold lines (BLD M4, TECHNICAL_SPEC §5.6): a curve drawn on one of the two faces of an edge fixes where the blend leaves that face. On planar
 * faces at a constant wedge the radius follows from the distance h(s) of the curve to the edge: r(s) = h(s) / tan(fold / 2) (the contact of a ball of radius r lies r tan(fold / 2)
 * from the edge), fold being the angle between the outward normals (90 degrees: r = h). Pure: edge stations and the polyline in, a straight-piece radius law out.
 * @failure a curve that is off the face plane, or does not cross the face at every station -> a problem naming which
 */

import type { EdgeRadius, Vec3 } from '../../model/types';
import { cross3, dot3, normalize3, scale3, sub3 } from '../../lib/vec3';

/** One point of the shared edge with its unit tangent. */
export interface HoldStation {
  readonly t: number;
  readonly point: Vec3;
  readonly tangent: Vec3;
}

export type HoldResult = { readonly law: EdgeRadius } | { readonly problem: string; readonly offFace: boolean };

/** Largest distance of the hold curve from the face plane (relative to the model size) still counted as on the face. */
const ON_FACE_TOLERANCE = 1e-6;
/** Interior stations whose radius is within this fraction of the straight piece between their neighbours are dropped. */
const COLLINEAR = 1e-9;

/** Distance along `direction` from `origin` to the polyline, or null when the ray misses it (segments solved in the plane of `normal`). */
function distanceToPolyline(origin: Vec3, direction: Vec3, polyline: readonly Vec3[], normal: Vec3, scale: number): number | null {
  let best: number | null = null;
  for (let k = 0; k + 1 < polyline.length; k++) {
    const from = polyline[k];
    const to = polyline[k + 1];
    if (from === undefined || to === undefined) continue;
    const segment = sub3(to, from);
    // origin + lambda * direction = from + mu * segment: cross both sides with `segment` (and `direction`) along the plane normal
    const denominator = dot3(cross3(direction, segment), normal);
    if (Math.abs(denominator) < 1e-12 * scale * scale) continue;
    const toFrom = sub3(from, origin);
    const lambda = dot3(cross3(toFrom, segment), normal) / denominator;
    const mu = dot3(cross3(toFrom, direction), normal) / denominator;
    if (lambda > 1e-9 * scale && mu >= -1e-9 && mu <= 1 + 1e-9 && (best === null || lambda < best)) best = lambda;
  }
  return best;
}

/**
 * The straight-piece radius law of the blend whose contact line on the face with outward normal `faceNormal` is `polyline`.
 * `fold` is the angle between the outward normals of the two faces; `scale` the model size (tolerances).
 */
export function holdLineLaw(
  stations: readonly HoldStation[],
  polyline: readonly Vec3[],
  faceNormal: Vec3,
  fold: number,
  scale: number,
): HoldResult {
  const first = stations[0]?.point;
  if (first === undefined || polyline.length < 2) return { problem: 'the hold line needs at least two points', offFace: false };
  const off = polyline.reduce((largest, point) => Math.max(largest, Math.abs(dot3(sub3(point, first), faceNormal))), 0);
  if (off > ON_FACE_TOLERANCE * Math.max(scale, 1)) return { problem: `the hold line is ${off} off the face plane`, offFace: true };
  for (const sign of [1, -1]) {
    const heights: Array<{ t: number; radius: number }> = [];
    for (const station of stations) {
      const direction = normalize3(cross3(faceNormal, station.tangent));
      const toward = scale3(direction, sign);
      const height = distanceToPolyline(station.point, toward, polyline, faceNormal, scale);
      if (height === null) break;
      heights.push({ t: station.t, radius: Number((height / Math.tan(fold / 2)).toPrecision(12)) });
    }
    if (heights.length < stations.length) continue;
    return { law: lawOfHeights(heights) };
  }
  return { problem: 'the hold line does not cross the face at every position along the edge', offFace: true };
}

/** A straight-piece law through (t, radius) samples, dropping interior samples that lie on the straight piece between their neighbours. */
function lawOfHeights(samples: ReadonlyArray<{ readonly t: number; readonly radius: number }>): EdgeRadius {
  const kept = samples.filter((sample, k) => {
    const before = samples[k - 1];
    const after = samples[k + 1];
    if (before === undefined || after === undefined) return true;
    const along = ((sample.t - before.t) / (after.t - before.t)) * (after.radius - before.radius) + before.radius;
    return Math.abs(along - sample.radius) > COLLINEAR * Math.max(sample.radius, 1);
  });
  const [head] = kept;
  const tail = kept[kept.length - 1];
  return {
    size: head?.radius ?? 0,
    sizeEnd: tail?.radius ?? 0,
    sizes: kept.slice(1, -1).map((sample) => ({ t: sample.t, size: sample.radius })),
    interpolation: 'linear',
  };
}
