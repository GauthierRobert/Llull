/** assign_surface_system / declare_isolation / remove_isolation (PHY-13 FR-COR-09, FR-COR-15): protective finishes and declared isolations. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { refuseCor } from './codes';
import { corrosionOf, isolationOf, withCorrosion } from './model';
import { REMEDIES, groupOf } from './tables';
import { ISOLATION_METHODS, SURFACE_CLASSES, type Isolation, type SurfaceLayer, type SurfaceSystem } from './types';

/**
 * @affects doc.corrosion.surfaceSystems (adds 1 system `ss-<step>.<k>` covering the entities and removes them from any previous system; affected: [systemId]); layers [none] only clears
 * @invariant one system per entity (a new one replaces); the galvanic group of a plated part is its outermost metallic_plating layer; organic coatings never count as isolation on their own (declare_isolation)
 * @failure unknown entity -> COR_ENTITY_NOT_FOUND; metallic_plating without galvanicGroup -> COR_GROUP_MISSING; unknown group -> COR_GROUP_UNKNOWN; no entityIds or layers -> COR_PARAMS_INVALID (document unchanged)
 */
export const assignSurfaceSystem = defineCommand({
  name: 'assign_surface_system',
  description:
    'Attach a surface system (protective finish, layers listed inner to outer) to parts. Layer class: none, anodize, conversion_coating, metallic_plating (REQUIRES galvanicGroup, ' +
    'e.g. cadmium_plate or zinc: the plated part then couples galvanically as that metal, not as its base), acid_process, primer, paint; spec is the process specification text. ' +
    'One system per entity: a new assignment replaces the old one; layers [{class:"none"}] clears it. A primer or paint is NOT an isolation unless declared with declare_isolation. ' +
    'Returns the system id in affected[0]. Next: check_material_compatibility.',
  params: z.object({
    entityIds: z.array(z.string()).describe('Ids of the solids the system covers (at least one).'),
    layers: z
      .array(
        z.object({
          class: z.enum(SURFACE_CLASSES).describe('Layer class.'),
          spec: z.string().optional().describe('Process specification text, e.g. "MIL-DTL-81706 Class 1A".'),
          galvanicGroup: z.string().optional().describe('Group of the plating metal (required for metallic_plating).'),
        }),
      )
      .describe('Layers inner to outer (1 to 8).'),
  }),
  run: (doc, { entityIds, layers }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [], path = 'layers'): CommandResult =>
      refuseCor(doc, 'assign_surface_system', code, message, ids, [path]);
    const ids = [...new Set(entityIds)];
    if (ids.length === 0 || layers.length === 0 || layers.length > 8)
      return fail('COR_PARAMS_INVALID', 'give at least one entity id and 1 to 8 layers', [], 'entityIds');
    const missing = ids.find((id) => !Object.hasOwn(doc.entities, id));
    if (missing !== undefined) return fail('COR_ENTITY_NOT_FOUND', `no entity '${missing}'`, [missing], 'entityIds');
    for (const layer of layers) {
      if (layer.class === 'metallic_plating' && layer.galvanicGroup === undefined)
        return fail('COR_GROUP_MISSING', 'a metallic_plating layer needs its galvanicGroup (e.g. cadmium_plate)');
      if (layer.galvanicGroup !== undefined && groupOf(layer.galvanicGroup) === undefined)
        return fail('COR_GROUP_UNKNOWN', `no galvanic group '${layer.galvanicGroup}'`, [], 'layers.galvanicGroup');
    }
    const model = corrosionOf(doc);
    const kept: Record<string, SurfaceSystem> = {};
    for (const [key, system] of Object.entries(model.surfaceSystems)) {
      const remaining = system.entityIds.filter((id) => !ids.includes(id));
      if (remaining.length > 0) kept[key] = { ...system, entityIds: remaining };
    }
    if (layers.every((layer) => layer.class === 'none'))
      return changed(
        withCorrosion(doc, { surfaceSystems: kept }),
        `assign_surface_system: cleared the surface system of ${ids.join(', ')}.`,
        [],
      );
    const id = nextId('ss');
    const stored: SurfaceLayer[] = layers.map((layer) => ({
      class: layer.class,
      ...(layer.spec === undefined ? {} : { spec: layer.spec }),
      ...(layer.galvanicGroup === undefined ? {} : { galvanicGroup: layer.galvanicGroup }),
    }));
    const outer = [...stored].reverse().find((layer) => layer.class === 'metallic_plating')?.galvanicGroup;
    return changed(
      withCorrosion(doc, { surfaceSystems: { ...kept, [id]: { id, entityIds: ids, layers: stored } } }),
      `assign_surface_system: '${id}' on ${ids.join(', ')}: ${stored.map((layer) => layer.class).join(' > ')}${outer === undefined ? '' : `; galvanic group of the part is now ${outer}`}.`,
      [id],
    );
  },
});

