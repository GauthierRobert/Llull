/**
 * @layer ui/panels/civil
 * @pure Validation + param gathering of the civil forms (alignment, manhole, drainage storm).
 * Components render the returned `error` and dispatch the returned `params`; the commands validate.
 */

import type { Vec2 } from '@core/model/types';
import { optionalNumber, optionalText, parseNumber, parseNumberList } from '@ui/numberText';
import { parsePoints } from './civilInput';

export type Gathered =
  | { readonly ok: true; readonly params: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

export interface AlignmentInput {
  readonly points: string;
  readonly radii: string;
  readonly spirals: string;
  readonly surfaceId: string;
  readonly interval: string;
  readonly name: string;
}

/** `add_alignment` params from the Roads form text fields. */
export function alignmentParamsOf(input: AlignmentInput): Gathered {
  const points = parsePoints(input.points);
  const radii = parseNumberList(input.radii);
  const spirals = parseNumberList(input.spirals);
  if (points === null || points.length < 2) {
    return { ok: false, error: 'Points: at least 2 points "x,y; x,y".' };
  }
  if (radii === null) {
    return { ok: false, error: 'Radii: numbers separated by commas, one per interior point.' };
  }
  if (spirals === null) {
    return {
      ok: false,
      error: 'Spirals: lengths separated by commas, one per interior point (0 = none).',
    };
  }
  return {
    ok: true,
    params: {
      points,
      ...(radii.length > 0 ? { radii } : {}),
      ...(spirals.length > 0 ? { spirals } : {}),
      ...(input.surfaceId !== '' ? { surfaceId: input.surfaceId } : {}),
      ...optionalNumber('stationInterval', input.interval),
      ...optionalText('name', input.name),
    },
  };
}

export interface ManholeInput {
  readonly position: string;
  readonly invert: string;
  readonly surfaceId: string;
  /** Optional numeric fields by command param name (blank = omitted). */
  readonly numbers: Readonly<Record<string, string>>;
  readonly name: string;
}

/** `add_manhole` params from the manhole form text fields. */
export function manholeParamsOf(input: ManholeInput): Gathered {
  const at: Vec2[] | null = parsePoints(input.position);
  const invertElevation = parseNumber(input.invert);
  if (at?.length !== 1 || invertElevation === undefined) {
    return { ok: false, error: 'Enter the position "x,y" and the invert elevation.' };
  }
  return {
    ok: true,
    params: {
      location: at[0],
      invertElevation,
      ...(input.surfaceId !== '' ? { surfaceId: input.surfaceId } : {}),
      ...Object.entries(input.numbers).reduce(
        (params, [key, text]) => ({ ...params, ...optionalNumber(key, text) }),
        {},
      ),
      ...optionalText('name', input.name),
    },
  };
}

/** Texts of the failures list of a `check_drainage_network` result. */
export function failuresOf(data: unknown): string[] {
  if (typeof data !== 'object' || data === null || !('failures' in data)) return [];
  const failures: unknown = data.failures;
  return Array.isArray(failures)
    ? failures.filter((item): item is string => typeof item === 'string')
    : [];
}

export const IDF_FIELDS = ['a', 'b', 'c'] as const;

/** Design storm params: the IDF curve when a, b and c are all given, else the constant intensity. */
export function stormParams(
  rainfall: string,
  idf: Record<(typeof IDF_FIELDS)[number], string>,
): Record<string, unknown> {
  const [a, b, c] = IDF_FIELDS.map((key) => parseNumber(idf[key]));
  return a !== undefined && b !== undefined && c !== undefined
    ? { idf: { a, b, c } }
    : optionalNumber('rainfallIntensityMmH', rainfall);
}
