/** @layer ui/viewport/2d — top-view outline of a 3D solid (see solidOutline). */

import { useMemo } from 'react';
import type { Entity } from '@core/model/types';
import { useStore } from '@ui/store';
import { ringsToSegmentPositions, solidOutline } from '../solidOutline';
import { ShapeLine } from './ShapeLine';

const NO_ROTATION: [number, number, number] = [0, 0, 0];
const ORIGIN: [number, number, number] = [0, 0, 0];

export function SolidFootprintRenderer({
  entity,
  selected,
}: {
  entity: Entity;
  selected: boolean;
}): React.ReactElement | null {
  // Instances read their component definition; everything else only needs the entity itself.
  const components = useStore((s) => s.document.components);
  const positions = useMemo(() => {
    const rings = solidOutline({ ...useStore.getState().document, components }, entity);
    return rings === null ? null : ringsToSegmentPositions(rings);
  }, [entity, components]);
  if (positions === null) return null;
  return (
    <ShapeLine
      positions={positions}
      segments
      position={ORIGIN}
      rotation={NO_ROTATION}
      color={entity.color}
      selected={selected}
    />
  );
}
