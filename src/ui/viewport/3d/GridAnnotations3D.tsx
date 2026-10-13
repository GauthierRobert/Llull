// Structural grid (S-GRID) in 3D: screen-space ground lines + camera-facing labelled bubbles sized to the grid extent.

import { useMemo } from 'react';
import { Billboard, Line, Text } from '@react-three/drei';
import type { CadDocument, Entity, Vec3 } from '@core/model/types';
import { circlePoints } from '@core/geometry/tessellation';
import { useViewportStore } from '@ui/store';
import { TEXT_FONT_URL } from '@ui/viewport/textFont';
import { closeLoop } from '@ui/viewport/lineGeometry';
import { collectGridAnnotations, GRID_LAYER_NAME } from './gridAnnotations';

const CIRCLE_SEGMENTS = 40;

/** First point repeated. */
function bubbleOutline(radius: number): Vec3[] {
  return closeLoop(circlePoints(0, 0, 0, radius, CIRCLE_SEGMENTS));
}

export function GridAnnotations3D({ document }: { document: CadDocument }): React.ReactElement {
  const { order, entities, layers } = document;
  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);

  const annotations = useMemo(() => {
    const gridEntities = order
      .map((id) => entities[id])
      .filter((entity): entity is Entity => {
        if (!entity) return false;
        const layer = layers[entity.layerId];
        if (layer?.name !== GRID_LAYER_NAME || !layer.visible) return false;
        return !hiddenLayerIds.has(entity.layerId) && !hiddenEntityIds.has(entity.id);
      });
    return collectGridAnnotations(gridEntities);
  }, [order, entities, layers, hiddenLayerIds, hiddenEntityIds]);
  // One outline per bubble radius.
  const outlines = useMemo(
    () => new Map(annotations.bubbles.map((bubble) => [bubble.radius, bubbleOutline(bubble.radius)])),
    [annotations],
  );

  return (
    <group name="grid-annotations-3d">
      {annotations.axes.map((axis) => (
        <Line
          key={axis.id}
          points={[axis.start, axis.end]}
          color={axis.color}
          lineWidth={1.5}
          depthTest={false}
          renderOrder={20}
          raycast={() => null}
        />
      ))}
      {annotations.bubbles.map((bubble) => (
        <Billboard key={bubble.id} position={[bubble.center[0], bubble.center[1], bubble.center[2] + bubble.radius]}>
          <Line
            points={outlines.get(bubble.radius) ?? bubbleOutline(bubble.radius)}
            color={bubble.color}
            lineWidth={2}
            depthTest={false}
            renderOrder={20}
            raycast={() => null}
          />
          <Text
            font={TEXT_FONT_URL}
            fontSize={bubble.radius * 1.1}
            color={bubble.color}
            anchorX="center"
            anchorY="middle"
            renderOrder={21}
            material-depthTest={false}
            raycast={() => null}
          >
            {bubble.label}
          </Text>
        </Billboard>
      ))}
    </group>
  );
}
