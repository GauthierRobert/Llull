// The transport of cloud points: the read-only scan queries (`describe_point_cloud`, `query_cloud_points`) over the command bus
// (`POST /command`), answered by the backend's point-cloud port. The renderer holds no asset; nothing here changes the document.

import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { postCommand } from '@ui/store/serverCommands';
import type { Vec3 } from '@core/model/vectors';
import type { TileAttributes } from './colourModes';
import type { CloudBox, CloudTile } from './tileGrid';

export interface CloudInfo {
  readonly pointCount: number;
  /** Document frame and units, the cloud transform applied. */
  readonly bounds: CloudBox;
  readonly attributes: readonly string[];
}

export interface TileAnswer {
  readonly positions: Float64Array;
  readonly attributes?: TileAttributes | undefined;
  readonly truncated: boolean;
}

export type ClientResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const isVec3 = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number');

/** Pure: the `describe_point_cloud` data as a CloudInfo, or null when it is not that shape. */
export function parseCloudInfo(data: unknown): CloudInfo | null {
  if (!isRecord(data) || typeof data['pointCount'] !== 'number' || !isRecord(data['bounds'])) return null;
  const { min, max } = data['bounds'];
  if (!isVec3(min) || !isVec3(max)) return null;
  const attributes = Array.isArray(data['attributes']) ? data['attributes'].filter((a): a is string => typeof a === 'string') : [];
  return { pointCount: data['pointCount'], bounds: { min, max }, attributes };
}

const numberColumn = (value: unknown): ArrayLike<number> | undefined =>
  Array.isArray(value) && value.every((n) => typeof n === 'number') ? (value as number[]) : undefined;

/** Pure: the `query_cloud_points` data as a TileAnswer, or null. Per-point columns are read when the host sends them. */
export function parseTileAnswer(data: unknown): TileAnswer | null {
  if (!isRecord(data) || !Array.isArray(data['points'])) return null;
  const points = data['points'];
  if (!points.every((n) => typeof n === 'number')) return null;
  const rgb = numberColumn(data['rgb']);
  const intensity = numberColumn(data['intensity']);
  const classification = numberColumn(data['classification']);
  const attributes =
    rgb !== undefined || intensity !== undefined || classification !== undefined ? { rgb, intensity, classification } : undefined;
  return { positions: Float64Array.from(points as number[]), attributes, truncated: data['truncated'] === true };
}

async function run(name: string, params: Record<string, unknown>): Promise<ClientResult<unknown>> {
  try {
    const response = await postCommand(name, params);
    if (response.isError) return { ok: false, message: response.summary };
    return { ok: true, value: response.data };
  } catch (cause) {
    return { ok: false, message: errorMessage(cause) };
  }
}

export async function fetchCloudInfo(cloudId: string): Promise<ClientResult<CloudInfo>> {
  const result = await run('describe_point_cloud', { cloudId });
  if (!result.ok) return result;
  const info = parseCloudInfo(result.value);
  return info === null ? { ok: false, message: 'describe_point_cloud returned no bounds' } : { ok: true, value: info };
}

/** One tile at `budget` points (a budgeted box query: whole octree levels, coarse first). */
export async function fetchTile(cloudId: string, tile: CloudTile, budget: number): Promise<ClientResult<TileAnswer>> {
  const result = await run('query_cloud_points', {
    cloudId,
    region: { kind: 'box', min: [...tile.min], max: [...tile.max] },
    lod: 'budget',
    budget,
    maxPoints: budget,
  });
  if (!result.ok) return result;
  const answer = parseTileAnswer(result.value);
  return answer === null ? { ok: false, message: 'query_cloud_points returned no points' } : { ok: true, value: answer };
}
