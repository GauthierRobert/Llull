/** Read-only cloud queries answered by the port's own reads (TECHNICAL_SPEC §4.2): describe, query points, nearest point, measure. */

import type { CommandResult } from '@core/commands/types';
import type { Vec3 } from '@core/model/vectors';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { refuseScan } from './codes';
import { cloudAccess, isAccess, type CloudAccess } from './access';
import type { CloudNearest } from '@core/model/pointCloud';
import { applyPoint, invertAffine } from './mat4';
import { fromM, scanOf, toM, vecFromM, vecToM } from './model';
import { assetBox, inRegion, resolveRegion } from './region';
import { cloudIdParam, regionParam } from './schemas';

/** Largest number of points one query_cloud_points call returns (AF-12). */
export const MAX_QUERY_POINTS = 200_000;

const point = (text: string): z.ZodArray<z.ZodNumber> => z.array(z.number()).length(3).describe(text);
const round = (value: number): number => Number(value.toPrecision(12));

/**
 * @failure SCN_CLOUD_NOT_FOUND / SCN_ASSET_UNAVAILABLE / SCN_ASSET_MISSING (document unchanged)
 */
export const describePointCloud = defineCommand({
  name: 'describe_point_cloud',
  description:
    'Read-only summary of an attached cloud in document units and frame: point count, scans (pose, count, fields), bounds and centroid ' +
    '(placed by the cloud transform), attributes, quantum (storage step, i.e. the largest coordinate error is quantum/2), CRS, the ' +
    'registration status and RMS, crops that apply, and the import warnings.',
  annotations: { readOnly: true },
  params: z.object({ cloudId: cloudIdParam }),
  run: (doc, { cloudId }, ctx): CommandResult => {
    const access = cloudAccess(doc, 'describe_point_cloud', cloudId, ctx);
    if (!isAccess(access)) return access;
    const { cloud, manifest } = access;
    const toDoc = (p: Vec3): Vec3 => vecFromM(doc, applyPoint(cloud.transform, p));
    const corners: Vec3[] = [];
    for (let c = 0; c < 8; c++) {
      const { min, max } = manifest.bounds;
      corners.push(toDoc([c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]]));
    }
    const bounds = {
      min: [0, 1, 2].map((a) => round(Math.min(...corners.map((p) => p[a] ?? 0)))),
      max: [0, 1, 2].map((a) => round(Math.max(...corners.map((p) => p[a] ?? 0)))),
    };
    const scan = scanOf(doc);
    const registration =
      cloud.registrationId !== null && Object.hasOwn(scan.registrations, cloud.registrationId)
        ? scan.registrations[cloud.registrationId]
        : undefined;
    const data = {
      cloudId,
      name: cloud.name,
      assetKey: cloud.assetKey,
      format: manifest.format,
      sourceName: manifest.sourceName,
      unit: doc.units,
      pointCount: manifest.pointCount,
      droppedRecords: manifest.dropped,
      scans: manifest.scans.map((s) => ({
        guid: s.guid,
        name: s.name,
        pointCount: s.pointCount,
        pose: s.pose,
        stationOrigin: s.stationOrigin,
        fields: s.fields,
      })),
      bounds,
      centroid: toDoc(manifest.centroid).map(round),
      attributes: manifest.attributes,
      quantum: manifest.quantum.map((q) => fromM(doc, q)),
      ...(manifest.crs !== undefined ? { crs: manifest.crs } : {}),
      placement: cloud.placement,
      registration:
        registration === undefined
          ? null
          : { id: registration.id, method: registration.method, status: registration.status, rmsM: registration.quality?.rms ?? null },
      crops: Object.values(scan.crops).filter((crop) => crop.cloudIds.length === 0 || crop.cloudIds.includes(cloudId)),
      warnings: manifest.warnings,
    };
    return report(
      doc,
      `${cloudId} "${cloud.name}": ${manifest.pointCount} points (${manifest.format}), ${manifest.scans.length} scan(s), centroid ${data.centroid.join(', ')} ${doc.units}.`,
      data,
    );
  },
});

/**
 * @failure SCN_CLOUD_NOT_FOUND / SCN_ASSET_* ; bad region -> SCN_CROP_INVALID / SCN_CROP_NOT_FOUND / SCN_PARAM_INVALID
 */
