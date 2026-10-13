// DOM overlay: Front / Top / Right / Iso views and fit all / fit selection (camera moves go through cameraBridge).

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

export function ViewPresetsOverlay(): React.ReactElement {
  const selection = useStore((s) => s.document.selection);
  const allEntityIds = useStore((s) => s.document.order);

  /** Nothing to frame -> origin from distance 10. */
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
