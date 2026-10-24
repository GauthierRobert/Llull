/** Inputs shared by the commands that lay a run out from compass legs (`route_pipe`, `add_branch`): endpoints, legs, inline components. */

import { vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { InlineComponent, PortRef } from '@aec/plant/types';
import { nextId } from '@lib/id';
import { COMPASS_NAMES, unitVector, type PathEnd } from '../legs';
import { refuse } from '../model';
import { portOccupant, resolvePortId } from '../ports';
import { defaultStem, INLINE_TYPES } from '../routeInline';
import { isValve } from '../runSizes';

export const portOrPoint = z.union([
  z.object({ portId: z.string().min(1).describe('Port id: a tie-in id, "<tag>:<mark>" of an equipment nozzle, or "<runId>:start|end".') }),
  z.object({
    point: vec3('Open end [x, y, z], document units (mm).'),
    direction: vec3('Direction the pipe leaves (start) or arrives along reversed (end) [dx, dy, dz]; optional.').optional(),
  }),
]);

export type Endpoint = z.infer<typeof portOrPoint>;

export const legsInput = z
  .array(
    z.object({
      direction: z
        .union([z.enum(COMPASS_NAMES), vec3('Direction vector [dx, dy, dz]; normalised.')])
        .describe('"+X", "-X", "+Y", "-Y", "+Z", "-Z" or a vector.'),
      length: z
        .number()
        .optional()
        .describe('Length along the direction, document units, > 0. May be omitted on the last leg when `to` is a port.'),
    }),
  )
  .optional()
  .describe('Legs from the start point, in order.');

export const viaInput = z
  .array(vec3('Point of intersection [x, y, z].'))
  .optional()
  .describe('Points of intersection added after the legs.');

/** Fields that describe one inline component, shared by `route_pipe.inline` and `insert_inline_component`. */
export const inlineFields = {
  type: z
    .enum(INLINE_TYPES)
    .describe('Catalogue type: a valve (valveGate, valveGlobe, valveCheck, valveBall, valveButterfly, valvePlug) or reducerConcentric.'),
  tag: z.string().min(1).optional().describe('Instrument / equipment tag, e.g. "XV-1001".'),
  dn2: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Reducers only: the outlet size DN the run continues at (the inlet is the run size at that point). Valves: omit.'),
  stemDirection: vec3(
    'Valves: direction from the valve centre toward the handwheel [dx, dy, dz]; normalised. Default: up (+Z), or +X on a vertical pipe.',
  ).optional(),
};

export const inlineAt = z.object({
  leg: z.number().int().min(0).describe('Leg index, 0 = the first leg (data.legs of route_pipe).'),
  centreDistance: z
    .number()
    .positive()
    .describe('Distance of the component centre from the leg start point of intersection, document units.'),
});

/**
 * A stored inline component for a leg of direction `legDirection`.
 * @failure a zero stem direction -> refusal (RTE_INVALID_PORT); a reducer without dn2 or a valve with dn2 -> RTE_SIZE_MISMATCH
 */
export function buildInline(
  doc: CadDocument,
  command: string,
  fields: { type: (typeof INLINE_TYPES)[number]; tag?: string | undefined; dn2?: number | undefined; stemDirection?: Vec3 | undefined },
  at: { leg: number; centreDistance: number },
  legDirection: Vec3,
  path: string,
): InlineComponent | CommandResult {
  const valve = isValve(fields);
  if (valve && fields.dn2 !== undefined)
    return refuse(doc, command, 'RTE_SIZE_MISMATCH', `${fields.type} has one size: dn2 is for reducers`, [], [`${path}.dn2`]);
  if (!valve && fields.dn2 === undefined)
    return refuse(doc, command, 'RTE_SIZE_MISMATCH', `a reducer needs dn2, the size the run continues at`, [], [`${path}.dn2`]);
  if (fields.stemDirection !== undefined && !(Math.hypot(...fields.stemDirection) > 1e-12))
    return refuse(doc, command, 'RTE_INVALID_PORT', 'the stem direction is zero', [], [`${path}.stemDirection`]);
  const stem = valve ? (fields.stemDirection === undefined ? defaultStem(legDirection) : unitVector(fields.stemDirection)) : undefined;
  return {
    id: nextId(valve ? 'valve' : 'reducer'),
    type: fields.type,
    ...(fields.tag === undefined ? {} : { tag: fields.tag }),
    leg: at.leg,
    centreDistance: at.centreDistance,
    ...(fields.dn2 === undefined ? {} : { dn2: fields.dn2 }),
    ...(stem === undefined ? {} : { stemDirection: stem }),
  };
}

export interface ResolvedEndpoint {
  readonly end: PathEnd;
  readonly ref?: PortRef;
  /** Id of the port as the agent passed it. */
  readonly portId?: string;
  readonly dn?: number;
}

export const isResolved = (value: ResolvedEndpoint | CommandResult): value is ResolvedEndpoint => 'end' in value;

/**
 * A command endpoint as a path end: an open point, or a free port (and, when `expectDn` is given, of that size).
 * @failure zero open-end direction -> RTE_INVALID_PORT; unknown port -> RTE_UNKNOWN_PORT; port in use -> RTE_PORT_IN_USE; size -> RTE_SIZE_MISMATCH
 */
export function resolveEndpoint(
  doc: CadDocument,
  command: string,
  line: { readonly id: string },
  expectDn: number | null,
  endpoint: Endpoint,
  side: 'from' | 'to',
): ResolvedEndpoint | CommandResult {
  if (!('portId' in endpoint)) {
    if (endpoint.direction === undefined) return { end: { point: endpoint.point } };
    const length = Math.hypot(...endpoint.direction);
    if (!(length > 1e-12)) return refuse(doc, command, 'RTE_INVALID_PORT', `the ${side} direction is zero`, [], [`${side}.direction`]);
    return { end: { point: endpoint.point, direction: unitVector(endpoint.direction) } };
  }
  const resolved = resolvePortId(doc, endpoint.portId);
  if (!resolved.ok) return refuse(doc, command, 'RTE_UNKNOWN_PORT', resolved.message, [], [`${side}.portId`]);
  const { port } = resolved;
  const occupant = portOccupant(doc, port.ref);
  if (occupant !== undefined)
    return refuse(
      doc,
      command,
      'RTE_PORT_IN_USE',
      `port ${port.id} is already connected (${occupant})`,
      [port.id, occupant],
      [`${side}.portId`],
    );
  if (expectDn !== null && port.spec.dn !== expectDn)
    return refuse(
      doc,
      command,
      'RTE_SIZE_MISMATCH',
      `port ${port.id} is DN${port.spec.dn}, line ${line.id} is DN${expectDn}`,
      [port.id, line.id],
      [`${side}.portId`],
    );
  return { end: { point: port.spec.position, direction: port.spec.direction }, ref: port.ref, portId: port.id, dn: port.spec.dn };
}
