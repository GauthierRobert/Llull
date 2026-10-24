/**
 * The fitting at every turn of a run (02 RTE §5.2): the elbow choice with its join to the pipe, the turn record, and the non-standard flag of a trimmed
 * elbow or pipe bend (V1). Standard elbows keep the catalogue centre-to-end; a trimmed 90 degree elbow and a pipe bend are made to the turn
 * (tangent length R tan(turn / 2)) and raise `RTE_NONSTANDARD_FITTING`.
 */

import type { Vec3 } from '@core/model/vectors';
import type { RoutedPart } from '@aec/plant/types';
import { fittingEnd, type Join } from './connections';
import { fail, isFailure, type DerivationFailure, type DerivationWarning, type DerivedTurn } from './deriveTypes';
import { chooseElbow, turnAngleDeg, withTangentLength, type ElbowChoice } from './fittings';
import { joinOf, type Env } from './routeEnv';
import { dnAfter } from './runSizes';
import { isMiss } from './specLookup';

export interface Turns {
  readonly elbows: ElbowChoice[];
  readonly turns: DerivedTurn[];
  readonly joins: Join[];
  /** One RTE_NONSTANDARD_FITTING per trimmed elbow / pipe bend. */
  readonly warnings: DerivationWarning[];
}

/** Takeoff key of the fitting: the row type plus radius (`elbow90LR`), `elbow90LRTrimmed` for a trimmed elbow, `pipeBend` for a bend. */
export const turnTypeKey = (choice: ElbowChoice): string =>
  choice.kind === 'bend' ? 'pipeBend' : `${choice.row.type}${choice.row.radius ?? ''}${choice.kind === 'trimmed' ? 'Trimmed' : ''}`;

/** The fields of the part a turn gives that depend on how the fitting is made (type key, the dimensions of a bend). */
export function turnPartFields(choice: ElbowChoice, outsideDiameter: number): Pick<RoutedPart, 'typeKey' | 'dims'> {
  const dims = { outsideDiameter, centreToEnd: choice.centreToEnd };
  if (choice.kind === 'standard') return { typeKey: turnTypeKey(choice), dims };
  const arc = (choice.radius * choice.turnDeg * Math.PI) / 180;
  return {
    typeKey: turnTypeKey(choice),
    dims: choice.kind === 'bend' ? { ...dims, bendRadius: choice.radius, developedLength: arc } : { ...dims, bendRadius: choice.radius },
  };
}

function nonStandard(runId: string, index: number, choice: ElbowChoice): DerivationWarning {
  const how =
    choice.kind === 'trimmed'
      ? `a ${choice.row.key} 90 degree elbow cut to ${+choice.turnDeg.toFixed(4)} deg (R ${+choice.radius.toFixed(3)} mm, tangent ${+choice.centreToEnd.toFixed(3)} mm)`
      : `a pipe bend of ${+choice.turnDeg.toFixed(4)} deg (R ${+choice.radius.toFixed(3)} mm from ${choice.radiusSource ?? 'the run'}, tangent ${+choice.centreToEnd.toFixed(3)} mm)`;
  return {
    code: 'RTE_NONSTANDARD_FITTING',
    ids: [`${runId}/elbow-${index}`, runId],
    message: `leg ${index}: the turn is ${how}, not a catalogue elbow: a reviewer accepts it`,
    detail: {
      leg: index,
      kind: choice.kind,
      turnDeg: choice.turnDeg,
      radiusMm: choice.radius,
      tangentMm: choice.centreToEnd,
      ...(choice.kind === 'bend'
        ? { radiusSource: choice.radiusSource, developedLengthMm: (choice.radius * choice.turnDeg * Math.PI) / 180 }
        : {}),
    },
  };
}

/**
 * Elbow choice, join and turn record at every interior point of intersection (the size at a point is the size at the end of the leg before it).
 * @failure no spec elbow / bend for a turn, no row or dimension, no connection rule -> the RTE_* failure with the leg path
 */
export function chooseTurns(env: Env, points: readonly Vec3[], dirs: readonly Vec3[]): Turns | DerivationFailure {
  const { run, line, lookup, tolerance } = env;
  const turns: Turns = { elbows: [], turns: [], joins: [], warnings: [] };
  for (let i = 1; i < dirs.length; i++) {
    const turnDeg = turnAngleDeg(dirs[i - 1] as Vec3, dirs[i] as Vec3);
    const dn = dnAfter(run, line.dn, i - 1, Number.POSITIVE_INFINITY);
    const pipe = env.pipeAt(dn);
    if (isFailure(pipe)) return pipe;
    const found = chooseElbow(lookup, dn, turnDeg, tolerance.valueDeg, { radiusMm: run.bendRadiusMm, pipeOd: pipe.od });
    if (isMiss(found)) return fail(found.miss, found.detail, [...found.ids, run.id], [`legs.${i}`], { pi: i - 1 });
    if ('code' in found) return fail(found.code, found.message, [run.id], [`legs.${i}`], { ...found.detail, pi: i - 1 });
    // A pipe bend is the pipe itself: butt-weld ends (the choice is only made for butt-weld pipe).
    const end = found.kind === 'bend' ? 'BW' : fittingEnd(found.row);
    const join = joinOf(env, end, dn, found.row.dims, found.row.key, [run.id, found.row.key], [`legs.${i}`]);
    if (isFailure(join)) return join;
    // A socket-weld elbow bends up to the socket bottom (centre-to-end less the socket depth), not up to the mouth the pipe meets.
    const depth = join.joint === 'socketWeld' ? found.row.dims['socketDepth'] : undefined;
    const choice = depth !== undefined && depth < found.centreToEnd ? withTangentLength(found, found.centreToEnd - depth) : found;
    if (choice.kind === 'bend' && choice.radius < pipe.od)
      return fail(
        'RTE_NO_FITTING_FOR_ANGLE',
        `the pipe bend at point ${i - 1} would have a radius of ${+choice.radius.toFixed(2)} mm, below one outside diameter (${pipe.od} mm): a pipe cannot be bent that tight`,
        [run.id],
        [`legs.${i}`],
        { pi: i - 1, radiusMm: choice.radius, outsideDiameterMm: pipe.od },
      );
    turns.joins.push(join);
    turns.elbows.push(choice);
    if (choice.kind !== 'standard') turns.warnings.push(nonStandard(run.id, i, choice));
    turns.turns.push({
      index: i,
      point: points[i] as Vec3,
      partId: `${run.id}/elbow-${i}`,
      turnDeg,
      nominalDeg: choice.nominalDeg,
      deviationDeg: choice.deviationDeg,
      centreToEnd: choice.centreToEnd,
      radius: choice.radius,
      catalogueKey: choice.row.key,
      typeKey: turnTypeKey(choice),
      kind: choice.kind,
    });
  }
  return turns;
}