/** Root of a pair member: an instance child "<instance>/<child>" belongs to the entity before the first slash. */
const rootOf = (id: string): string => id.split('/')[0] ?? id;

/**
 * @affects doc.corrosion.isolations (adds 1 isolation `iso-<step>.<k>`; affected: [isolationId])
 * @invariant a pair matches either order, and any contact between the two (an instance child id matches by its instance); a part isolation covers every contact of that part
 * @failure neither or both of pair / entityId, or a pair of one id twice -> COR_ISOLATION_TARGET_MISSING; unknown entity -> COR_ENTITY_NOT_FOUND (document unchanged)
 */
export const declareIsolation = defineCommand({
  name: 'declare_isolation',
  description:
    'Declare that a galvanic couple is isolated: for a PAIR of parts [idA, idB] (any contact between them) or for ONE part (every contact of it). method: ' +
    `${ISOLATION_METHODS.join(', ')} (options and their specs: ${REMEDIES.map((remedy) => `${remedy.id} = ${remedy.spec}`).join('; ')}). ` +
    'The next check_material_compatibility reports the pair pass_isolated instead of fail, still with reviewRequired: a human decides whether the isolation is adequate. ' +
    'A primer or paint assigned with assign_surface_system counts only when declared here. Returns the isolation id in affected[0].',
  params: z.object({
    pair: z
      .tuple([z.string(), z.string()])
      .optional()
      .describe('Two different part ids (an assembly child is "<instanceId>/<childId>"). Give pair OR entityId.'),
    entityId: z.string().optional().describe('One part id: isolates every contact of it. Give entityId OR pair.'),
    method: z.enum(ISOLATION_METHODS).describe('Isolation method.'),
    spec: z.string().optional().describe('Specification text, e.g. "MIL-PRF-81733 Type IV".'),
    note: z.string().optional().describe('Free note for the reviewer.'),
  }),
  run: (doc, { pair, entityId, method, spec, note }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = []): CommandResult =>
      refuseCor(doc, 'declare_isolation', code, message, ids, ['pair']);
    if ((pair === undefined) === (entityId === undefined) || (pair !== undefined && pair[0] === pair[1]))
      return fail('COR_ISOLATION_TARGET_MISSING', 'give exactly one of pair (two different ids) or entityId');
    const missing = [...(pair ?? [entityId ?? ''])].find((id) => !Object.hasOwn(doc.entities, rootOf(id)));
    if (missing !== undefined) return fail('COR_ENTITY_NOT_FOUND', `no entity '${missing}'`, [missing]);
    const id = nextId('iso');
    const isolation: Isolation = {
      id,
      ...(pair === undefined ? {} : { pair: [pair[0], pair[1]] as const }),
      ...(entityId === undefined ? {} : { entityId }),
      method,
      ...(spec === undefined ? {} : { spec }),
      ...(note === undefined ? {} : { note }),
    };
    return changed(
      withCorrosion(doc, { isolations: { ...corrosionOf(doc).isolations, [id]: isolation } }),
      `declare_isolation: '${id}' ${method}${spec === undefined ? '' : ` (${spec})`} on ${pair === undefined ? entityId : pair.join(' | ')}; a human decides whether it is adequate.`,
      [id],
    );
  },
});

/**
 * @affects doc.corrosion.isolations (removes 1; affected: [id])
 * @failure unknown id -> COR_ISOLATION_NOT_FOUND (document unchanged)
 */
export const removeIsolation = defineCommand({
  name: 'remove_isolation',
  description: 'Remove a declared isolation by its id (from declare_isolation); the next check reports the couple as it is without it.',
  params: z.object({ id: z.string().describe('Isolation id, e.g. "iso-12.1".') }),
  run: (doc, { id }): CommandResult => {
    if (isolationOf(doc, id) === undefined)
      return refuseCor(doc, 'remove_isolation', 'COR_ISOLATION_NOT_FOUND', `no isolation '${id}'`, [id], ['id']);
    const isolations = Object.fromEntries(Object.entries(corrosionOf(doc).isolations).filter(([key]) => key !== id));
    return changed(withCorrosion(doc, { isolations }), `remove_isolation: removed '${id}'.`, [id]);
  },
});
