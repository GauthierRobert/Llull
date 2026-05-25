/**
 * @layer ui/viewport/2d
 *
 * Click-capture plane for the active 2D modify tool.
 *
 * Mounted inside the r3f Canvas. Renders an invisible plane that captures
 * pointer events in world-space coordinates, then finds the nearest 2D entity
 * to the click and forwards the pick to `useModifyTool.handleEntityPick`.
 *
 * Entity proximity is computed by `entityDistSq` from modifyHelpers — a pure
 * function tested independently (R1, architecture keep-math-in-helpers rule).
 * The tolerance (in world units) is exposed as a prop.
 *
 * Presentation only — no document mutations (R1).
 */

import { useMemo, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import type { Vec2 } from '@core/model/types';
import type { PolylineEntity } from '@core/model/types';
import { useStore } from '@ui/store';
import { entityDistSq } from './modifyHelpers';
import type { ModifyToolKind, ModifyToolPhase } from './useModifyTool';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ModifyPickInteractionProps {
  activeTool: ModifyToolKind;
  phase: ModifyToolPhase;
  /** Pick tolerance in world units — entities farther than this are ignored. */
  tolerance?: number;
  onEntityPick: (entityId: string, worldPoint: Vec2, entityPoints?: ReadonlyArray<Vec2>) => void;
}

// ---------------------------------------------------------------------------
// ModifyPickInteraction
// ---------------------------------------------------------------------------

export function ModifyPickInteraction({
  activeTool,
  phase,
  tolerance = 1.0,
  onEntityPick,
}: ModifyPickInteractionProps): React.ReactElement | null {
  const document = useStore((s) => s.document);
  const { invalidate } = useThree();

  const geo = useMemo(() => new THREE.PlaneGeometry(100000, 100000), []);
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    [],
  );

  useEffect(() => {
    return () => {
      geo.dispose();
      mat.dispose();
    };
  }, [geo, mat]);

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

      const worldPick: Vec2 = [e.point.x, e.point.y];
      const toleranceSq = tolerance * tolerance;

      let bestId: string | null = null;
      let bestDist = Infinity;

      for (const id of document.order) {
        const entity = document.entities[id];
        if (!entity) continue;

        const dSq = entityDistSq(entity, worldPick);
        if (dSq < toleranceSq && dSq < bestDist) {
          bestDist = dSq;
          bestId = id;
        }
      }

      if (bestId === null) return;

      const bestEntity = document.entities[bestId]!;
      const entityPoints =
        bestEntity.kind === 'polyline'
          ? (bestEntity as PolylineEntity).points
          : undefined;

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
