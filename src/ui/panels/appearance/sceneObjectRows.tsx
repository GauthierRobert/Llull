// Read-only inspector rows of a light / camera entity (editing goes through the add_light / add_camera step: the Geometry section edits
// the creating step's parameters when it has dimensions, otherwise these readouts stay).

import React from 'react';
import { toDegrees } from '@lib/angle';
import { cameraVerticalFov } from '@core/model/sceneKinds';
import type { CameraEntity, LightEntity } from '@core/model/types';
import { PropRow, ScalarRow } from '../propertyFields';

function TextRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <PropRow label={label}>
      <span className="props-number">{value}</span>
    </PropRow>
  );
}

export function lightRows(light: LightEntity): React.ReactElement {
  return (
    <>
      <TextRow label="Light type" value={light.lightType} />
      <ScalarRow label="Intensity" value={light.intensity} unit={light.lightType === 'sun' ? 'W/m²' : 'W'} />
      <PropRow label="Colour">
        <span className="props-number" title={light.lightColor}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              marginRight: 6,
              borderRadius: 2,
              background: light.lightColor,
              border: '1px solid currentColor',
            }}
          />
          {light.lightColor}
        </span>
      </PropRow>
      {light.lightType === 'spot' && light.coneAngle !== undefined && (
        <ScalarRow label="Cone" value={toDegrees(light.coneAngle)} unit="°" />
      )}
      {light.lightType === 'spot' && light.blend !== undefined && <ScalarRow label="Blend" value={light.blend} />}
      {light.lightType === 'area' && light.width !== undefined && light.height !== undefined && (
        <TextRow label="Size" value={`${light.width.toFixed(3)} × ${light.height.toFixed(3)}`} />
      )}
      <ScalarRow label="Radius" value={light.radius} />
      <TextRow label="Shadows" value={light.castShadows ? 'cast' : 'off'} />
    </>
  );
}

export function cameraRows(camera: CameraEntity): React.ReactElement {
  return (
    <>
      <ScalarRow label="Focal length" value={camera.focalLength} unit="mm" />
      <TextRow label="Sensor" value={`${camera.sensorWidth} × ${camera.sensorHeight} mm`} />
      <ScalarRow label="Field of view" value={toDegrees(cameraVerticalFov(camera))} unit="°" />
      <ScalarRow label="Focus distance" value={camera.focusDistance} />
      <TextRow label="Aperture" value={camera.fStop === undefined ? 'pinhole' : `f/${camera.fStop}`} />
    </>
  );
}
