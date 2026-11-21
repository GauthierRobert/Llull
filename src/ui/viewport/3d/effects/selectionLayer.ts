// The three.js layer selected solids are ALSO on (they stay on layer 0): the edge pass renders that layer alone into a mask and
// draws the selection outline from it, visible through whatever stands in front. Presentation only.

import type * as THREE from 'three';

export const SELECTION_LAYER = 12;

/** Puts `object` on (or takes it off) the selection layer; layer 0 (drawing, raycasts, shadows) is untouched. */
export function setOnSelectionLayer(object: THREE.Object3D, selected: boolean): void {
  if (selected) object.layers.enable(SELECTION_LAYER);
  else object.layers.disable(SELECTION_LAYER);
}
