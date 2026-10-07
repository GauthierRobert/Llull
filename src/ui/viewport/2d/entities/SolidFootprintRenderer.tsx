/** @layer ui/viewport/2d — top-view outline of a 3D solid (see solidFootprint). */

import { useMemo } from 'react';
import type { Entity } from '@core/model/types';
import { useStore } from '@ui/store';
import { flattenPoints } from '../../lineGeometry';
import { footprintOutline, solidFootprint } from '../solidFootprint';
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
    const rect = solidFootprint({ ...useStore.getState().document, components }, entity);
    return rect === null ? null : flattenPoints(footprintOutline(rect));
  }, [entity, components]);
  if (positions === null) return null;
  return (
    <ShapeLine
      positions={positions}
      position={ORIGIN}
      rotation={NO_ROTATION}
      color={entity.color}
      selected={selected}
    />
  );
}
