/**
 * @layer ui/viewport/2d
 *
 * State machine for interactive 2D modify tools.
 *
 * Collects entity-picks and numeric inputs, then calls store.dispatch with
 * the matching S2 command:
 *
 *   explode  → pick polyline → dispatch('explode_polyline', {id})
 *   offset   → pick entity  → pick side point → set distance (input) → dispatch('offset_2d', {id, distance})
 *   trim     → pick target line → pick boundary line → dispatch('trim', {id, boundaryId})
 *   extend   → pick target line → pick boundary line → dispatch('extend', {id, boundaryId})
 *   fillet   → pick polyline → pick nearest vertex → set radius (input) → dispatch('fillet_2d', {id, vertexIndex, radius})
 *   chamfer  → pick polyline → pick nearest vertex → set distance (input) → dispatch('chamfer_2d', {id, vertexIndex, distance})
 *
 * Rules:
 * - NO entity is built here (PRIME DIRECTIVE). Dispatch only.
 * - Esc cancels the current operation; tool stays active.
 * - setActiveTool resets in-progress state.
 * - Keyboard shortcut keys (O/F/K/T/X/E) activate the matching tool.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { Vec2 } from '@core/model/types';
import type { LineEntity, PolylineEntity } from '@core/model/types';
import { useStore } from '@ui/store';
import { nearestVertex, offsetSideSign } from './modifyHelpers';

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
   * `worldPoint` is the world-space click position (for nearest-vertex picking and offset side determination).
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
// Keyboard shortcut → tool mapping (O/F/K/T/X/E)
// ---------------------------------------------------------------------------

const KEY_TO_TOOL: Readonly<Record<string, ModifyToolKind>> = {
  o: 'offset',
  f: 'fillet',
  k: 'chamfer',
  t: 'trim',
  x: 'extend',
  e: 'explode',
};

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
  const entities = useStore((s) => s.document.entities);

  const [activeTool, setActiveToolState] = useState<ModifyToolKind>('none');
  const [phase, setPhase] = useState<ModifyToolPhase>('idle');
  const [pickedEntityId, setPickedEntityId] = useState<string | null>(null);
  const [pickedBoundaryId, setPickedBoundaryId] = useState<string | null>(null);
  const [pickedVertexIndex, setPickedVertexIndex] = useState<number | null>(null);
  const [pendingValue, setPendingValue] = useState<number>(1);

  // Ref to store the pick point for the offset side-sign computation.
  // Not state: it is a transient intermediate consumed only by commitValue.
  const offsetPickPointRef = useRef<Vec2 | null>(null);

  // Stable ref to the current activeTool so cancel() can read it synchronously
  // without being stale when resetProgress and cancel both batch in one keydown handler.
  const activeToolRef = useRef<ModifyToolKind>('none');

  const resetProgress = useCallback(() => {
    const s = initialState();
    setPhase(s.phase);
    setPickedEntityId(s.pickedEntityId);
    setPickedBoundaryId(s.pickedBoundaryId);
    setPickedVertexIndex(s.pickedVertexIndex);
    setPendingValue(s.pendingValue);
    offsetPickPointRef.current = null;
  }, []);

  const setActiveTool = useCallback(
    (tool: ModifyToolKind) => {
      setActiveToolState(tool);
      activeToolRef.current = tool;
      resetProgress();
      setPhase(tool === 'none' ? 'idle' : 'pick-entity');
    },
    [resetProgress],
  );

  const cancel = useCallback(() => {
    resetProgress();
    // Re-enter pick-entity phase if a tool is still active.
    // Use the ref (not the stale phase snapshot) so that when resetProgress and
    // cancel both fire in the same React batch, we still see the correct activeTool
    // value rather than the just-cleared 'idle' produced by resetProgress.
    setPhase(activeToolRef.current === 'none' ? 'idle' : 'pick-entity');
  }, [resetProgress]);

  const commitValue = useCallback(() => {
    if (activeTool === 'offset' && pickedEntityId !== null) {
      // Apply side-sign: multiply pendingValue by +1 (left of start→end) or -1 (right).
      const entity = entities[pickedEntityId];
      const pickPt = offsetPickPointRef.current;
      let signedDistance = pendingValue;
      if (pickPt !== null && entity !== undefined) {
        const pos = entity.position;
        // Shift the world-space pick into the entity's local frame.
        const localPick: Vec2 = [pickPt[0] - pos[0], pickPt[1] - pos[1]];
        if (entity.kind === 'line') {
          const line = entity as LineEntity;
          signedDistance = pendingValue * offsetSideSign(line.start, line.end, localPick);
        } else if (entity.kind === 'polyline') {
          const poly = entity as PolylineEntity;
          if (poly.points.length >= 2) {
            signedDistance =
              pendingValue * offsetSideSign(poly.points[0]!, poly.points[1]!, localPick);
          }
        }
      }
      dispatch('offset_2d', { id: pickedEntityId, distance: signedDistance });
      resetProgress();
      setPhase('pick-entity');
    } else if (activeTool === 'fillet' && pickedEntityId !== null && pickedVertexIndex !== null) {
      dispatch('fillet_2d', {
        id: pickedEntityId,
        vertexIndex: pickedVertexIndex,
        radius: pendingValue,
      });
      resetProgress();
      setPhase('pick-entity');
    } else if (activeTool === 'chamfer' && pickedEntityId !== null && pickedVertexIndex !== null) {
      dispatch('chamfer_2d', {
        id: pickedEntityId,
        vertexIndex: pickedVertexIndex,
        distance: pendingValue,
      });
      resetProgress();
      setPhase('pick-entity');
    }
  }, [activeTool, dispatch, entities, pendingValue, pickedEntityId, pickedVertexIndex, resetProgress]);

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
          // Pick entity → capture the pick point (for side-sign) → enter distance value.
          setPickedEntityId(entityId);
          offsetPickPointRef.current = worldPoint;
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
            // Second pick: the vertex on the already-picked polyline.
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

  // Keyboard: Esc cancels; Enter commits (value phase); O/F/K/T/X/E activate tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Do not steal keys from text inputs.
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      if (e.key === 'Escape') {
        cancel();
      } else if (e.key === 'Enter' && phase === 'enter-value') {
        commitValue();
      } else if (!isInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tool = KEY_TO_TOOL[e.key.toLowerCase()];
        if (tool !== undefined) {
          e.preventDefault();
          setActiveTool(activeTool === tool ? 'none' : tool);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTool, cancel, commitValue, phase, setActiveTool]);

  // Keep activeToolRef in sync for use in cancel().
  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

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