export const queryCloudPoints = defineCommand({
  name: 'query_cloud_points',
  description:
    `Read-only: points of a cloud in a region, in document units and frame, as a flat [x, y, z, …] array in canonical order (deterministic). ` +
    `lod "full" (default) returns every point in the region up to maxPoints (≤ ${MAX_QUERY_POINTS}); lod "budget" returns a level-of-detail ` +
    'subset of at most `budget` points (whole octree levels, coarse first). data.truncated says when maxPoints cut the answer (SCN_QUERY_LIMIT ' +
    'warning): narrow the region. indices are the source record numbers.',
  annotations: { readOnly: true },
  params: z.object({
    cloudId: cloudIdParam,
    region: regionParam.optional(),
    lod: z.enum(['full', 'budget']).optional().describe('full (default) or budget.'),
    budget: z.number().int().positive().optional().describe('Point budget for lod "budget" (default 20000).'),
    maxPoints: z.number().int().positive().optional().describe(`Hard cap on returned points (default 10000, at most ${MAX_QUERY_POINTS}).`),
  }),
  run: (doc, { cloudId, region = { kind: 'all' as const }, lod = 'full', budget = 20_000, maxPoints = 10_000 }, ctx): CommandResult => {
    const access = cloudAccess(doc, 'query_cloud_points', cloudId, ctx);
    if (!isAccess(access)) return access;
    const resolved = resolveRegion(doc, region);
    if (!resolved.ok) return refuseScan(doc, 'query_cloud_points', resolved.code, resolved.message, [cloudId], ['region']);
    const cap = Math.min(maxPoints, MAX_QUERY_POINTS);
    const { cloud, port, manifest } = access;
    const box = assetBox(cloud, resolved.region);
    const read = port.query(cloud.assetKey, {
      ...(box !== undefined ? { box } : {}),
      lod: lod === 'full' ? 'full' : { budget },
      maxPoints: Number.MAX_SAFE_INTEGER,
    });
    if (read === null)
      return refuseScan(doc, 'query_cloud_points', 'SCN_ASSET_MISSING', `asset ${cloud.assetKey} could not be read`, [cloudId]);
    const points: number[] = [];
    const indices: number[] = [];
    let truncated = false;
    for (let i = 0; i < read.indices.length; i++) {
      const p = applyPoint(cloud.transform, [read.positions[3 * i] ?? 0, read.positions[3 * i + 1] ?? 0, read.positions[3 * i + 2] ?? 0]);
      if (!inRegion(resolved.region, p)) continue;
      if (indices.length >= cap) {
        truncated = true;
        break;
      }
      points.push(...vecFromM(doc, p));
      indices.push(read.indices[i] ?? 0);
    }
    const data = {
      cloudId,
      unit: doc.units,
      count: indices.length,
      points,
      indices,
      truncated,
      spacing: fromM(doc, read.spacing),
      totalPoints: manifest.pointCount,
      maxQuantisationError: fromM(doc, Math.max(...manifest.quantum) / 2),
      ...(truncated ? { warnings: [{ code: 'SCN_QUERY_LIMIT', message: `maxPoints ${cap} reached; narrow the region or page` }] } : {}),
    };
    return report(doc, `${indices.length} point(s) of ${cloudId}${truncated ? ' (truncated: SCN_QUERY_LIMIT)' : ''}.`, data);
  },
});

/**
 * @failure SCN_CLOUD_NOT_FOUND / SCN_ASSET_* ; maxDistance <= 0 -> SCN_PARAM_INVALID
 */
