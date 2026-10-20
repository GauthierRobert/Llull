/** slice_cloud (TECHNICAL_SPEC §4.2, FR-SCN-16): a planar slab of the cloud in plane coordinates, with fitted circles or lines; query only. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { refuseScan } from './codes';
import { cloudAccess, isAccess } from './access';
import { isSuccess, numberAt, runOp } from './compute';
import { fromM, toM, vecFromM, vecToM } from './model';
import { resolveRegion } from './region';
import { cloudIdParam, regionParam, seedParam } from './schemas';

export const MAX_SLICE_POINTS = 20_000;

const point = (text: string): z.ZodArray<z.ZodNumber> => z.array(z.number()).length(3).describe(text);

/**
 * @failure SCN_CLOUD_NOT_FOUND / SCN_ASSET_*; thickness <= 0 / zero normal -> SCN_PARAM_INVALID; bad region -> SCN_CROP_*
 */
export const sliceCloud = defineCommand({
  name: 'slice_cloud',
  description:
    `Read-only: cut a slab |(p - origin) . normal| <= thickness / 2 through a cloud and return its points in plane coordinates (u, v; ` +
    `document units, at most maxPoints <= ${MAX_SLICE_POINTS}) with the plane axes, and fitted primitives: fit "circle" finds the pipe ` +
    'sections (RANSAC + algebraic + geometric fit; centre, radius, rms, radiusStd), fit "lines" the straight edges (walls, steel). ' +
    'region bounds the points read (a crop around the section is faster on big clouds). Use it to find the header at rack level before ' +
    'extract_pipes, or to draw sections.',
  annotations: { readOnly: true },
  params: z.object({
    cloudId: cloudIdParam,
    origin: point('[x, y, z] point on the cutting plane (document units).'),
    normal: point('[x, y, z] plane normal (any length > 0).'),
    thickness: z.number().describe('Slab thickness in document units, e.g. 20 (mm).'),
    fit: z.enum(['none', 'circle', 'lines']).optional().describe('Primitives to fit in the slab (default none).'),
    maxPoints: z.number().int().positive().optional().describe(`Section points returned (default 2000, at most ${MAX_SLICE_POINTS}).`),
    region: regionParam.optional(),
    noiseSigma: z
      .number()
      .optional()
      .describe('Scanner noise sigma in document units (inlier band 3 sigma; default 2.5 x the section spacing).'),
    minRadius: z.number().optional().describe('Smallest circle radius in document units (default 5 mm).'),
    maxRadius: z.number().optional().describe('Largest circle radius in document units (default 2 m).'),
    seed: seedParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const {
      cloudId,
      origin,
      normal,
      thickness,
      fit = 'none',
      maxPoints = 2000,
      region = { kind: 'all' as const },
      noiseSigma,
      minRadius,
      maxRadius,
      seed = 1,
    } = params;
    const command = 'slice_cloud';
    if (!(thickness > 0)) return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'thickness must be > 0', [cloudId], ['thickness']);
    if (Math.hypot(normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 0) === 0)
      return refuseScan(doc, command, 'SCN_PARAM_INVALID', 'normal must not be zero', [cloudId], ['normal']);
    const access = cloudAccess(doc, command, cloudId, ctx);
    if (!isAccess(access)) return access;
    const resolved = resolveRegion(doc, region);
    if (!resolved.ok) return refuseScan(doc, command, resolved.code, resolved.message, [cloudId], ['region']);
    const ran = runOp(doc, command, access.port, 'slice', [access.cloud], {
      origin: vecToM(doc, origin),
      normal,
      thickness: toM(doc, thickness),
      fit,
      maxPoints: Math.min(maxPoints, MAX_SLICE_POINTS),
      seed,
      region: resolved.region,
      ...(noiseSigma !== undefined ? { noiseSigma: toM(doc, noiseSigma) } : {}),
      ...(minRadius !== undefined ? { minRadius: toM(doc, minRadius) } : {}),
      ...(maxRadius !== undefined ? { maxRadius: toM(doc, maxRadius) } : {}),
    });
    if (!isSuccess(ran)) return ran;
    const r = ran.result;
    const uv = (p: unknown): number[] => (Array.isArray(p) ? (p as number[]).map((v) => fromM(doc, v)) : []);
    const circles = ((r['circles'] as Record<string, unknown>[] | undefined) ?? []).map((c) => ({
      centre: vecFromM(doc, c['centre'] as number[]),
      centreUv: uv(c['centreUv']),
      radius: fromM(doc, numberAt(c, 'radius')),
      rms: fromM(doc, numberAt(c, 'rms')),
      radiusStd: typeof c['radiusStd'] === 'number' ? fromM(doc, c['radiusStd']) : null,
      inliers: c['inliers'],
    }));
    const lines = ((r['lines'] as Record<string, unknown>[] | undefined) ?? []).map((l) => ({
      start: vecFromM(doc, l['start'] as number[]),
      end: vecFromM(doc, l['end'] as number[]),
      startUv: uv(l['startUv']),
      endUv: uv(l['endUv']),
      rms: fromM(doc, numberAt(l, 'rms')),
      inliers: l['inliers'],
    }));
    const data = {
      cloudId,
      unit: doc.units,
      uAxis: r['uAxis'],
      vAxis: r['vAxis'],
      count: r['count'],
      truncated: r['truncated'],
      points: ((r['points'] as number[][] | undefined) ?? []).map(uv),
      circles,
      lines,
      band: fromM(doc, numberAt(r, 'band')),
      provenance: ran.provenance,
    };
    return report(
      doc,
      `slice_cloud ${cloudId}: ${String(r['count'])} point(s) in the slab, ${circles.length} circle(s), ${lines.length} line(s).`,
      data,
    );
  },
});
