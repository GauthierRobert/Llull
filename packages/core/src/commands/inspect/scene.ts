/**
 * Scene inspection: `computeSceneSnapshot` (pure) backs the read-only `describe_scene` command and the `build_project` report. Bounds are
 * world-space AABBs; rotated entities use their rotated OBB corners and carry `oriented: true`.
 */

import type { CadDocument, DimensionEntity } from '../../model/types';
import type { CommandResult } from '../types';
import { report } from '../noop';
import { defineCommand, z } from '../schema';
import type { Bounds } from '../../geometry/bounds';
import {
  type DimensionSummary,
  type TextSummary,
  type EntitySummary,
  type LayerSummary,
  type GroupSummary,
  type AnimationSummary,
  type SceneSnapshot,
} from './sceneTypes';
import { entityBoundsInDoc, mergeBounds } from '../../geometry/bounds';
import { DEFAULT_DIMENSION_OFFSET, dimensionDrawing, dimensionText } from '../../geometry/dimensionAnnotation';

function summarizeDimension(doc: CadDocument, e: DimensionEntity): DimensionSummary {
  const refs = e.entityIds.map((id) => (Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined));
  const drawing = dimensionDrawing(e.dimensionKind, refs, e.offset ?? DEFAULT_DIMENSION_OFFSET);
  return {
    id: e.id,
    dimensionKind: e.dimensionKind,
    entityIds: [...e.entityIds],
    value: drawing ? drawing.value : null,
    unit: e.dimensionKind === 'angular' ? 'deg' : doc.units,
    text: drawing ? dimensionText(e, drawing.value, doc.displayPrecision) : null,
  };
}

/** Structured snapshot of the document. @pure */
export function computeSceneSnapshot(doc: CadDocument): SceneSnapshot {
  const entities: EntitySummary[] = [];
  const dimensions: DimensionSummary[] = [];
  const texts: TextSummary[] = [];
  let sceneBounds: Bounds | null = null;
  const layerCounts: Record<string, number> = {};
  for (const id of doc.order) {
    const e = doc.entities[id];
    if (!e) continue;
    // Instances have no own geometry: their AABB comes from the referenced component.
    const bounds = entityBoundsInDoc(doc, e);
    entities.push({ id: e.id, kind: e.kind, layerId: e.layerId, position: e.position, bounds });
    sceneBounds = sceneBounds ? mergeBounds(sceneBounds, bounds) : bounds;
    if (e.kind === 'dimension') dimensions.push(summarizeDimension(doc, e));
    if (e.kind === 'text') texts.push({ id: e.id, content: e.content, position: e.position, height: e.height });
    layerCounts[e.layerId] = (layerCounts[e.layerId] ?? 0) + 1;
  }
  const layers: LayerSummary[] = doc.layerOrder
    .map((lid) => doc.layers[lid])
    .filter((l): l is NonNullable<typeof l> => l !== undefined)
    .map((l) => ({ id: l.id, name: l.name, visible: l.visible, locked: l.locked, entityCount: layerCounts[l.id] ?? 0 }));
  const groups: GroupSummary[] = Object.values(doc.groups).map((g) => ({ id: g.id, name: g.name, memberIds: [...g.memberIds] }));
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
    dimensions,
    texts,
  };
}

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is a SceneSnapshot; document === input doc
 */
export const describeScene = defineCommand({
  name: 'describe_scene',
  annotations: { readOnly: true },
  description:
    'Return a structured, read-only snapshot of the document (entity ids, kinds, world bounds, ' +
    'layers, groups, selection, dimensions with their measured values, text annotations) so an agent can orient before editing. Does not modify the document. ' +
    'The snapshot is returned in the result `data` field.',
  params: z.object({}),
  run: (doc): CommandResult => {
    const snapshot = computeSceneSnapshot(doc);
    return report(
      doc,
      `Scene: ${snapshot.entityCount} entit${snapshot.entityCount === 1 ? 'y' : 'ies'}, ${snapshot.layers.length} layer(s), ${snapshot.groups.length} group(s), ${snapshot.animations.length} animation(s).` +
        (snapshot.dimensions.length > 0
          ? ` Dimensions: ${snapshot.dimensions.map((d) => `${d.id} ${d.dimensionKind} ${d.text ?? 'unresolved'}${d.unit === 'deg' || d.text === null ? '' : ` ${d.unit}`}`).join('; ')}.`
          : '') +
        (snapshot.texts.length > 0
          ? ` Texts: ${snapshot.texts.map((t) => `${t.id} "${t.content.replace(/\n/g, ' / ')}"`).join('; ')}.`
          : ''),
      snapshot,
    );
  },
});
