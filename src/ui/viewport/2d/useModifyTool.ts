/**
 * @layer ui/viewport/2d
 *
 * State machine for interactive 2D modify tools.
 *
 * Collects entity-picks and numeric inputs, then calls store.dispatch with
 * the matching S2 command:
 *
 *   explode  → pick polyline → dispatch('explode_polyline', {id})
 *   offset   → pick entity  → set distance (input) → dispatch('offset_2d', {id, distance})
 *   trim     → pick target line → pick boundary line → dispatch('trim', {id, boundaryId})
 *   extend   → pick target line → pick boundary line → dispatch('extend', {id, boundaryId})
 *   fillet   → pick polyline → pick nearest vertex → set radius (input) → dispatch('fillet_2d', {id, vertexIndex, radius})
 *   chamfer  → pick polyline → pick nearest vertex → set distance (input) → dispatch('chamfer_2d', {id, vertexIndex, distance})
 *
 * Rules:
 * - NO entity is built here (PRIME DIRECTIVE). Dispatch only.
 * - Esc cancels the current operation; tool stays active.
 * - setActiveTool resets in-progress state.
 */

import { useState, useCallback, useEffect } from 'react';
import type { Vec2 } from '@core/model/types';
import { useStore } from '@ui/store';
import { nearestVertex } from './modifyHelpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModifyToolKind =
  | 'none'
  | 'offset'
  | 'fillet'
  | 'chamfer'
  | 'trim'
  | 'extend'
  | 'explode';

/** Describes what the user should do next for the active modify tool. */
export type ModifyToolPhase =
  /** No modify tool active. */
  | 'idle'
  /** Pick the entity to modify (first pick for all tools). */
  | 'pick-entity'
  /** Pick the boundary line (second pick for trim/extend). */
  | 'pick-boundary'
  /** Pick a vertex on the selected polyline (second pick for fillet/chamfer). */
  | 'pick-vertex'
  /** Enter a numeric value (distance for offset/chamfer, radius for fillet). */
  | 'enter-value';

export interface ModifyToolState {
  activeTool: ModifyToolKind;
  phase: ModifyToolPhase;
  /** Id of the first picked entity (target to modify). */
  pickedEntityId: string | null;
  /** Id of the second picked entity (boundary for trim/extend). */
  pickedBoundaryId: string | null;
  /** Nearest-vertex index for fillet/chamfer — set after vertex pick. */
  pickedVertexIndex: number | null;
  /** Pending numeric value (offset distance, fillet radius, chamfer distance). */
  pendingValue: number;
}

export interface UseModifyToolResult extends ModifyToolState {
  setActiveTool: (tool: ModifyToolKind) => void;
  /**
   * Handle a click on an entity in the viewport.
   * `entityId` is the id of the entity that was clicked.
   * `worldPoint` is the world-space click position (for nearest-vertex picking).
   * `entityPoints` is the vertex list, if the entity is a polyline (for fillet/chamfer).
   */
  handleEntityPick: (
    entityId: string,
    worldPoint: Vec2,
    entityPoints?: ReadonlyArray<Vec2>,
  ) => void;
  /** Update the pending numeric value (distance / radius input). */
  setPendingValue: (v: number) => void;
  /** Commit the pending numeric value and dispatch the command (for offset/fillet/chamfer). */
  commitValue: () => void;
  /** Cancel the current in-progress operation. The tool stays active. */
  cancel: () => void;
}

// ---------------------------------------------------------------------------
// Initial state helper
// ---------------------------------------------------------------------------

