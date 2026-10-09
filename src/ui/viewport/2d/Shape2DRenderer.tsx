/**
 * @layer ui/viewport/2d
 *
 * One pure render branch per Shape2DKind, shared by the top-down 2D view and the 3D view (2D
 * shapes sit on their own work plane, so lifted shapes draw at their elevation in both). Non-2D
 * kinds render nothing.
 */

import type { Entity } from '@core/model/types';
import { LineRenderer } from './entities/LineRenderer';
import { PolylineRenderer } from './entities/PolylineRenderer';
import { CircleRenderer } from './entities/CircleRenderer';
import { ArcRenderer } from './entities/ArcRenderer';
import { RectangleRenderer } from './entities/RectangleRenderer';
import { PointRenderer } from './entities/PointRenderer';
import { EllipseRenderer } from './entities/EllipseRenderer';
import { SplineRenderer } from './entities/SplineRenderer';
import { TextRenderer2D } from './entities/TextRenderer2D';
import { DimensionRenderer2D } from './entities/DimensionRenderer2D';

export function Shape2DRenderer({
  entity,
  selected,
}: {
  entity: Entity;
  selected: boolean;
}): React.ReactElement | null {
  switch (entity.kind) {
    case 'line':
      return <LineRenderer entity={entity} selected={selected} />;
    case 'polyline':
      return <PolylineRenderer entity={entity} selected={selected} />;
    case 'circle':
      return <CircleRenderer entity={entity} selected={selected} />;
    case 'arc':
      return <ArcRenderer entity={entity} selected={selected} />;
    case 'rectangle':
      return <RectangleRenderer entity={entity} selected={selected} />;
    case 'point':
      return <PointRenderer entity={entity} selected={selected} />;
    case 'ellipse':
      return <EllipseRenderer entity={entity} selected={selected} />;
    case 'spline':
      return <SplineRenderer entity={entity} selected={selected} />;
    case 'text':
      return <TextRenderer2D entity={entity} selected={selected} />;
    case 'dimension':
      return <DimensionRenderer2D entity={entity} selected={selected} />;
    default:
      return null;
  }
}
