/**
 * Draft angle of a surface against a mould pull direction: draft = asin(n . pull) in degrees, with n the outward unit normal. A face
 * parallel to the pull has 0 degrees, a face looking straight against it -90, straight along it +90; negative draft is an undercut.
 */

import type { Vec3 } from '../../model/vectors';
import { cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { surfaceDerivatives, surfaceDomain } from '../../lib/nurbs/surface';
import type { DraftReport, DraftRequest, DraftSample } from './types';

const DEGREES = 180 / Math.PI;

const draftOf = (normal: Vec3, pull: Vec3): number => Math.asin(Math.max(-1, Math.min(1, dot3(normal, pull)))) * DEGREES;

function meshSamples(request: DraftRequest & { shape: { type: 'mesh' } }, pull: Vec3): DraftSample[] {
  const samples: DraftSample[] = [];
  for (const [a, b, c] of request.shape.triangles) {
    const direction = cross3(sub3(b, a), sub3(c, a));
    const doubled = len3(direction);
    if (!(doubled > 1e-300)) continue;
    const normal = scale3(direction, (request.flip ? -1 : 1) / doubled);
    samples.push({
      point: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
      draftDeg: draftOf(normal, pull),
      area: doubled / 2,
    });
  }
  return samples;
}

function surfaceSamples(request: DraftRequest & { shape: { type: 'surface' } }, pull: Vec3): DraftSample[] {
  const { surface } = request.shape;
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const n = Math.max(1, request.grid);
  const samples: DraftSample[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const [u, v] = [u0 + ((u1 - u0) * (i + 0.5)) / n, v0 + ((v1 - v0) * (j + 0.5)) / n];
      const d = surfaceDerivatives(surface, u, v, 1);
      const [point, su, sv] = [(d[0] as Vec3[])[0] as Vec3, (d[1] as Vec3[])[0] as Vec3, (d[0] as Vec3[])[1] as Vec3];
      const direction = cross3(su, sv);
      const stretch = len3(direction);
      if (!(stretch > 1e-12)) continue;
      const normal = scale3(normalize3(direction), request.flip ? -1 : 1);
      samples.push({ point, draftDeg: draftOf(normal, pull), area: (stretch * (u1 - u0) * (v1 - v0)) / (n * n) });
    }
  return samples;
}

/**
 * @invariant `pull` need not be unit length (it is normalised); area figures are the sums of the sample areas
 */
export function analyzeDraft(request: DraftRequest): DraftReport {
  const pull = normalize3(request.pull);
  const samples =
    request.shape.type === 'mesh'
      ? meshSamples({ ...request, shape: request.shape }, pull)
      : surfaceSamples({ ...request, shape: request.shape }, pull);
  let [minDeg, maxDeg, totalArea, areaBelowMin, undercutArea] = [Infinity, -Infinity, 0, 0, 0];
  for (const sample of samples) {
    minDeg = Math.min(minDeg, sample.draftDeg);
    maxDeg = Math.max(maxDeg, sample.draftDeg);
    totalArea += sample.area;
    if (sample.draftDeg < request.minDraftDeg) areaBelowMin += sample.area;
    if (sample.draftDeg < 0) undercutArea += sample.area;
  }
  return {
    samples,
    minDeg: samples.length === 0 ? 0 : minDeg,
    maxDeg: samples.length === 0 ? 0 : maxDeg,
    totalArea,
    areaBelowMin,
    undercutArea,
  };
}