export const nearestCloudPoint = defineCommand({
  name: 'nearest_cloud_point',
  description:
    'Read-only snap to a scan point: the cloud point nearest to `point` (document units) within maxDistance, with its source record index and ' +
    'the distance of the second-nearest point (ambiguity check: when both are close, pick a better seed). data.found is false when no point is ' +
    'within maxDistance.',
  annotations: { readOnly: true },
  params: z.object({
    cloudId: cloudIdParam,
    point: point('[x, y, z] query point (document units).'),
    maxDistance: z.number().describe('Search radius in document units, > 0.'),
  }),
  run: (doc, { cloudId, point: query, maxDistance }, ctx): CommandResult => {
    if (!(maxDistance > 0))
      return refuseScan(doc, 'nearest_cloud_point', 'SCN_PARAM_INVALID', 'maxDistance must be > 0', [cloudId], ['maxDistance']);
    const access = cloudAccess(doc, 'nearest_cloud_point', cloudId, ctx);
    if (!isAccess(access)) return access;
    const { cloud } = access;
    const found = nearestInDocument(access, vecToM(doc, query), toM(doc, maxDistance));
    if (found === null) return report(doc, `No point of ${cloudId} within ${maxDistance} ${doc.units}.`, { cloudId, found: false });
    const data = {
      cloudId: cloud.id,
      found: true,
      recordIndex: found.index,
      point: vecFromM(doc, found.position),
      distance: fromM(doc, found.distance),
      secondNearestDistance: Number.isFinite(found.secondDistance) ? fromM(doc, found.secondDistance) : null,
      unit: doc.units,
    };
    return report(doc, `Nearest point of ${cloudId}: record ${found.index} at ${data.distance.toPrecision(7)} ${doc.units}.`, data);
  },
});

/** Nearest point in the document frame (metres): the port searches the asset frame, the distances are recomputed in the document frame. */
function nearestInDocument({ cloud, port }: CloudAccess, queryM: Vec3, maxM: number): CloudNearest | null {
  const inverse = invertAffine(cloud.transform);
  if (inverse === null) return null;
  const hit = port.nearest(cloud.assetKey, applyPoint(inverse, queryM), maxM);
  if (hit === null) return null;
  const position = applyPoint(cloud.transform, hit.position);
  const distance = Math.hypot(position[0] - queryM[0], position[1] - queryM[1], position[2] - queryM[2]);
  return { index: hit.index, position, distance, secondDistance: hit.secondDistance + (distance - hit.distance) };
}

const endpoint = z
  .union([point('[x, y, z] point.'), z.object({ nearest: point('[x, y, z] seed: snaps to the nearest scan point within snapRadius.') })])
  .describe('A point [x, y, z] or {nearest: [x, y, z]} snapped to the cloud (document units).');

/**
 * @failure SCN_CLOUD_NOT_FOUND / SCN_ASSET_* ; a {nearest} end without a scan point within snapRadius -> SCN_PARAM_INVALID
 */
export const measureCloud = defineCommand({
  name: 'measure_cloud',
  description:
    'Read-only point-to-point measure on a cloud: each end is a point or {nearest: point} snapped to the closest scan point within snapRadius. ' +
    'Returns the distance, the delta [dx, dy, dz] and the snapped points (document units).',
  annotations: { readOnly: true },
  params: z.object({
    cloudId: cloudIdParam,
    from: endpoint,
    to: endpoint,
    snapRadius: z.number().optional().describe('Snap radius for {nearest} ends in document units (default 50 mm).'),
  }),
  run: (doc, { cloudId, from, to, snapRadius }, ctx): CommandResult => {
    const access = cloudAccess(doc, 'measure_cloud', cloudId, ctx);
    if (!isAccess(access)) return access;
    const radiusM = snapRadius !== undefined && snapRadius > 0 ? toM(doc, snapRadius) : 0.05;
    const ends: Vec3[] = [];
    for (const [name, end] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (Array.isArray(end)) {
        ends.push(vecToM(doc, end));
        continue;
      }
      const hit = nearestInDocument(access, vecToM(doc, (end as { nearest: number[] }).nearest), radiusM);
      if (hit === null)
        return refuseScan(
          doc,
          'measure_cloud',
          'SCN_PARAM_INVALID',
          `no scan point within ${fromM(doc, radiusM)} ${doc.units} of '${name}'`,
          [cloudId],
          [name],
        );
      ends.push(hit.position);
    }
    const [a = [0, 0, 0], b = [0, 0, 0]] = ends;
    const delta = vecFromM(doc, [b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const distance = Math.hypot(...delta);
    return report(doc, `Distance ${distance.toPrecision(7)} ${doc.units}.`, {
      cloudId,
      distance,
      delta,
      from: vecFromM(doc, a),
      to: vecFromM(doc, b),
      unit: doc.units,
    });
  },
});
