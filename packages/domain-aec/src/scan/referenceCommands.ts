/** Cloud references (TECHNICAL_SPEC §4.1): attach, update, detach. Numbers only; no point enters the document (TR-SCN-04). */

import type { CloudReference } from '@aec/scan/types';
import type { Mat4 } from '@core/model/pointCloud';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import { nextId } from '@lib/id';
import { calibrationOf } from '../civil/crs/crs';
import { refuseScan } from './codes';
import { IDENTITY, isAffine, sameTransform } from './mat4';
import { cloudsOf, findCloud, metresPerUnit, scanOf, withScan } from './model';
import { cloudIdParam, mat4Param } from './schemas';

const ASSET_KEY = /^[0-9a-f]{64}$/;

/** Grid (projected, metres) → local document frame (metres) from the civil site calibration (2D Helmert, z unchanged). */
function gridPlacement(doc: CadDocument): Mat4 | null {
  const calibration = calibrationOf(doc);
  if (calibration === undefined) return null;
  const theta = (calibration.rotationDeg * Math.PI) / 180;
  const c = Math.cos(theta) / calibration.scaleFactor;
  const s = Math.sin(theta) / calibration.scaleFactor;
  const mpu = metresPerUnit(doc);
  const [gx, gy] = [calibration.gridOrigin[0] * mpu, calibration.gridOrigin[1] * mpu];
  const [lx, ly] = [calibration.localOrigin[0] * mpu, calibration.localOrigin[1] * mpu];
  return [c, s, 0, lx - (c * gx + s * gy), -s, c, 0, ly - (-s * gx + c * gy), 0, 0, 1, 0, 0, 0, 0, 1];
}

/**
 * @affects adds 1 CloudReference to doc.scan (affected: [cloudId]); no entity
 * @invariant no point is copied into the document; the id is step-scoped (`cloud-<step>.<k>`); without a port the reference is still
 *   recorded, and nothing stored depends on the port (name, sourceSha256, display come from params), so replay without the asset gives
 *   the same document (TR-SCN-04)
 * @failure bad key -> SCN_PARAM_INVALID; key unknown to an installed port -> SCN_ASSET_MISSING; asset already attached ->
 *   SCN_CLOUD_DUPLICATE; grid without a site calibration -> SCN_CRS_NO_CALIBRATION; non-affine transform -> SCN_PARAM_INVALID
 */
export const attachPointCloud = defineCommand({
  name: 'attach_point_cloud',
  description:
    'Attach an imported point cloud to the document by its asset key (printed by `llull scan import <file>`). The document stores a reference ' +
    '(key, name, placement transform, display settings), never the points, so it stays small and replays without the scan. placement "grid" ' +
    'places a georeferenced cloud (projected metres) next to the local model through the civil site calibration (set_site_calibration). ' +
    '`transform` (asset -> document, metres) overrides the placement. Then use describe_point_cloud, query_cloud_points, slice_cloud, ' +
    'fit_primitive, extract_pipes, compute_registration, cloud_to_model_deviation, check_asbuilt_clash and check_point_clouds.',
  params: z.object({
    assetKey: z.string().describe('Asset key (64 hex) from `llull scan import`.'),
    sourceSha256: z.string().optional().describe('Optional sha256 of the source file, cross-checked against the asset manifest.'),
    name: z.string().optional().describe('Display name. Default: the source file name (or "cloud").'),
    placement: z
      .enum(['local', 'grid'])
      .optional()
      .describe('local (default): asset coordinates are document coordinates; grid: via the site calibration.'),
    transform: mat4Param.optional(),
  }),
  run: (doc, { assetKey, sourceSha256, name, placement = 'local', transform }, ctx): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseScan(doc, 'attach_point_cloud', code, message, [], paths);
    if (!ASSET_KEY.test(assetKey)) return fail('SCN_PARAM_INVALID', 'assetKey must be 64 lower-case hex digits', ['assetKey']);
    if (transform !== undefined && !isAffine(transform))
      return fail('SCN_PARAM_INVALID', 'transform is not an invertible affine 4 x 4', ['transform']);
    const duplicate = cloudsOf(doc).find((cloud) => cloud.assetKey === assetKey);
    if (duplicate !== undefined)
      return fail('SCN_CLOUD_DUPLICATE', `asset ${assetKey.slice(0, 12)}… is already attached as ${duplicate.id}`, ['assetKey']);
    const port = ctx?.pointClouds ?? null;
    const manifest = port?.manifest(assetKey) ?? null;
    if (port !== null && manifest === null)
      return fail('SCN_ASSET_MISSING', `asset ${assetKey} is not in this machine's store`, ['assetKey']);
    if (manifest !== null && sourceSha256 !== undefined && manifest.sourceSha256 !== sourceSha256)
      return fail('SCN_PARAM_INVALID', `the asset was imported from ${manifest.sourceSha256}, not ${sourceSha256}`, ['sourceSha256']);
    let placed: Mat4 = transform ?? IDENTITY;
    if (transform === undefined && placement === 'grid') {
      const grid = gridPlacement(doc);
      if (grid === null) return fail('SCN_CRS_NO_CALIBRATION', 'placement "grid" needs a site calibration', ['placement']);
      placed = grid;
    }
    const id = nextId('cloud');
    const reference: CloudReference = {
      id,
      name: name?.trim() || `scan ${assetKey.slice(0, 8)}`,
      assetKey,
      sourceSha256: sourceSha256 ?? '',
      placement,
      transform: placed,
      registrationId: null,
      display: { visible: true, colorBy: 'rgb', pointSize: 2 },
    };
    const scan = scanOf(doc);
    const facts =
      manifest === null ? ' (no point-cloud port here: the asset was not checked)' : `, ${manifest.pointCount} points (${manifest.format})`;
    return changed(
      withScan(doc, { ...scan, clouds: { ...scan.clouds, [id]: reference }, cloudOrder: [...scan.cloudOrder, id] }),
      `Attached point cloud ${id} "${reference.name}"${facts}, placement ${placement}.`,
      [id],
    );
  },
});

