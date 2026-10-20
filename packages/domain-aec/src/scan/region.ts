/** Regions and frames: a RegionSpec (document units) as a document-frame region in metres, and its asset-frame bounding box for the port. */

import type { CloudBounds, CloudReference, PointCloudPort, RegionSpec } from '@core/model/pointCloud';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { applyPoint, invertAffine } from './mat4';
import { scanOf, toM, vecToM } from './model';

/** A region in the document frame, metres (what `llull-compute cloud op` receives). */
export type MetricRegion =
  | { readonly kind: 'all' }
  | { readonly kind: 'box'; readonly min: Vec3; readonly max: Vec3 }
  | { readonly kind: 'seed'; readonly point: Vec3; readonly radius: number };

export type RegionResolution =
  | { readonly ok: true; readonly region: MetricRegion }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A RegionSpec as the params schema delivers it (points as validated number lists). */
export type RegionInput =
  | { readonly kind: 'all' }
  | { readonly kind: 'box'; readonly min: readonly number[]; readonly max: readonly number[] }
  | { readonly kind: 'seed'; readonly point: readonly number[]; readonly radius: number }
  | { readonly kind: 'crop'; readonly cropId: string };

/** The stored RegionSpec of an input. */
export function regionSpec(input: RegionInput): RegionSpec {
  const v = (p: readonly number[]): Vec3 => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  if (input.kind === 'box') return { kind: 'box', min: v(input.min), max: v(input.max) };
  if (input.kind === 'seed') return { kind: 'seed', point: v(input.point), radius: input.radius };
  return input;
}

/** The metric region of `spec`. */
export function resolveRegion(doc: CadDocument, spec: RegionInput): RegionResolution {
  if (spec.kind === 'all') return { ok: true, region: { kind: 'all' } };
  if (spec.kind === 'seed') {
    if (!(spec.radius > 0)) return { ok: false, code: 'SCN_PARAM_INVALID', message: 'region.radius must be > 0' };
    return { ok: true, region: { kind: 'seed', point: vecToM(doc, spec.point), radius: toM(doc, spec.radius) } };
  }
  let box: { min: readonly number[]; max: readonly number[] } = spec.kind === 'box' ? spec : { min: [], max: [] };
  if (spec.kind === 'crop') {
    const crops = scanOf(doc).crops;
    const crop = Object.hasOwn(crops, spec.cropId) ? crops[spec.cropId] : undefined;
    if (crop === undefined) return { ok: false, code: 'SCN_CROP_NOT_FOUND', message: `no crop '${spec.cropId}'` };
    if (crop.keep !== 'inside')
      return { ok: false, code: 'SCN_CROP_INVALID', message: `crop '${spec.cropId}' keeps the outside; only an inside crop is a region` };
    box = crop;
  }
  if ([0, 1, 2].some((axis) => !((box.min[axis] ?? 0) < (box.max[axis] ?? 0))))
    return { ok: false, code: 'SCN_CROP_INVALID', message: 'region min must be < max on every axis' };
  return { ok: true, region: { kind: 'box', min: vecToM(doc, box.min), max: vecToM(doc, box.max) } };
}

/** Whether document-frame point `p` (metres) lies in `region`. */
export function inRegion(region: MetricRegion, p: Vec3): boolean {
  if (region.kind === 'all') return true;
  if (region.kind === 'box') return [0, 1, 2].every((a) => (p[a] ?? 0) >= (region.min[a] ?? 0) && (p[a] ?? 0) <= (region.max[a] ?? 0));
  return Math.hypot(p[0] - region.point[0], p[1] - region.point[1], p[2] - region.point[2]) <= region.radius;
}

/** Asset-frame bounding box of a document-frame region (undefined = the whole asset). */
export function assetBox(cloud: CloudReference, region: MetricRegion): CloudBounds | undefined {
  if (region.kind === 'all') return undefined;
  const inverse = invertAffine(cloud.transform);
  if (inverse === null) return undefined;
  const [low, high] =
    region.kind === 'box'
      ? [region.min, region.max]
      : [region.point.map((v) => v - region.radius) as unknown as Vec3, region.point.map((v) => v + region.radius) as unknown as Vec3];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p = applyPoint(inverse, [corner & 1 ? high[0] : low[0], corner & 2 ? high[1] : low[1], corner & 4 ? high[2] : low[2]]);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a] ?? 0, p[a] ?? 0);
      max[a] = Math.max(max[a] ?? 0, p[a] ?? 0);
    }
  }
  return { min: [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0], max: [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0] };
}

/** The installed port, or null. */
export const portOf = (ctx: { readonly pointClouds?: PointCloudPort | null } | undefined): PointCloudPort | null =>
  ctx?.pointClouds ?? null;
