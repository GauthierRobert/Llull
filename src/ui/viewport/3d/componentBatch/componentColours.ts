// Per-instance colours of a component batch (base colour, tint, selection) as one master array, and the hover tint over a single
// instance. Hover is painted into the tier meshes only (two instances per change), never through React state.

import * as THREE from 'three';
import type { Entity, EntityId } from '@core/model/types';
import { SELECTION_EMISSIVE, SELECTION_EMISSIVE_INTENSITY } from '../../viewportPalette';
import { instanceBaseColour } from '../plant/plantInstanceColours';

const SELECTED = new THREE.Color(SELECTION_EMISSIVE);
const HOVER = new THREE.Color('#ffd479');
/** Share of the hover colour mixed into the instance colour. */
const HOVER_MIX = 0.45;
const SCRATCH = new THREE.Color();

/** RGB (3 floats per id) with tints and selection applied; the colour a tier mesh shows when nothing is hovered. */
export function masterColours(
  ids: readonly EntityId[],
  entities: Readonly<Record<EntityId, Entity>>,
  materialColour: string | undefined,
  selectionSet: ReadonlySet<EntityId>,
  tints: ReadonlyMap<string, string>,
): Float32Array {
  const out = new Float32Array(ids.length * 3);
  ids.forEach((id, index) => {
    SCRATCH.set(instanceBaseColour(id, entities[id], materialColour, tints));
    if (selectionSet.has(id)) SCRATCH.lerp(SELECTED, SELECTION_EMISSIVE_INTENSITY);
    SCRATCH.toArray(out, index * 3);
  });
  return out;
}

/** Writes instance `index`'s master colour (hovered: mixed with the hover colour) into `slot` of `mesh`. */
export function paintInstance(mesh: THREE.InstancedMesh, slot: number, master: Float32Array, index: number, hovered: boolean): void {
  if (!mesh.instanceColor) mesh.setColorAt(0, SCRATCH.setRGB(1, 1, 1));
  SCRATCH.fromArray(master, index * 3);
  if (hovered) SCRATCH.lerp(HOVER, HOVER_MIX);
  mesh.setColorAt(slot, SCRATCH);
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}
