/**
 * Scene inspection: `computeSceneSnapshot` (pure) backs the read-only `describe_scene` command and
 * the `build_project` report. Bounds are world-space AABBs; rotated entities use their rotated OBB
 * corners and carry `oriented: true`.
 *
 * @layer core/commands
 */

import type { CadDocument } from '../model/types';
import type { CommandResult } from './types';
import { report } from './noop';
import { defineCommand, z } from './schema';
import {
  type Bounds,
  type EntitySummary,
  type LayerSummary,
  type GroupSummary,
  type AnimationSummary,
  type SceneSnapshot,
} from './sceneTypes';
import { entityBoundsInDoc, mergeBounds } from './sceneBounds';
import { rotatedEntityBounds } from './sceneRotatedBounds';
/** Structured snapshot of the document. @pure */
export function computeSceneSnapshot(doc: CadDocument): SceneSnapshot {
  const entities: EntitySummary[] = [];
  let sceneBounds: Bounds | null = null;
  const layerCounts: Record<string, number> = {};

  for (const id of doc.order) {
    const e = doc.entities[id];
    if (!e) continue;
    // Instances have no own geometry: their AABB comes from the referenced component.
    const bounds =
      e.kind === 'instance' || e.kind === 'dimension'
        ? entityBoundsInDoc(doc, e)
        : rotatedEntityBounds(e);
    entities.push({ id: e.id, kind: e.kind, layerId: e.layerId, position: e.position, bounds });
    sceneBounds = sceneBounds ? mergeBounds(sceneBounds, bounds) : bounds;
    layerCounts[e.layerId] = (layerCounts[e.layerId] ?? 0) + 1;
  }

  const layers: LayerSummary[] = doc.layerOrder
    .map((lid) => doc.layers[lid])
    .filter((l): l is NonNullable<typeof l> => l !== undefined)
    .map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      locked: l.locked,
      entityCount: layerCounts[l.id] ?? 0,
    }));

  const groups: GroupSummary[] = Object.values(doc.groups).map((g) => ({
    id: g.id,
    name: g.name,
    memberIds: [...g.memberIds],
  }));

  const animations: AnimationSummary[] = Object.values(doc.animations).map((a) => ({
    id: a.id,
    targetId: a.targetId,
    targetKind: a.targetKind,
    channel: a.channel,
    mode: a.mode,
  }));

  return {
    entityCount: entities.length,
    entities,
    layers,
    groups,
    bounds: sceneBounds,
    selection: [...doc.selection],
    animations,
  };
}

/**
 * @command describe_scene
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is a SceneSnapshot; document === input doc
 */
export const describeScene = defineCommand({
  name: 'describe_scene',
  annotations: { readOnly: true },
  description:
    'Return a structured, read-only snapshot of the document (entity ids, kinds, world bounds, ' +
    'layers, groups, selection) so an agent can orient before editing. Does not modify the document. ' +
    'The snapshot is returned in the result `data` field.',
  params: z.object({}),
  run: (doc): CommandResult => {
    const snapshot = computeSceneSnapshot(doc);
    return report(
      doc,
      `Scene: ${snapshot.entityCount} entit${snapshot.entityCount === 1 ? 'y' : 'ies'}, ${snapshot.layers.length} layer(s), ${snapshot.groups.length} group(s), ${snapshot.animations.length} animation(s).`,
      snapshot,
    );
  },
});
