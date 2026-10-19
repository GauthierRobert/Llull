// "Zoom to" for the panel highlight: frames its entities and beacons together, keeping the current viewing direction.

import * as THREE from 'three';
import type { CadDocument, Vec3 } from '@core/model/types';
import { mergeBounds, type Bounds } from '@core/geometry/bounds';
import { fitFraming } from '@core/geometry/viewFraming';
import type { PanelFocus } from '@ui/store/focusStore';
import { mergedEntityBounds } from './fitBounds';
import { getAspect, getCameraSnapshot, placeCamera } from './cameraBridge';
import { PRESET_DIRECTIONS } from './viewPresetDirections';

const MARGIN = 1.7;

/** World bounds of what the focus names (entities ∪ marker points); null when it names nothing that exists. */
export function focusBounds(document: CadDocument, focus: Pick<PanelFocus, 'entityIds' | 'markers'>): Bounds | null {
  let bounds = mergedEntityBounds(document, focus.entityIds);
  for (const { position } of focus.markers) {
    const point: Bounds = { min: [...position], max: [...position] };
    bounds = bounds === null ? point : mergeBounds(bounds, point);
  }
  return bounds;
}

export function zoomToFocus(document: CadDocument, focus: Pick<PanelFocus, 'entityIds' | 'markers'>): void {
  const bounds = focusBounds(document, focus);
  if (bounds === null) return;
  const { center, distance } = fitFraming(bounds, getAspect(), MARGIN, { degenerateBelow: 1e-9, degenerateRadius: 50 });
  const snapshot = getCameraSnapshot();
  const direction =
    snapshot === null
      ? new THREE.Vector3(...PRESET_DIRECTIONS.iso)
      : new THREE.Vector3(...snapshot.position).sub(new THREE.Vector3(...snapshot.target));
  if (direction.lengthSq() === 0) direction.set(...PRESET_DIRECTIONS.iso);
  const eye = direction
    .normalize()
    .multiplyScalar(distance)
    .add(new THREE.Vector3(...center));
  const target: Vec3 = [center[0], center[1], center[2]];
  placeCamera([eye.x, eye.y, eye.z], target);
}
