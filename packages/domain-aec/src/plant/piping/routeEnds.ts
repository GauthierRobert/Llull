/**
 * What a run end and a flanged component face need next to the pipe (02 RTE §5.4): nothing (open end), a butt weld (BW port), a flange set
 * (FL port, valve face) or, for a branch start, the header fitting. Also the flange-set parts shared by every derivation stage.
 */

import type { Vec3 } from '@core/model/vectors';
import type { PartPort, RoutedPart, RunEnd } from '@aec/plant/types';
import { len3, scale3, sub3 } from '@lib/vec3';
import { fail, type DerivationFailure } from './deriveTypes';
import { resolveFlangeSet, type FlangeFace, type FlangeSet } from './flangeSet';
import { angleBetweenDeg, epsilonFor, unitVector } from './legs';
import { portIdOf, portOfRef } from './ports';
import { at, partOf, type EndSetup, type Env, type Mint } from './routeEnv';
import { branchStartSetup } from './routeBranch';

/**
 * The setup of the port at one run end; `dn` is the run size there.
 * @failure port gone / wrong size / moved / turned away, no connection rule, flange set problems -> the RTE_* failure
 */
export function setupEnd(env: Env, end: RunEnd, side: 'start' | 'end', dn: number): EndSetup | DerivationFailure {
  const { doc, line, lookup, weld } = env;
  if (end.ref === undefined) return { length: 0, gap: 0, set: null, port: null, portId: null };
  const port = portOfRef(doc, end.ref);
  const portId = portIdOf(doc, end.ref);
  if (port === null) return fail('RTE_UNKNOWN_PORT', `the ${side} port ${portId} no longer exists`, [portId], [side]);
  if (port.dn !== dn)
    return fail(
      'RTE_SIZE_MISMATCH',
      `port ${portId} is DN${port.dn}, the run is DN${dn} at its ${side}${dn === line.dn ? '' : ` (after its reducers; line ${line.id} is DN${line.dn})`}`,
      [portId, line.id],
      [side],
    );
  const moved = sub3(port.position, end.point);
  if (len3(moved) > epsilonFor(port.position, end.point))
    return fail(
      'RTE_STRETCH_FAILED',
      `port ${portId} is ${moved.map((v) => +v.toFixed(3)).join(', ')} mm from where the run ${side} was routed (the equipment or tie-in moved)`,
      [portId],
      [side],
      { moved },
    );
  if (end.direction !== undefined && angleBetweenDeg(unitVector(end.direction), unitVector(port.direction)) > 1e-4)
    return fail(
      'RTE_STRETCH_FAILED',
      `port ${portId} now faces ${port.direction.map((v) => +v.toFixed(6)).join(', ')} but the run ${side} was routed along ${end.direction.map((v) => +v.toFixed(6)).join(', ')} (the equipment was turned)`,
      [portId],
      [side],
      { portDirection: port.direction, routedDirection: end.direction },
    );
  if (weld === null) return fail('RTE_NO_CONNECTION_RULE', `spec ${lookup.id} has no BW-BW connection rule`, [lookup.id], [side]);
  if (end.ref.kind === 'branch') return branchStartSetup(env, end.ref, port, portId);
  if (port.endType === 'BW') return { length: 0, gap: weld.gapMm, set: null, port, portId };
  if (port.endType !== 'FL' || lookup.connection('FL', 'FL') === null)
    return fail(
      'RTE_NO_CONNECTION_RULE',
      `spec ${lookup.id} has no rule joining a butt-weld pipe end to a ${port.endType} port (${portId})`,
      [portId],
      [side],
      { portEndType: port.endType },
    );
  const set = resolveFlangeSet(lookup, port, dn);
  if ('code' in set) return fail(set.code, set.message, set.ids, [side], set.detail);
  return { length: set.length, gap: weld.gapMm, set, portId, port };
}

/** Part ids of one flange set. */
export interface FlangeSetIds {
  readonly gasket: string;
  readonly bolts: string;
  readonly flange: string;
}

/** Mints the ids of one flange set (gasket, bolt set, flange: the order of M1 so ids stay stable). */
export const mintSet = (mint: Mint): FlangeSetIds => ({ gasket: mint('gasket'), bolts: mint('boltSet'), flange: mint('flange') });

/**
 * Gasket, bolt set and flange of the set at the face (`origin`, rating / facing of `face`), in route order away from the face when `away`, else
 * toward it. `into` is the unit direction from the face toward the pipe.
 */
export function flangeParts(
  runId: string,
  ids: FlangeSetIds,
  set: FlangeSet,
  face: FlangeFace,
  origin: Vec3,
  into: Vec3,
  pipeOd: number,
  away: boolean,
): RoutedPart[] {
  const g = set.gasketThickness;
  const fl = (position: Vec3, direction: Vec3, end: 'FL' | 'BW'): PartPort => ({
    position,
    direction,
    dn: set.flange.dn,
    endType: end,
    ...(end === 'FL' && face.rating !== undefined ? { rating: face.rating } : {}),
    ...(end === 'FL' && face.facing !== undefined ? { facing: face.facing } : {}),
  });
  const out = scale3(into, -1);
  const order = <T>(towardPipe: readonly T[]): T[] => (away ? [...towardPipe] : [...towardPipe].reverse());
  const gasket = partOf(runId, ids.gasket, 'gasket', set.gasket, order([fl(origin, out, 'FL'), fl(at(origin, into, g), into, 'FL')]), {
    centre: at(origin, into, g / 2),
    dims: { ...set.gasket.dims, pipeOutsideDiameter: pipeOd },
  });
  const bolts = partOf(runId, ids.bolts, 'boltSet', set.bolts, [], { centre: at(origin, into, g / 2), studs: set.studs });
  const flange = partOf(
    runId,
    ids.flange,
    'flange',
    set.flange,
    order([fl(at(origin, into, g), out, 'FL'), fl(at(origin, into, g + set.hub), into, 'BW')]),
    { dims: { ...set.flange.dims, pipeOutsideDiameter: pipeOd } },
  );
  return away ? [gasket, bolts, flange] : [flange, bolts, gasket];
}
