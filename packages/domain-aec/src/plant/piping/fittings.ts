/**
 * Turns and elbow choice (02 RTE §5.2): the turn angle at a point of intersection, the spec elbow that fits it within the tolerance, its
 * catalogue centre-to-end and the centreline arc. Standard elbow dimensions are read from the catalogue row, never computed (the 45 degree B
 * differs from R tan 22.5 by up to 3.4 mm, VC-RTE-15).
 */

import type { Vec3 } from '@core/model/vectors';
import { dot3 } from '@lib/vec3';
import { isMiss, type CatalogueRow, type SpecLookup, type SpecMiss } from './specLookup';

export interface ElbowChoice {
  /** Spec angle chosen (90, 45 ...). */
  readonly nominalDeg: number;
  /** Actual turn at the point of intersection. */
  readonly turnDeg: number;
  /** |turn - nominal|, degrees (reported, never hidden). */
  readonly deviationDeg: number;
  readonly row: CatalogueRow;
  /** Catalogue centre-to-end on each adjacent leg. */
  readonly centreToEnd: number;
  /** Centreline arc radius tangent to both ports: c / tan(turn / 2). */
  readonly radius: number;
}

export interface FittingFailure {
  readonly code: 'RTE_NO_FITTING_FOR_ANGLE';
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** Turn angle between two unit leg directions, degrees in [0, 180]. */
export const turnAngleDeg = (before: Vec3, after: Vec3): number =>
  (Math.acos(Math.max(-1, Math.min(1, dot3(before, after)))) * 180) / Math.PI;

/** Component types that make an elbow of the nominal angle, or null when the model has no type for it. */
const elbowTypes = (nominalDeg: number): readonly ['elbow90'] | readonly ['elbow45'] | null =>
  nominalDeg === 90 ? ['elbow90'] : nominalDeg === 45 ? ['elbow45'] : null;

/**
 * The elbow for a turn of `turnDeg` at a point of intersection of size `dn`.
 * @failure the turn is a reversal, or is further than `toleranceDeg` from every spec angle -> RTE_NO_FITTING_FOR_ANGLE (detail.anglesDeg);
 *   no component / no centreToEnd -> the SpecMiss of the lookup
 */
export function chooseElbow(
  lookup: SpecLookup,
  dn: number,
  turnDeg: number,
  toleranceDeg: number,
): ElbowChoice | FittingFailure | SpecMiss {
  const rule = lookup.elbowAngles();
  const nearest = rule.anglesDeg.reduce<number | null>(
    (best, angle) => (best === null || Math.abs(turnDeg - angle) < Math.abs(turnDeg - best) ? angle : best),
    null,
  );
  const detail = { angleDeg: turnDeg, anglesDeg: rule.anglesDeg, toleranceDeg, trimmedAllowed: rule.trimmedAllowed };
  if (nearest === null || Math.abs(turnDeg - nearest) > toleranceDeg || turnDeg >= 180 - toleranceDeg)
    return {
      code: 'RTE_NO_FITTING_FOR_ANGLE',
      message: `a ${+turnDeg.toFixed(4)} deg turn has no spec elbow (angles ${rule.anglesDeg.join(', ') || 'none'} deg, tolerance ${toleranceDeg} deg)`,
      detail,
    };
  const types = elbowTypes(nearest);
  if (types === null)
    return {
      code: 'RTE_NO_FITTING_FOR_ANGLE',
      message: `the spec lists a ${nearest} deg elbow but the catalogue model has no elbow type for that angle (90 and 45 only)`,
      detail,
    };
  const row = lookup.component({ types, dn });
  if (isMiss(row)) return row;
  const centreToEnd = row.dims['centreToEnd'];
  if (centreToEnd === undefined || !(centreToEnd > 0))
    return {
      miss: 'RTE_SPEC_NO_COMPONENT',
      detail: `elbow row ${row.key} has no centreToEnd dimension (${row.source})`,
      ids: [row.key],
      paths: [],
    };
  return {
    nominalDeg: nearest,
    turnDeg,
    deviationDeg: Math.abs(turnDeg - nearest),
    row,
    centreToEnd,
    radius: Math.round((centreToEnd / Math.tan((turnDeg * Math.PI) / 360)) * 1e9) / 1e9,
  };
}

/** Centreline arc length of an elbow: R x turn (radians). */
export const arcLength = (radius: number, turnDeg: number): number => radius * ((turnDeg * Math.PI) / 180);

/** Run centreline length: sum of the legs minus 2 c per elbow plus its arc (02 RTE §5.2). */
export function centrelineLength(legLengths: readonly number[], elbows: readonly ElbowChoice[]): number {
  const straight = legLengths.reduce((sum, length) => sum + length, 0);
  return elbows.reduce((sum, elbow) => sum - 2 * elbow.centreToEnd + arcLength(elbow.radius, elbow.turnDeg), straight);
}
