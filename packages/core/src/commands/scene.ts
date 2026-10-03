/**
 * Scene inspection — a read-only structured snapshot of the document.
 *
 * @layer core/commands
 *
 * `computeSceneSnapshot` is a pure function an agent (or the UI) uses to ORIENT
 * before editing: how many entities, of what kind, where, on which layers. It is
 * surfaced as the read-only `describe_scene` command (no mutation, result in
 * `data`) and is also embedded in the `build_project` report so an agent sees the
 * final scene in the same round-trip.
 *
 * Bounds are world-space AABBs. When an entity has non-zero `rotation` the AABB
 * is computed from the rotated OBB corners (three.js Rx·Ry·Rz convention) and
 * carries `oriented:true` so agents know the bounds reflect the actual rotated
 * geometry. Zero-rotation entities produce the same output as before (back-compat).
 */

import type { CadDocument } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import {
  type Bounds,
  type EntitySummary,
  type LayerSummary,
  type GroupSummary,
  type AnimationSummary,
  type SceneSnapshot,
} from './sceneTypes';
import { instanceBoundsFromDoc, mergeBounds } from './sceneBounds';
import { rotatedEntityBounds } from './sceneRotatedBounds';
// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Build a structured, read-only snapshot of the document.
 *
 * @pure — reads the document, never mutates it.
 * @layer core/commands
 */
export function computeSceneSnapshot(doc: CadDocument): SceneSnapshot {
  const entities: EntitySummary[] = [];
  let sceneBounds: Bounds | null = null;
  const layerCounts: Record<string, number> = {};

  for (const id of doc.order) {
    const e = doc.entities[id];
    if (!e) continue;
    // Instances have no own geometry — their world AABB comes from expanding the
    // referenced component (rotatedEntityBounds alone returns a point for instances).
    const bounds = e.kind === 'instance' ? instanceBoundsFromDoc(e, doc) : rotatedEntityBounds(e);
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

  const groups: GroupSummary[] = Object.values(doc.groups ?? {}).map((g) => ({
    id: g.id,
    name: g.name,
    memberIds: [...g.memberIds],
  }));

  const animations: AnimationSummary[] = Object.values(doc.animations ?? {}).map((a) => ({
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

// ---------------------------------------------------------------------------
// describe_scene command (read-only)
// ---------------------------------------------------------------------------

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
    return {
      document: doc,
      summary: `Scene: ${snapshot.entityCount} entit${snapshot.entityCount === 1 ? 'y' : 'ies'}, ${snapshot.layers.length} layer(s), ${snapshot.groups.length} group(s), ${snapshot.animations.length} animation(s).`,
      affected: [],
      data: snapshot,
    };
  },
});
