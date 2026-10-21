/** The common preamble of every scan query: the cloud reference, the installed port and the asset manifest, or the coded refusal. */

import type { CloudManifest, PointCloudPort } from '@core/model/pointCloud';
import type { CloudReference } from '@aec/scan/types';
import type { CadDocument } from '@core/model/types';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { refuseScan } from './codes';
import { findCloud } from './model';
import { portOf } from './region';

export interface CloudAccess {
  readonly cloud: CloudReference;
  readonly port: PointCloudPort;
  readonly manifest: CloudManifest;
}

/**
 * @failure unknown cloud -> SCN_CLOUD_NOT_FOUND; no port -> SCN_ASSET_UNAVAILABLE; asset not in the store -> SCN_ASSET_MISSING
 */
export function cloudAccess(
  doc: CadDocument,
  command: string,
  cloudId: string,
  ctx: ExecutionContext | undefined,
  path = 'cloudId',
): CloudAccess | CommandResult {
  const cloud = findCloud(doc, cloudId);
  if (cloud === undefined) return refuseScan(doc, command, 'SCN_CLOUD_NOT_FOUND', `no attached cloud '${cloudId}'`, [cloudId], [path]);
  const port = portOf(ctx);
  if (port === null)
    return refuseScan(doc, command, 'SCN_ASSET_UNAVAILABLE', 'no point-cloud port is installed in this host', [cloudId], [path]);
  const manifest = port.manifest(cloud.assetKey);
  if (manifest === null)
    return refuseScan(
      doc,
      command,
      'SCN_ASSET_MISSING',
      `asset ${cloud.assetKey} of ${cloudId} is not in this machine's store`,
      [cloudId],
      [path],
    );
  return { cloud, port, manifest };
}

export const isAccess = (value: CloudAccess | CommandResult): value is CloudAccess => 'port' in value;
