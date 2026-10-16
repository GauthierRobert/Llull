// Tangent (amber) and normal (cyan) arrows at the start, middle and end of a selected involute polyline.

import { useMemo } from 'react';
import type { PolylineEntity } from '@core/model/types';
import { ShapeLine } from './ShapeLine';
import { involuteOverlay, overlaySegments } from './involuteFrames';

const TANGENT_COLOR = '#f5a524';
const NORMAL_COLOR = '#22d3ee';

export function InvoluteOverlay({ entity: { points, position, rotation } }: { entity: PolylineEntity }): React.ReactElement | null {
  const segments = useMemo(() => {
    const { frames, arrow } = involuteOverlay(points);
    return frames.length === 0 ? null : overlaySegments(frames, arrow);
  }, [points]);
  if (!segments) return null;
  return (
    <group name="involute-overlay">
      <ShapeLine segments positions={segments.tangents} position={position} rotation={rotation} color={TANGENT_COLOR} selected={false} />
      <ShapeLine segments positions={segments.normals} position={position} rotation={rotation} color={NORMAL_COLOR} selected={false} />
    </group>
  );
}
