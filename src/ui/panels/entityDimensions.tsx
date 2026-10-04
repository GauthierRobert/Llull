/** @layer ui/panels Kind-specific read-only dimension rows; null for kinds without any. */

import React from 'react';
import type { Entity } from '@core/model/types';
import { AxisFields, PropRow, ScalarRow } from './propertyFields';

export function dimensionRows(entity: Entity): React.ReactElement | null {
  switch (entity.kind) {
    case 'box':
      return (
        <PropRow label="Size">
          <AxisFields values={entity.size} />
        </PropRow>
      );
    case 'cylinder':
      return (
        <>
          <ScalarRow label="Radius" value={entity.radius} />
          <ScalarRow label="Height" value={entity.height} />
        </>
      );
    case 'sphere':
    case 'circle':
      return <ScalarRow label="Radius" value={entity.radius} />;
    case 'extrusion':
      return <ScalarRow label="Depth" value={entity.depth} />;
    case 'arc':
      return (
        <>
          <ScalarRow label="Radius" value={entity.radius} />
          <ScalarRow label="Start Angle" value={entity.startAngle} unit="rad" />
          <ScalarRow label="End Angle" value={entity.endAngle} unit="rad" />
        </>
      );
    case 'rectangle':
      return (
        <>
          <ScalarRow label="Width" value={entity.width} />
          <ScalarRow label="Height" value={entity.height} />
        </>
      );
    case 'line':
      return (
        <>
          <PropRow label="Start">
            <AxisFields values={entity.start} />
          </PropRow>
          <PropRow label="End">
            <AxisFields values={entity.end} />
          </PropRow>
        </>
      );
    case 'polyline':
      return (
        <PropRow label="Points">
          <span className="props-number">
            {entity.points.length}
            <span className="props-unit">pts</span>
          </span>
        </PropRow>
      );
    default:
      return null;
  }
}
