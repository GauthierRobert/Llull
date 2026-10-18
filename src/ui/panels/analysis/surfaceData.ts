// The painted-surface answer of render_fea_results (surface: true), parsed into typed arrays for the 3D overlay.

import { isRecord } from '@lib/isRecord';

export interface SurfaceView {
  /** Flat xyz per triangle corner, document units, deformed as plotted. */
  readonly positions: Float32Array;
  /** Field value per corner. */
  readonly values: Float32Array;
  readonly triangles: number;
  readonly truncated: boolean;
  readonly field: string;
  readonly unit: string;
  /** Band edges (bands + 1 values, ascending). */
  readonly levels: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly resultLabel: string;
  readonly deformationScale: number;
}

const numbers = (value: unknown): number[] | null =>
  Array.isArray(value) && value.every((n) => typeof n === 'number') ? (value as number[]) : null;

/** null when the command refused or answered without a surface. */
export function parseSurface(data: unknown): SurfaceView | null {
  if (!isRecord(data) || !isRecord(data['surface'])) return null;
  const { surface } = data;
  const positions = numbers(surface['positions']);
  const values = numbers(surface['values']);
  const levels = numbers(data['levels']);
  const min = isRecord(data['min']) ? data['min']['value'] : undefined;
  const max = isRecord(data['max']) ? data['max']['value'] : undefined;
  if (positions === null || values === null || levels === null || levels.length < 2) return null;
  if (typeof min !== 'number' || typeof max !== 'number' || positions.length !== values.length * 3) return null;
  const resultSet = data['resultSet'];
  return {
    positions: Float32Array.from(positions),
    values: Float32Array.from(values),
    triangles: typeof surface['triangles'] === 'number' ? surface['triangles'] : values.length / 3,
    truncated: surface['truncated'] === true,
    field: typeof data['field'] === 'string' ? data['field'] : '',
    unit: typeof data['unit'] === 'string' ? data['unit'] : '',
    levels,
    min,
    max,
    resultLabel: isRecord(resultSet) && typeof resultSet['label'] === 'string' ? resultSet['label'] : '',
    deformationScale: typeof data['deformationScale'] === 'number' ? data['deformationScale'] : 0,
  };
}
