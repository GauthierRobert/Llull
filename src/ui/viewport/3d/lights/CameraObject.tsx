// Render branch of `kind: 'camera'`: a frustum glyph (vertical field of view from focal length and sensor height, aspect from the sensor)
// that is pickable and moved by the gizmo like any entity. It draws no light and takes no part in the viewport's own camera.

import { useMemo } from 'react';
import type { CameraEntity } from '@core/model/types';
import { SceneObjectGlyph } from './SceneObjectGlyph';
import { cameraGlyph } from './sceneObjectGlyphs';

export function CameraObject({
  entity,
  selected,
  onSelect,
}: {
  entity: CameraEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}): React.ReactElement {
  const { focalLength, sensorWidth, sensorHeight } = entity;
  const glyph = useMemo(() => cameraGlyph({ focalLength, sensorWidth, sensorHeight }), [focalLength, sensorWidth, sensorHeight]);
  return (
    <SceneObjectGlyph
      entity={entity}
      positions={glyph.positions}
      screenScaled={glyph.screenScaled}
      color={entity.color}
      selected={selected}
      onSelect={onSelect}
      pickZ={0.4}
    />
  );
}
