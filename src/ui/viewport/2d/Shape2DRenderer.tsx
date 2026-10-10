/**
 * @layer ui/viewport/2d
 *
 * One pure render branch per Shape2DKind, shared by the top-down 2D view and the 3D view (2D
 * shapes sit on their own work plane, so lifted shapes draw at their elevation in both). Non-2D
 * kinds render nothing.
 */

import type { Entity, Shape2DKind } from '@core/model/types';
import { LineRenderer } from './entities/LineRenderer';
import { PolylineRenderer } from './entities/PolylineRenderer';
import { ArcRenderer, CircleRenderer, EllipseRenderer } from './entities/EllipticalRenderers';
import { RectangleRenderer } from './entities/RectangleRenderer';
import { PointRenderer } from './entities/PointRenderer';
import { SplineRenderer } from './entities/SplineRenderer';
import { TextRenderer2D } from './entities/TextRenderer2D';
import { DimensionRenderer2D } from './entities/DimensionRenderer2D';

type RenderBranch<E> = (props: { entity: E; selected: boolean }) => React.ReactElement | null;

const RENDERERS: { [K in Shape2DKind]: RenderBranch<Extract<Entity, { kind: K }>> } = {
  line: LineRenderer,
  polyline: PolylineRenderer,
  circle: CircleRenderer,
  arc: ArcRenderer,
  rectangle: RectangleRenderer,
  point: PointRenderer,
  ellipse: EllipseRenderer,
  spline: SplineRenderer,
  text: TextRenderer2D,
  dimension: DimensionRenderer2D,
};

export function Shape2DRenderer({
  entity,
  selected,
}: {
  entity: Entity;
  selected: boolean;
}): React.ReactElement | null {
  if (!(entity.kind in RENDERERS)) return null;
  // The map is keyed by kind, so the branch picked always matches the entity's narrowed type.
  const Renderer = RENDERERS[entity.kind as Shape2DKind] as RenderBranch<Entity>;
  return <Renderer entity={entity} selected={selected} />;
}
