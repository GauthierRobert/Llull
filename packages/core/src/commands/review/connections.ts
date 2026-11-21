/** Connection groups and the fastener tag (08 ASC FR-ASC-10..12, TECHNICAL_SPEC 4.3): one declaration joins many parts. */

import { type ConnectionGroup, type ConnectionMembers, CONNECTION_CYLINDRICAL, CONNECTION_KINDS } from '../../model/prototype';
import { type Entity, is3D } from '../../model/types';
import { resolveMembers } from '../../geometry/assemblyCheck/connectionMembers';
import { nextId } from '../../lib/id';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, codedRejection, failer } from '../noop';
import { prototypeOf } from './intents';

const MIN_MEMBERS = 2;

/**
 * @affects adds 1 group to doc.prototype.connections (affected: [connId], id `conn-<step>.<k>`)
 * @invariant exactly one member selector; members are resolved at check time (patterns / layers / groups stay live); touching faces never imply a connection (D2)
 * @failure CONN_REASON_EMPTY, CONN_MEMBERS_EMPTY (no / several selectors, or fewer than 2 live 3D parts), CONN_UNKNOWN_MEMBER (unknown or 2D id, seed, layer, group) -> no-op
 */
export const addConnectionGroup = defineCommand({
  name: 'add_connection_group',
  description:
    'Declare ONE rigid connection over many parts (a bolted flange, a welded frame, a bonded skin, a press fit, a thread) instead of one ' +
    'allow_interference per pair. check_assembly then counts the member parts as connected (no FPR_PART_RESTING_ONLY / FPR_PART_FLOATING ' +
    'for them, if the group reaches a grounded part). Touching faces alone never imply a connection: declare it here. Members: ' +
    '{ids:[...]} explicit parts; {patternOf:seedId} the seed and every copy / instance of that pattern; {layerId}; {groupId}. Patterns, ' +
    'layers and groups are resolved at check time, so later edits stay covered. Optional detect {toleranceMm, faceAngleDeg, cylindrical} ' +
    'joins only member pairs that touch within the tolerance with facing faces (cylindrical include / exclude / only for curved contacts); ' +
    'without it every member pair is connected. Refused (no change) when reason is empty, fewer than 2 live 3D parts resolve, an id, seed, ' +
    'layer or group is unknown, or members names zero or several selectors. Returns the id conn-<step>.<k> in affected[0]. Next: ' +
    'set_part_grounded on the anchor, then check_assembly.',
  params: z.object({
    name: z.string().min(1).describe('Short label, e.g. "rotor disc bolts".'),
    kind: z.enum(CONNECTION_KINDS).describe('"bolted", "bonded", "welded", "press_fit" or "thread": all are rigid connections.'),
    members: z
      .object({
        ids: z.array(z.string()).min(1).optional().describe('Explicit entity / instance ids.'),
        patternOf: z.string().optional().describe('Pattern seed id: the seed and every copy / instance made from it.'),
        layerId: z.string().optional().describe('Every 3D part on this layer.'),
        groupId: z.string().optional().describe('Every 3D member of this entity group.'),
      })
      .describe('Exactly one of ids, patternOf, layerId, groupId.'),
    detect: z
      .object({
        toleranceMm: z.number().positive().describe('Parts connect only when their surfaces are within this distance (mm).'),
        faceAngleDeg: z.number().min(0).max(90).describe('Largest angle (deg) between the facing contact normals and exact opposition.'),
        cylindrical: z
          .enum(CONNECTION_CYLINDRICAL)
          .describe('"include" any contact, "exclude" curved contacts, "only" curved contacts (pins in bores).'),
      })
      .optional()
      .describe('Join only member pairs that really touch. Omit to connect every member pair.'),
    reason: z.string().describe('Why these parts are connected, e.g. "M8 bolts through the flange". Must be non-empty.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = []): CommandResult =>
      codedRejection(doc, 'add_connection_group', code, message, 'Fix the members or the reason and retry.', ids);
    if (params.reason.trim().length === 0) return fail('CONN_REASON_EMPTY', 'reason must be non-empty');
    const { ids, patternOf, layerId, groupId } = params.members;
    const chosen = [ids, patternOf, layerId, groupId].filter((value) => value !== undefined).length;
    if (chosen !== 1) return fail('CONN_MEMBERS_EMPTY', 'members must name exactly one of ids, patternOf, layerId, groupId');
    const members: ConnectionMembers =
      ids !== undefined
        ? { ids }
        : patternOf !== undefined
          ? { patternOf }
          : layerId !== undefined
            ? { layerId }
            : { groupId: groupId ?? '' };
    const resolved = resolveMembers(doc, members);
    if (resolved.stale.length > 0) return fail('CONN_UNKNOWN_MEMBER', `unknown member(s) ${resolved.stale.join(', ')}`, resolved.stale);
    const flat = (ids ?? []).filter((id) => !resolved.ids.includes(id));
    if (flat.length > 0) return fail('CONN_UNKNOWN_MEMBER', `2D entities cannot be connected: ${flat.join(', ')}`, flat);
    if (resolved.ids.length < MIN_MEMBERS)
      return fail('CONN_MEMBERS_EMPTY', `only ${resolved.ids.length} live 3D part(s) resolve; a connection needs at least ${MIN_MEMBERS}`);
    const id = nextId('conn');
    const group: ConnectionGroup = {
      id,
      name: params.name,
      kind: params.kind,
      members,
      ...(params.detect === undefined ? {} : { detect: params.detect }),
      reason: params.reason.trim(),
      declaredBy: 'agent',
    };
    const prototype = prototypeOf(doc);
    return changed(
      { ...doc, prototype: { ...prototype, connections: { ...prototype.connections, [id]: group } } },
      `Declared ${params.kind} connection ${id} '${params.name}' over ${resolved.ids.length} part(s) (by agent): ${group.reason}.`,
      [id],
    );
  },
});

/**
 * @affects removes 1 group from doc.prototype.connections (affected: [id])
 * @failure unknown connection id -> no-op
 */
export const deleteConnectionGroup = defineCommand({
  name: 'delete_connection_group',
  description:
    'Remove a connection group (conn-<step>.<k>, from add_connection_group). Its parts are checked as unconnected again unless another ' +
    'joint, body, intent or group holds them. Unknown id: no-op. Next: check_assembly.',
  params: z.object({ id: z.string().describe('Connection group id returned by add_connection_group, e.g. "conn-4.1".') }),
  run: (doc, { id }): CommandResult => {
    const prototype = doc.prototype;
    const group = prototype?.connections?.[id];
    if (prototype === undefined || group === undefined) return failer(doc, 'delete_connection_group')(`no connection group '${id}'`);
    const connections = Object.fromEntries(Object.entries(prototype.connections ?? {}).filter(([key]) => key !== id));
    return changed(
      { ...doc, prototype: { ...prototype, connections } },
      `Removed connection group ${id} '${group.name}' (${group.kind}).`,
      [id],
    );
  },
});

const withFastener = (entity: Entity, fastener: boolean): Entity => {
  const { fastener: _previous, ...rest } = entity;
  return (fastener ? { ...rest, fastener: true } : rest) as Entity;
};

/**
 * @affects sets or clears `fastener` on the entities (affected: the ids that changed)
 * @invariant idempotent; tag only: geometry and connections are untouched
 * @failure unknown or 2D id, nothing to change -> no-op
 */
export const setFastener = defineCommand({
  name: 'set_fastener',
  annotations: { idempotent: true },
  description:
    'Tag 3D entities or instances as fasteners (fastener = true) or clear the tag (false). check_assembly then reports a fastener-to-host ' +
    'overlap (a screw thread in its tapped hole) as FPR_FASTENER_THREAD (info) instead of a clash (FPR_PAIR_HARD / FPR_PAIR_CONTAINED). ' +
    'Only the tag changes: it does not connect anything (use add_connection_group). Unknown or 2D ids and a request that changes nothing ' +
    'are no-ops. Next: check_assembly.',
  params: z.object({
    ids: z.array(z.string()).min(1).describe('Entity or instance ids to tag.'),
    fastener: z.boolean().describe('true = tag as fastener, false = clear the tag.'),
  }),
  run: (doc, { ids, fastener }): CommandResult => {
    const fail = failer(doc, 'set_fastener');
    for (const id of ids) {
      const entity = doc.entities[id];
      if (entity === undefined) return fail(`entity '${id}' not found`);
      if (!is3D(entity)) return fail(`entity '${id}' is 2D (${entity.kind}); only solids and instances can be fasteners`);
    }
    const unique = [...new Set(ids)];
    const touched = unique.filter((id) => (doc.entities[id]?.fastener === true) !== fastener);
    if (touched.length === 0) return fail(`${unique.join(', ')} already ${fastener ? 'tagged' : 'untagged'}`);
    const entities = { ...doc.entities };
    for (const id of touched) entities[id] = withFastener(entities[id] as Entity, fastener);
    return changed(
      { ...doc, entities },
      `${fastener ? 'Tagged' : 'Untagged'} ${touched.length} fastener(s): ${touched.join(', ')}.`,
      touched,
    );
  },
});
