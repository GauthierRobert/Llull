/**
 * Turns and elbow choice (02 RTE §5.2): the turn angle at a point of intersection, the spec elbow that fits it within the tolerance, its
 * catalogue centre-to-end and the centreline arc. Standard elbow dimensions are read from the catalogue row, never computed (the 45 degree B
 * differs from R tan 22.5 by up to 3.4 mm, VC-RTE-15). A turn no spec angle fits is made by a trimmed elbow (the spec's 90 degree elbow cut to the turn,
 * `elbowAngles.trimmedAllowed`) or by a pipe bend (radius from the run or the spec): the tangent length is then `R tan(turn / 2)`, a formula, and the
 * fitting is flagged non-standard.
 */

import type { Vec3 } from '@core/model/vectors';
import { dot3 } from '@lib/vec3';
import { isMiss, type CatalogueRow, type SpecLookup, type SpecMiss } from './specLookup';

export interface ElbowChoice {
  /** Spec angle chosen (90, 45 ...); a trimmed elbow or a bend is made to the turn itself. */
  readonly nominalDeg: number;
  /** Actual turn at the point of intersection. */
  readonly turnDeg: number;
  /** |turn - nominal|, degrees (reported, never hidden). */
  readonly deviationDeg: number;
  /** The elbow row; a pipe bend: the spec's pipe row. */
  readonly row: CatalogueRow;
  /** Catalogue centre-to-end on each adjacent leg (trimmed elbow / bend: R tan(turn / 2)). */
  readonly centreToEnd: number;
  /** Centreline arc radius tangent to both ports: c / tan(turn / 2). */
  readonly radius: number;
  /** `standard`: a catalogue elbow at a spec angle; `trimmed`: the 90 degree elbow cut to the turn; `bend`: pipe bent to a radius. */
  readonly kind: 'standard' | 'trimmed' | 'bend';
  /** Bends: where the radius came from. */
  readonly radiusSource?: 'run bendRadius' | 'spec bendRadiusD x OD';
}

export interface FittingFailure {
  readonly code: 'RTE_NO_FITTING_FOR_ANGLE';
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** The bend a non-standard turn may become: the run's own radius (mm) and the outside diameter of its pipe (for the spec's radius in diameters). */
export interface BendOptions {
  readonly radiusMm?: number | undefined;
  readonly pipeOd: number;
}

/** Turn angle between two unit leg directions, degrees in [0, 180]. */
export const turnAngleDeg = (before: Vec3, after: Vec3): number =>
  (Math.acos(Math.max(-1, Math.min(1, dot3(before, after)))) * 180) / Math.PI;

/** Component types that make an elbow of the nominal angle, or null when the model has no type for it. */
const elbowTypes = (nominalDeg: number): readonly ['elbow90'] | readonly ['elbow45'] | null =>
  nominalDeg === 90 ? ['elbow90'] : nominalDeg === 45 ? ['elbow45'] : null;

const round9 = (value: number): number => Math.round(value * 1e9) / 1e9;
const tanHalf = (turnDeg: number): number => Math.tan((turnDeg * Math.PI) / 360);

/** The made-to-measure elbow for `turnDeg` with tangent radius `radius`: tangent length R tan(turn / 2). */
const madeToTurn = (kind: 'trimmed' | 'bend', row: CatalogueRow, turnDeg: number, radius: number): ElbowChoice => ({
  nominalDeg: turnDeg,
  turnDeg,
  deviationDeg: 0,
  row,
  centreToEnd: round9(radius * tanHalf(turnDeg)),
  radius,
  kind,
});

/** A trimmed elbow or pipe bend for a turn no spec angle fits; null when neither is available. */
function madeToMeasure(lookup: SpecLookup, dn: number, turnDeg: number, bend: BendOptions | undefined): ElbowChoice | SpecMiss | null {
  const rule = lookup.elbowAngles();
  const bendOf = (): ElbowChoice | SpecMiss | null => {
    const fromRun = bend?.radiusMm;
    const fromSpec = bend === undefined || rule.bendRadiusD === undefined ? undefined : bend.pipeOd * rule.bendRadiusD;
    const radiusMm = fromRun ?? fromSpec;
    if (radiusMm === undefined) return null;
    const pipe = lookup.pipe(dn);
    if (isMiss(pipe)) return pipe;
    // A pipe bend keeps the pipe's own ends: only butt-weld pipe is bent in the shop here (plain-end and threaded pipe would need couplings).
    if ((pipe.pipeEnd ?? 'BW') !== 'BW') return null;
    return {
      ...madeToTurn('bend', pipe, turnDeg, radiusMm),
      radiusSource: fromRun === undefined ? 'spec bendRadiusD x OD' : 'run bendRadius',
    };
  };
  if (bend?.radiusMm !== undefined) return bendOf();
  if (rule.trimmedAllowed && turnDeg <= 90) {
    const row = lookup.component({ types: ['elbow90'], dn });
    const centreToEnd = isMiss(row) ? undefined : row.dims['centreToEnd'];
    if (!isMiss(row) && centreToEnd !== undefined && centreToEnd > 0 && (row.ends[0] ?? 'BW') === 'BW')
      return madeToTurn('trimmed', row, turnDeg, centreToEnd);
  }
  return bendOf();
}