function initialState(): Omit<ModifyToolState, 'activeTool'> {
  return {
    phase: 'idle',
    pickedEntityId: null,
    pickedBoundaryId: null,
    pickedVertexIndex: null,
    pendingValue: 1,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useModifyTool(): UseModifyToolResult {
  const dispatch = useStore((s) => s.dispatch);

  const [activeTool, setActiveToolState] = useState<ModifyToolKind>('none');
  const [phase, setPhase] = useState<ModifyToolPhase>('idle');
  const [pickedEntityId, setPickedEntityId] = useState<string | null>(null);
  const [pickedBoundaryId, setPickedBoundaryId] = useState<string | null>(null);
  const [pickedVertexIndex, setPickedVertexIndex] = useState<number | null>(null);
  const [pendingValue, setPendingValue] = useState<number>(1);

  const resetProgress = useCallback(() => {
    const s = initialState();
    setPhase(s.phase);
    setPickedEntityId(s.pickedEntityId);
    setPickedBoundaryId(s.pickedBoundaryId);
    setPickedVertexIndex(s.pickedVertexIndex);
    setPendingValue(s.pendingValue);
  }, []);

  const setActiveTool = useCallback(
    (tool: ModifyToolKind) => {
      setActiveToolState(tool);
      resetProgress();
      setPhase(tool === 'none' ? 'idle' : 'pick-entity');
    },
    [resetProgress],
  );

  const cancel = useCallback(() => {
    resetProgress();
    // Re-enter pick-entity phase if a tool is still active.
    setPhase((prev) => (prev === 'idle' ? 'idle' : 'pick-entity'));
  }, [resetProgress]);

  const commitValue = useCallback(() => {
    if (activeTool === 'offset' && pickedEntityId !== null) {
      dispatch('offset_2d', { id: pickedEntityId, distance: pendingValue });
      resetProgress();
      setPhase('pick-entity');
    } else if (activeTool === 'fillet' && pickedEntityId !== null && pickedVertexIndex !== null) {
      dispatch('fillet_2d', { id: pickedEntityId, vertexIndex: pickedVertexIndex, radius: pendingValue });
      resetProgress();
      setPhase('pick-entity');
    } else if (activeTool === 'chamfer' && pickedEntityId !== null && pickedVertexIndex !== null) {
      dispatch('chamfer_2d', { id: pickedEntityId, vertexIndex: pickedVertexIndex, distance: pendingValue });
      resetProgress();
      setPhase('pick-entity');
    }
  }, [activeTool, dispatch, pendingValue, pickedEntityId, pickedVertexIndex, resetProgress]);

  const handleEntityPick = useCallback(
    (entityId: string, worldPoint: Vec2, entityPoints?: ReadonlyArray<Vec2>) => {
      if (activeTool === 'none') return;

      switch (activeTool) {
        case 'explode': {
          // Single pick — dispatch immediately.
          dispatch('explode_polyline', { id: entityId });
          resetProgress();
          setPhase('pick-entity');
          break;
        }

        case 'offset': {
          // Pick entity → enter distance value.
          setPickedEntityId(entityId);
          setPhase('enter-value');
          break;
        }

        case 'trim':
        case 'extend': {
          if (phase === 'pick-entity') {
            // First pick: the line to trim/extend.
            setPickedEntityId(entityId);
            setPhase('pick-boundary');
          } else if (phase === 'pick-boundary') {
            // Second pick: the boundary line.
            if (entityId === pickedEntityId) {
              // Same entity — ignore, wait for a different pick.
              break;
            }
            setPickedBoundaryId(entityId);
            // Dispatch immediately.
            const cmd = activeTool === 'trim' ? 'trim' : 'extend';
            dispatch(cmd, { id: pickedEntityId, boundaryId: entityId });
            resetProgress();
            setPhase('pick-entity');
          }
          break;
        }

        case 'fillet':
        case 'chamfer': {
          if (phase === 'pick-entity') {
            // First pick: the polyline entity.
            setPickedEntityId(entityId);
            setPhase('pick-vertex');
          } else if (phase === 'pick-vertex') {
            // Second pick: the vertex on the same polyline.
            // Use nearest-vertex picking if entityPoints is supplied.
            if (entityPoints && entityPoints.length > 0) {
              const nearest = nearestVertex(entityPoints, worldPoint);
              if (nearest !== null) {
                setPickedVertexIndex(nearest.vertexIndex);
                setPhase('enter-value');
              }
            }
          }
          break;
        }
      }
    },
    [activeTool, dispatch, phase, pickedEntityId, resetProgress],
  );

  // Keyboard: Esc cancels; Enter commits (for value phase).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        cancel();
      } else if (e.key === 'Enter' && phase === 'enter-value') {
        commitValue();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel, commitValue, phase]);

  return {
    activeTool,
    phase,
    pickedEntityId,
    pickedBoundaryId,
    pickedVertexIndex,
    pendingValue,
    setActiveTool,
    handleEntityPick,
    setPendingValue,
    commitValue,
    cancel,
  };
}
