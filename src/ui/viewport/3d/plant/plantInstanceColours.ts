// Per-instance colours of a plant bucket into an InstancedMesh: the entity colour (or its material's), selection tinted like the
// per-entity path (InstancedRenderer / instanceWriter).

import * as THREE from 'three';
import type { Entity, EntityId } from '@core/model/types';
import { SELECTION_EMISSIVE, SELECTION_EMISSIVE_INTENSITY } from '../../viewportPalette';

const SELECTED = new THREE.Color(SELECTION_EMISSIVE);
const WHITE = new THREE.Color(1, 1, 1);
const SCRATCH = new THREE.Color();

/** `materialColour` (a document material's diffuse colour) replaces each entity's own colour when set. */
export function writeBucketColours(
  mesh: THREE.InstancedMesh,
  ids: readonly EntityId[],
  entities: Readonly<Record<EntityId, Entity>>,
  materialColour: string | undefined,
  selectionSet: ReadonlySet<EntityId>,
): void {
  if (!mesh.instanceColor) mesh.setColorAt(0, WHITE);
  ids.forEach((id, index) => {
    const entity = entities[id];
    SCRATCH.set(materialColour ?? entity?.color ?? '#cccccc');
    if (selectionSet.has(id)) SCRATCH.lerp(SELECTED, SELECTION_EMISSIVE_INTENSITY);
    mesh.setColorAt(index, SCRATCH);
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}
