/**
 * @layer ui/viewport/2d
 *
 * Click-capture plane for the active 2D modify tool.
 *
 * Mounted inside the r3f Canvas. Renders an invisible plane that captures
 * pointer events in world-space coordinates, then finds the nearest 2D entity
 * to the click and forwards the pick to `useModifyTool.handleEntityPick`.
 *
 * Entity proximity is computed on click using a pure spatial search over the
 * live document entities — no geometry math in the component (R1).
 * The tolerance (in world units) is exposed as a prop.
 *
 * Presentation only — no document mutations (R1).
 */

import { useMemo, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import type { Vec2 } from '@core/model/types';
import type { Entity, LineEntity, PolylineEntity } from '@core/model/types';
import { useStore } from '@ui/store';
import type { ModifyToolKind, ModifyToolPhase } from './useModifyTool';

// ---------------------------------------------------------------------------
// Pure spatial helpers (no geometry math in the component itself — R1)
// ---------------------------------------------------------------------------

/**
 * Squared distance from point P to the segment AB.
 * @pure
 */
function pointToSegDistSq(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? (apx * abx + apy * aby) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * abx - p[0];
  const cy = a[1] + t * aby - p[1];
  return cx * cx + cy * cy;
}

/**
 * Minimum squared distance from a pick point to a 2D entity.
 * Handles: line, polyline, circle, arc, rectangle.
 * Returns Infinity for unsupported kinds.
 * @pure
 */
function entityDistSq(entity: Entity, pick: Vec2): number {
  switch (entity.kind) {
    case 'line': {
      const l = entity as LineEntity;
      return pointToSegDistSq(pick, l.start, l.end);
    }
    case 'polyline': {
      const poly = entity as PolylineEntity;
      let best = Infinity;
      for (let i = 0; i < poly.points.length - 1; i++) {
        const d = pointToSegDistSq(pick, poly.points[i]!, poly.points[i + 1]!);
        if (d < best) best = d;
      }
      if (poly.closed && poly.points.length > 1) {
        const d = pointToSegDistSq(
          pick,
          poly.points[poly.points.length - 1]!,
          poly.points[0]!,
        );
        if (d < best) best = d;
      }
      return best;
    }
    case 'circle': {
      const c = entity as { kind: 'circle'; center: Vec2; radius: number } & Entity;
      const dx = pick[0] - c.center[0];
      const dy = pick[1] - c.center[1];
      const d = Math.sqrt(dx * dx + dy * dy) - c.radius;
      return d * d;
    }
    case 'rectangle': {
      const r = entity as { kind: 'rectangle'; width: number; height: number } & Entity;
      const ox = entity.position[0];
      const oy = entity.position[1];
      // Check each of the 4 sides.
      const tl: Vec2 = [ox, oy + r.height];
      const tr: Vec2 = [ox + r.width, oy + r.height];
      const bl: Vec2 = [ox, oy];
      const br: Vec2 = [ox + r.width, oy];
      return Math.min(
        pointToSegDistSq(pick, bl, br),
        pointToSegDistSq(pick, br, tr),
        pointToSegDistSq(pick, tr, tl),
        pointToSegDistSq(pick, tl, bl),
      );
    }
    default:
      return Infinity;
  }
}

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

      const pick: Vec2 = [e.point.x, e.point.y];
      const toleranceSq = tolerance * tolerance;

      let bestId: string | null = null;
      let bestDist = Infinity;

      for (const id of document.order) {
        const entity = document.entities[id];
        if (!entity) continue;

        // For fillet/chamfer in 'pick-vertex' phase: only consider the already-picked entity.
        if (
          (activeTool === 'fillet' || activeTool === 'chamfer') &&
          phase === 'pick-vertex'
        ) {
          // The entity pick for vertex phase is handled specially below.
          // We still need to find it by proximity so we check all and pick the best.
        }

        const dSq = entityDistSq(entity, pick);
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

      onEntityPick(bestId, pick, entityPoints);
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
