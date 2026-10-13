/**
 * @layer ui/viewport/3d
 *
 * ViewPresets — floating overlay buttons for standard 3D view orientations (Front / Top / Right /
 * Iso) and fit-to-all / fit-to-selection.
 *
 * CRITICAL: under frameloop="demand", any programmatic camera/target change MUST call both
 * invalidate() AND controls.update(). Without invalidate() the demand loop never fires; without
 * controls.update() the OrbitControls internal state is stale (the RenderOriginSyncer's useFrame
 * relies on these invalidation sources).
 *
 * Purely presentational: reads the store and never mutates the document (PRIME DIRECTIVE).
 */

import React from 'react';
import * as THREE from 'three';
import { useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { NamedViewsOverlay } from './NamedViews';
import { computeFitFraming } from './fitBounds';
import { getAspect, placeCamera } from './cameraBridge';
import { PRESET_DIRECTIONS, type PresetDirection, type PresetName } from './viewPresetDirections';

const ORIGIN: readonly [number, number, number] = [0, 0, 0];

const PRESETS: ReadonlyArray<{ name: PresetName; label: string }> = [
  { name: 'front', label: 'Front' },
  { name: 'top', label: 'Top' },
  { name: 'right', label: 'Right' },
  { name: 'iso', label: 'Iso' },
];

/** Rendered OUTSIDE the Canvas as a DOM overlay. */
export function ViewPresetsOverlay(): React.ReactElement {
  const selection = useStore((s) => s.document.selection);
  const allEntityIds = useStore((s) => s.document.order);

  /** View `ids` from `direction`, framed to fit; nothing to frame -> origin from distance 10. */
  const frame = (direction: PresetDirection, ids: string[]): void => {
    const framing = computeFitFraming(useStore.getState().document, ids, getAspect());
    const center = framing?.center ?? ORIGIN;
    const distance = framing?.distance ?? 10;
    const eye = new THREE.Vector3(...direction)
      .normalize()
      .multiplyScalar(distance)
      .add(new THREE.Vector3(...center));
    placeCamera([eye.x, eye.y, eye.z], center);
  };
  const fit = (ids: string[]): void => {
    if (ids.length > 0) frame(PRESET_DIRECTIONS.iso, ids);
  };

  return (
    <div className="vp-overlay vp-overlay--top-right">
      <div className="vp-toolbar" aria-label="View presets" role="group">
        <div className="vp-group">
          {PRESETS.map(({ name, label }) => (
            <button
              key={name}
              type="button"
              className="vp-btn"
              onClick={() => frame(PRESET_DIRECTIONS[name], allEntityIds)}
              title={`${label} view`}
              aria-label={`${label} view`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="vp-divider" aria-hidden="true" />
        <div className="vp-group">
          <button
            type="button"
            className="vp-btn vp-btn--icon"
            onClick={() => fit(allEntityIds)}
            title="Fit all entities into view"
            aria-label="Fit all into view"
          >
            <Icon name="fit" size={14} />
          </button>
          <button
            type="button"
            className="vp-btn vp-btn--icon"
            onClick={() => fit(selection)}
            title="Fit selected entities into view"
            aria-label="Fit selection into view"
            disabled={selection.length === 0}
          >
            <Icon name="cursor" size={14} />
          </button>
        </div>
        <span className="vp-divider" aria-hidden="true" />
        <NamedViewsOverlay />
      </div>
    </div>
  );
}
