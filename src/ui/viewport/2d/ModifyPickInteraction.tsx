/**
 * @layer ui/viewport/2d
 *
 * Click-capture plane for the active 2D modify tool.
 *
 * Mounted inside the r3f Canvas. Renders an invisible plane that captures pointer events in
 * document-space coordinates, finds the nearest 2D entity to the click (`nearestEntityId`, a pure
 * helper tested independently) and forwards the pick to `useModifyTool.handleEntityPick`.
 *
 * Presentation only — no document mutations (R1).
 */

import { useThree } from '@react-three/fiber';
import type { Vec2 } from '@core/model/types';
import { useStore } from '@ui/store';
import { nearestEntityId } from './modifyHelpers';
import type { ModifyToolKind } from '@ui/store';
import type { ModifyToolPhase } from './useModifyTool';
import { GroundPlane, toDocumentPoint } from './GroundPlane';

/** Pick tolerance in world units — entities farther than this are ignored. */
const PICK_TOLERANCE = 1;

interface ModifyPickInteractionProps {
  activeTool: ModifyToolKind;
  phase: ModifyToolPhase;
  onEntityPick: (entityId: string, worldPoint: Vec2, entityPoints?: ReadonlyArray<Vec2>) => void;
}

export function ModifyPickInteraction({
  activeTool,
  phase,
  onEntityPick,
}: ModifyPickInteractionProps): React.ReactElement | null {
  const invalidate = useThree((s) => s.invalidate);

  // Don't intercept events when no modify tool is active or we're in value-entry phase.
  if (activeTool === 'none' || phase === 'idle' || phase === 'enter-value') return null;

  return (
    <GroundPlane
      z={0.001}
      // Invalidate on pointer move so the cursor stays responsive under demand mode.
      onPointerMove={() => invalidate()}
      onClick={(e) => {
        // Only act during picking phases.
        if (phase !== 'pick-entity' && phase !== 'pick-boundary' && phase !== 'pick-vertex') return;

        e.stopPropagation();

        const { document } = useStore.getState();
        const worldPick = toDocumentPoint(e.point);
        const bestId = nearestEntityId(document, worldPick, PICK_TOLERANCE);
        if (bestId === null) return;

        const bestEntity = document.entities[bestId];
        onEntityPick(
          bestId,
          worldPick,
          bestEntity?.kind === 'polyline' ? bestEntity.points : undefined,
        );
      }}
    />
  );
}
