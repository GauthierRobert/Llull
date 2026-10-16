import { useMemo } from 'react';
import type { PolylineEntity } from '@core/model/types';
import { closeLoop, flattenPoints } from '../../lineGeometry';
import { ShapeLine } from './ShapeLine';
import { InvoluteOverlay } from './InvoluteOverlay';
import { isInvoluteId } from './involuteFrames';

export function PolylineRenderer({ entity, selected }: { entity: PolylineEntity; selected: boolean }): React.ReactElement | null {
  const { points, closed, position, rotation, color } = entity;
  // `points` is a fresh array only when the polyline actually changes (commands are pure, L3),
  // so the reference is a correct + cheap memo key — no serialization.
  const positions = useMemo(() => (points.length < 2 ? null : flattenPoints(closed ? closeLoop(points) : points)), [points, closed]);

  if (!positions) return null;
  return (
    <>
      <ShapeLine positions={positions} position={position} rotation={rotation} color={color} selected={selected} />
      {selected && isInvoluteId(entity.id) && <InvoluteOverlay entity={entity} />}
    </>
  );
}
