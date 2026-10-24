/**
 * What a run end and a flanged component face need next to the pipe (02 RTE §5.4): nothing (open end), a butt weld (BW port), a flange set
 * (FL port, valve face) or, for a branch start, the header fitting. Also the flange-set parts shared by every derivation stage.
 */

import type { Vec3 } from '@core/model/vectors';
import type { EndType, PartPort, PortSpec, RoutedPart, RunEnd } from '@aec/plant/types';
import { len3, scale3, sub3 } from '@lib/vec3';
import { fail, isFailure, type DerivationFailure } from './deriveTypes';
import { isJoinFailure, joinFrom } from './connections';
import { resolveFlangeSet, type FlangeFace, type FlangeSet } from './flangeSet';
import { angleBetweenDeg, epsilonFor, unitVector } from './legs';
import { portIdOf, portOfRef } from './ports';
import { at, partOf, type EndSetup, type Env, type Mint } from './routeEnv';
import { branchStartSetup } from './routeBranch';
import { isMiss } from './specLookup';

/** Component types whose rows give the socket depth / thread engagement of a SW / threaded port (the project's own sockets of that size), in order. */
const PORT_GAUGE_TYPES = ['elbow90', 'coupling', 'tee'] as const;

/**
 * The setup of a socket-weld or threaded port: the pipe goes into the port by the depth of the spec's own socket (or thread) fittings of that size,
 * since a port carries no depth of its own.
 * @failure no rule for the pair -> RTE_NO_CONNECTION_RULE; no spec row with a socketDepth / threadEngagement -> RTE_SPEC_NO_COMPONENT
 */
function socketPortSetup(env: Env, port: PortSpec, portId: string, side: 'start' | 'end', dn: number): EndSetup | DerivationFailure {
  const { lookup } = env;
  const pipe = env.pipeAt(dn);
  if (isFailure(pipe)) return pipe;
  const pipeEnd: EndType = pipe.row.pipeEnd ?? 'BW';
  const dimension = port.endType === 'SW' ? 'socketDepth' : 'threadEngagement';
  const rule = lookup.connection(port.endType, pipeEnd);
  if (rule === null)
    return fail(
      'RTE_NO_CONNECTION_RULE',
      `spec ${lookup.id} has no rule joining a pipe with ${pipeEnd} ends to a ${port.endType} port (${portId}): socket weld needs plain-end (PE) pipe, threaded needs threaded pipe`,
      [portId],
      [side],
      { portEndType: port.endType, pipeEndType: pipeEnd },
    );
  for (const type of PORT_GAUGE_TYPES) {
    const row = lookup.component({ types: [type], dn });
    if (isMiss(row) || row.dims[dimension] === undefined) continue;
    const join = joinFrom(lookup, port.endType, pipeEnd, row.dims, row.key);
    if (isJoinFailure(join)) return fail(join.code, join.message, [portId, row.key], [side], join.detail);
    return { length: 0, gap: join.gapMm, set: null, join, port, portId };
  }
  return fail(
    'RTE_SPEC_NO_COMPONENT',
    `port ${portId} is ${port.endType} but spec ${lookup.id} has no ${PORT_GAUGE_TYPES.join(' / ')} row at DN${dn} with a ${dimension}: a ${port.endType} port has no depth of its own, it is read from the spec's own fittings`,
    [portId],
    [side],
    { dimension },
  );
}

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
  if (port.endType === 'SW' || port.endType === 'SC') return socketPortSetup(env, port, portId, side, dn);
  if (port.endType !== 'FL' || lookup.connection('FL', 'FL') === null)
    return fail(
      'RTE_NO_CONNECTION_RULE',
      `spec ${lookup.id} has no rule joining a pipe end to a ${port.endType} port (${portId}); ports are BW, FL, SW (socket weld) or SC (threaded)`,
      [portId],
      [side],
      { portEndType: port.endType },
    );
  const pipe = env.pipeAt(dn);
  if (isFailure(pipe)) return pipe;
  const set = resolveFlangeSet(lookup, port, dn, pipe.row.pipeEnd ?? 'BW');
  if ('code' in set) return fail(set.code, set.message, set.ids, [side], set.detail);
  return { length: set.length, gap: set.join.gapMm, set, join: set.join, portId, port };
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
  const fl = (position: Vec3, direction: Vec3, end: EndType): PartPort => ({
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
    order([fl(at(origin, into, g), out, 'FL'), fl(at(origin, into, g + set.hub), into, set.join.end)]),
    { dims: { ...set.flange.dims, pipeOutsideDiameter: pipeOd } },
  );
  return away ? [gasket, bolts, flange] : [flange, bolts, gasket];
}
