/**
 * @layer ui/viewport/2d
 *
 * Click-capture plane for the active 2D modify tool.
 *
 * Mounted inside the r3f Canvas. Renders an invisible plane that captures
 * pointer events in world-space coordinates, then finds the nearest 2D entity
 * to the click and forwards the pick to `useModifyTool.handleEntityPick`.
 *
 * Entity proximity is computed by `nearestEntityId` from modifyHelpers — a pure
 * function tested independently (R1, architecture keep-math-in-helpers rule).
 * The tolerance (in world units) is exposed as a prop.
 *
 * Presentation only — no document mutations (R1).
 */

import { useCallback } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import type { Vec2 } from '@core/model/types';
import type { PolylineEntity } from '@core/model/types';
import { useStore } from '@ui/store';
import { nearestEntityId } from './modifyHelpers';
import type { ModifyToolKind } from '@ui/store';
import type { ModifyToolPhase } from './useModifyTool';
import { useGroundPlane } from './useGroundPlane';

interface ModifyPickInteractionProps {
  activeTool: ModifyToolKind;
  phase: ModifyToolPhase;
  /** Pick tolerance in world units — entities farther than this are ignored. */
  tolerance?: number;
  onEntityPick: (entityId: string, worldPoint: Vec2, entityPoints?: ReadonlyArray<Vec2>) => void;
}

export function ModifyPickInteraction({
  activeTool,
  phase,
  tolerance = 1.0,
  onEntityPick,
}: ModifyPickInteractionProps): React.ReactElement | null {
  const document = useStore((s) => s.document);
  const { invalidate } = useThree();

  const { geo, mat } = useGroundPlane();

  // Invalidate on pointer move so the cursor stays responsive under demand mode.
  const handleMove = useCallback(
    (_e: ThreeEvent<PointerEvent>) => {
      invalidate();
    },
    [invalidate],
  );

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (activeTool === 'none') return;
      // Only act during picking phases — not while the value input is open.
      if (phase !== 'pick-entity' && phase !== 'pick-boundary' && phase !== 'pick-vertex') return;

      e.stopPropagation();

      const [originX, originY] = useStore.getState().renderOrigin;
      const worldPick: Vec2 = [e.point.x + originX, e.point.y + originY];
      const bestId = nearestEntityId(document, worldPick, tolerance);
      if (bestId === null) return;

      const bestEntity = document.entities[bestId]!;
      const entityPoints =
        bestEntity.kind === 'polyline' ? (bestEntity as PolylineEntity).points : undefined;

      onEntityPick(bestId, worldPick, entityPoints);
    },
    [activeTool, document, onEntityPick, phase, tolerance],
  );

  // Don't intercept events when no modify tool is active or we're in value-entry phase.
  if (activeTool === 'none' || phase === 'idle' || phase === 'enter-value') return null;

  return (
    <mesh
      geometry={geo}
      material={mat}
      position={[0, 0, 0.001]}
      onPointerMove={handleMove}
      onClick={handleClick}
    />
  );
}
