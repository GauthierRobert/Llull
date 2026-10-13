// In-Canvas click plane of the active 2D modify tool: nearest 2D entity → useModifyTool.handleEntityPick.

import { useThree } from '@react-three/fiber';
import { type Vec2, is2D } from '@core/model/types';
import type { ModifyToolKind } from '@ui/store';
import { nearestEntityId } from './modifyHelpers';
import { pickContext } from './pickContext';
import type { ModifyToolPhase } from './useModifyTool';
import { GroundPlane, toDocumentPoint } from './GroundPlane';

interface ModifyPickInteractionProps {
  activeTool: ModifyToolKind;
  phase: ModifyToolPhase;
  /** Px per world unit; scales the pick radius. */
  zoom: number;
  onEntityPick: (entityId: string, worldPoint: Vec2, entityPoints?: ReadonlyArray<Vec2>) => void;
}

export function ModifyPickInteraction({ activeTool, phase, zoom, onEntityPick }: ModifyPickInteractionProps): React.ReactElement | null {
  const invalidate = useThree((s) => s.invalidate);

  if (activeTool === 'none' || phase === 'idle' || phase === 'enter-value') return null;

  return (
    <GroundPlane
      z={0.001}
      // Keeps the cursor responsive under the demand frameloop.
      onPointerMove={() => invalidate()}
      onClick={(e) => {
        if (phase !== 'pick-entity' && phase !== 'pick-boundary' && phase !== 'pick-vertex') return;

        e.stopPropagation();

        const worldPick = toDocumentPoint(e.point);
        // Modify tools apply to 2D shapes only.
        const { document, tolerance, accepts } = pickContext(zoom, is2D);
        const bestId = nearestEntityId(document, worldPick, tolerance, accepts);
        if (bestId === null) return;

        const bestEntity = document.entities[bestId];
        onEntityPick(bestId, worldPick, bestEntity?.kind === 'polyline' ? bestEntity.points : undefined);
      }}
    />
  );
}
