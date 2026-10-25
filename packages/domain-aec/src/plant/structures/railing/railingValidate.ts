/** Validation of a railing definition (06 STA M3): path, rails that fit, profiles, openings. */

import type { CadDocument } from '@core/model/types';
import { fromMm, toMm } from '@core/model/units';
import type { RailingElement } from '@aec/building/types';
import { findProfile } from '../../../steel/profiles';
import type { StaCode } from '../codes';
import { cumulativeLengths, railLevels } from './railingLayout';

export interface RailingProblem {
  readonly code: StaCode;
  readonly message: string;
  readonly paths: string[];
}

type Definition = Pick<
  RailingElement,
  'path' | 'height' | 'kneeRails' | 'toePlate' | 'postProfile' | 'railProfile' | 'postSpacingMax' | 'openings' | 'role'
>;

/** Shortest accepted path segment, mm: shorter ones are repeated points. */
const MIN_SEGMENT_MM = 0.1;

/** The first problem of a railing definition, or null. Lengths in document units. */
export function railingProblem(doc: CadDocument, railing: Definition): RailingProblem | null {
  const invalid = (message: string, ...paths: string[]): RailingProblem => ({ code: 'STA_INVALID_GEOMETRY', message, paths });
  const { path } = railing;
  if (path.length < 2 || path.some((point) => point.length !== 3 || !point.every(Number.isFinite)))
    return invalid('the path needs 2+ finite [x, y, z] points', 'path');
  const cumulative = cumulativeLengths(path);
  const segments = cumulative.slice(1).map((length, index) => length - (cumulative[index] as number));
  if (segments.some((length) => toMm(doc, length) < MIN_SEGMENT_MM))
    return invalid('the path has a repeated point (a segment shorter than 0.1 mm)', 'path');
  if (!(railing.height > 0)) return invalid('height must be > 0', 'height');
  if (!(railing.postSpacingMax > 0)) return invalid('postSpacingMax must be > 0', 'postSpacingMax');
  if (!(railing.toePlate >= 0)) return invalid('toePlate must be >= 0', 'toePlate');
  if (!Number.isInteger(railing.kneeRails) || railing.kneeRails < 0 || railing.kneeRails > 10)
    return invalid('kneeRails must be an integer 0..10', 'kneeRails');
  const post = findProfile(railing.postProfile);
  const rail = findProfile(railing.railProfile);
  if (post === undefined) return invalid(`unknown post profile '${railing.postProfile}' (list_steel_profiles)`, 'postProfile');
  if (rail === undefined) return invalid(`unknown rail profile '${railing.railProfile}' (list_steel_profiles)`, 'railProfile');
  const { gap } = railLevels(railing.height, railing.kneeRails, railing.toePlate, fromMm(doc, rail.h));
  if (!(gap > 0))
    return invalid(
      `height ${railing.height} is too small for ${railing.kneeRails + 1} rail(s) of ${rail.h} mm and a ${toMm(doc, railing.toePlate)} mm toe plate`,
      'height',
    );
  const length = cumulative[cumulative.length - 1] as number;
  let cursor = 0;
  for (const opening of railing.openings) {
    if (!(opening.from >= cursor && opening.to > opening.from && opening.to <= length + 1e-9))
      return {
        code: 'STA_RAIL_OPENING',
        message: `opening ${opening.from}..${opening.to} is not inside 0..${length} (path length), ascending and non-overlapping`,
        paths: ['openings'],
      };
    cursor = opening.to;
  }
  if (railing.openings.length > 0 && railing.openings.every((opening) => opening.to - opening.from >= length - 1e-9))
    return { code: 'STA_RAIL_OPENING', message: 'the openings remove the whole railing', paths: ['openings'] };
  return null;
}
