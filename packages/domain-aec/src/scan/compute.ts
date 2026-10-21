/** Running a heavy op through the port (TECHNICAL_SPEC §2.A): build the CloudOp, map a failed op to its coded refusal. */

import type { CloudOp, CloudOpSuccess, PointCloudPort } from '@core/model/pointCloud';
import type { CloudReference } from '@aec/scan/types';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { refuseScan } from './codes';

/** The op's result, or the refusal a failed / unknown op becomes. */
export function runOp(
  doc: CadDocument,
  command: string,
  port: PointCloudPort,
  kind: string,
  clouds: readonly CloudReference[],
  params: Readonly<Record<string, unknown>>,
): CloudOpSuccess | CommandResult {
  const op: CloudOp = { kind, clouds: clouds.map((cloud) => ({ assetKey: cloud.assetKey, toDocument: cloud.transform })), params };
  const ids = clouds.map((cloud) => cloud.id);
  const outcome = port.compute(op);
  if (outcome === null) return refuseScan(doc, command, 'SCN_ASSET_MISSING', "an asset of the op is not in this machine's store", ids);
  if (!outcome.ok) return refuseScan(doc, command, outcome.code, outcome.message, ids);
  return outcome;
}

export const isSuccess = (value: CloudOpSuccess | CommandResult): value is CloudOpSuccess => 'provenance' in value;

/** A finite number field of an op result (NaN when absent). */
export const numberAt = (record: Readonly<Record<string, unknown>>, key: string): number => {
  const value = record[key];
  return typeof value === 'number' ? value : Number.NaN;
};