/**
 * @affects 1 CloudReference (affected: [cloudId])
 * @invariant a changed transform makes the extractions of that cloud stale (reported by check_point_clouds)
 * @failure unknown id -> SCN_CLOUD_NOT_FOUND; nothing to change / bad transform / pointSize <= 0 -> SCN_PARAM_INVALID
 */
export const updatePointCloud = defineCommand({
  name: 'update_point_cloud',
  description:
    'Change an attached cloud: name, visibility, colour mode (rgb, intensity, elevation, classification, single), point size in pixels, or its ' +
    'asset -> document transform (metres). Changing the transform makes fits committed from this cloud stale (check_point_clouds warns ' +
    'SCN_EXTRACTION_STALE); prefer apply_registration, which records how the transform was obtained.',
  params: z.object({
    cloudId: cloudIdParam,
    name: z.string().optional().describe('New display name.'),
    visible: z.boolean().optional().describe('Show or hide the cloud.'),
    colorBy: z.enum(['rgb', 'intensity', 'elevation', 'classification', 'single']).optional().describe('Colour mode.'),
    pointSize: z.number().optional().describe('Point size in pixels, > 0.'),
    transform: mat4Param.optional(),
  }),
  run: (doc, { cloudId, name, visible, colorBy, pointSize, transform }): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseScan(doc, 'update_point_cloud', code, message, [cloudId], paths);
    const cloud = findCloud(doc, cloudId);
    if (cloud === undefined) return fail('SCN_CLOUD_NOT_FOUND', `no attached cloud '${cloudId}'`, ['cloudId']);
    if (pointSize !== undefined && !(pointSize > 0)) return fail('SCN_PARAM_INVALID', 'pointSize must be > 0', ['pointSize']);
    if (transform !== undefined && !isAffine(transform))
      return fail('SCN_PARAM_INVALID', 'transform is not an invertible affine 4 x 4', ['transform']);
    if ([name, visible, colorBy, pointSize, transform].every((value) => value === undefined))
      return fail('SCN_PARAM_INVALID', 'nothing to change: give name, visible, colorBy, pointSize or transform');
    const moved = transform !== undefined && !sameTransform(transform, cloud.transform);
    const next: CloudReference = {
      ...cloud,
      ...(name !== undefined && name.trim() !== '' ? { name: name.trim() } : {}),
      ...(transform !== undefined ? { transform } : {}),
      ...(moved ? { registrationId: null } : {}),
      display: {
        visible: visible ?? cloud.display.visible,
        colorBy: colorBy ?? cloud.display.colorBy,
        pointSize: pointSize ?? cloud.display.pointSize,
      },
    };
    const scan = scanOf(doc);
    return changed(
      withScan(doc, { ...scan, clouds: { ...scan.clouds, [cloudId]: next } }),
      `Updated point cloud ${cloudId}${moved ? ' (new transform: its committed extractions are now stale; the registration link was cleared)' : ''}.`,
      [cloudId],
    );
  },
});

/**
 * @affects removes 1 CloudReference (affected: [cloudId]); the asset stays in the store; committed as-built pipe runs and their extraction
 *   records stay (provenance kept); registrations naming the cloud stay as history
 * @failure unknown id -> SCN_CLOUD_NOT_FOUND
 */
export const detachPointCloud = defineCommand({
  name: 'detach_point_cloud',
  description:
    'Detach a cloud from the document. The asset stays in the local store (re-attach with its key); pipe runs committed from it and their ' +
    'extraction records stay, with their provenance.',
  params: z.object({ cloudId: cloudIdParam }),
  run: (doc, { cloudId }): CommandResult => {
    if (findCloud(doc, cloudId) === undefined)
      return refuseScan(doc, 'detach_point_cloud', 'SCN_CLOUD_NOT_FOUND', `no attached cloud '${cloudId}'`, [cloudId], ['cloudId']);
    const scan = scanOf(doc);
    const { [cloudId]: removed, ...clouds } = scan.clouds;
    void removed;
    return changed(
      withScan(doc, { ...scan, clouds, cloudOrder: scan.cloudOrder.filter((id) => id !== cloudId) }),
      `Detached point cloud ${cloudId}; the asset stays in the store.`,
      [cloudId],
    );
  },
});