/** What would make an unfitted turn possible, for the refusal message. */
function hint(lookup: SpecLookup, turnDeg: number): string {
  const rule = lookup.elbowAngles();
  if (rule.trimmedAllowed && turnDeg > 90)
    return 'a trimmed elbow is cut from the 90 degree elbow, so it takes turns up to 90 degrees only; give the run a bendRadius or the spec a bendRadiusD for a larger turn';
  return (
    'use a spec angle, set elbowAngles.trimmedAllowed in the spec (a trimmed 90 degree elbow, turns up to 90 degrees)' +
    (rule.bendRadiusD === undefined ? ', or give the run a bendRadius / the spec a bendRadiusD (a pipe bend, butt-weld pipe)' : '')
  );
}

/**
 * The elbow for a turn of `turnDeg` at a point of intersection of size `dn`.
 * @failure the turn is a reversal, or is further than `toleranceDeg` from every spec angle and neither a trimmed elbow (spec trimmedAllowed, turn up to
 *   90 degrees, a butt-weld 90 degree row) nor a bend (run radius, or spec bendRadiusD; butt-weld pipe) is available -> RTE_NO_FITTING_FOR_ANGLE
 *   (detail.anglesDeg, trimmedAllowed, bendRadiusD); no component / no centreToEnd -> the SpecMiss of the lookup
 */
export function chooseElbow(
  lookup: SpecLookup,
  dn: number,
  turnDeg: number,
  toleranceDeg: number,
  bend?: BendOptions,
): ElbowChoice | FittingFailure | SpecMiss {
  const rule = lookup.elbowAngles();
  const nearest = rule.anglesDeg.reduce<number | null>(
    (best, angle) => (best === null || Math.abs(turnDeg - angle) < Math.abs(turnDeg - best) ? angle : best),
    null,
  );
  const detail = {
    angleDeg: turnDeg,
    anglesDeg: rule.anglesDeg,
    toleranceDeg,
    trimmedAllowed: rule.trimmedAllowed,
    bendRadiusD: rule.bendRadiusD ?? null,
  };
  const unfitted = (why: string): FittingFailure => ({
    code: 'RTE_NO_FITTING_FOR_ANGLE',
    message: `a ${+turnDeg.toFixed(4)} deg turn has no spec elbow (angles ${rule.anglesDeg.join(', ') || 'none'} deg, tolerance ${toleranceDeg} deg); ${why}`,
    detail,
  });
  if (turnDeg >= 180 - toleranceDeg) return unfitted('a reversal needs two turns');
  if (nearest === null || Math.abs(turnDeg - nearest) > toleranceDeg)
    return madeToMeasure(lookup, dn, turnDeg, bend) ?? unfitted(hint(lookup, turnDeg));
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
    radius: round9(centreToEnd / tanHalf(turnDeg)),
    kind: 'standard',
  };
}

/**
 * The elbow whose bend ends `tangentMm` from the centre instead of at the catalogue end (a socket-weld elbow bends up to the socket bottom, not the
 * mouth): the arc radius follows, the catalogue centre-to-end (the face the pipe meets) stays.
 */
export const withTangentLength = (choice: ElbowChoice, tangentMm: number): ElbowChoice => ({
  ...choice,
  radius: round9(tangentMm / tanHalf(choice.turnDeg)),
});

/** Centreline arc length of an elbow: R x turn (radians). */
export const arcLength = (radius: number, turnDeg: number): number => radius * ((turnDeg * Math.PI) / 180);

/** Run centreline length: sum of the legs minus 2 t per elbow (t = R tan(turn / 2), the tangent length: c for a butt-weld elbow) plus its arc (02 RTE §5.2). */
export function centrelineLength(legLengths: readonly number[], elbows: readonly ElbowChoice[]): number {
  const straight = legLengths.reduce((sum, length) => sum + length, 0);
  return elbows.reduce((sum, elbow) => sum - 2 * elbow.radius * tanHalf(elbow.turnDeg) + arcLength(elbow.radius, elbow.turnDeg), straight);
}
