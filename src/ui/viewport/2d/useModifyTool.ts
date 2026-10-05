/**
 * @layer ui/viewport/2d
 *
 * State machine for interactive 2D modify tools.
 *
 * Collects entity-picks and numeric inputs, then calls store.dispatch with
 * the matching 2D modify command:
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

import { useState, useCallback, useEffect } from 'react';
import type { Vec2 } from '@core/model/types';
import { useStore, useToolStore } from '@ui/store';
import type { ModifyToolKind } from '@ui/store';
import { isEditingKeyEvent } from '@ui/hooks/useKeyboardShortcuts';
import { nearestVertex, signedOffsetDistance } from './modifyHelpers';

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

interface ModifyProgress {
  phase: ModifyToolPhase;
  /** Id of the first picked entity (target to modify). */
  pickedEntityId: string | null;
  /** Nearest-vertex index for fillet/chamfer — set after vertex pick. */
  pickedVertexIndex: number | null;
  /** World-space pick that chose the side of an offset. */
  offsetPickPoint: Vec2 | null;
  /** Pending numeric value (offset distance, fillet radius, chamfer distance). */
  pendingValue: number;
}

/** Nothing picked yet: waiting for the first pick, or idle when no tool is armed. */
function freshProgress(tool: ModifyToolKind): ModifyProgress {
  return {
    phase: tool === 'none' ? 'idle' : 'pick-entity',
    pickedEntityId: null,
    pickedVertexIndex: null,
    offsetPickPoint: null,
    pendingValue: 1,
  };
}

interface UseModifyToolResult {
  activeTool: ModifyToolKind;
  phase: ModifyToolPhase;
  pickedEntityId: string | null;
  pickedVertexIndex: number | null;
  pendingValue: number;
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

const KEY_TO_TOOL: Readonly<Record<string, ModifyToolKind>> = {
  o: 'offset',
  f: 'fillet',
  k: 'chamfer',
  t: 'trim',
  x: 'extend',
  e: 'explode',
};

export function useModifyTool(): UseModifyToolResult {
  const dispatch = useStore((s) => s.dispatch);
  const activeTool = useToolStore((s) => s.modifyTool);
  const setModifyTool = useToolStore((s) => s.setModifyTool);
  const [progress, setProgress] = useState<ModifyProgress>(() => freshProgress('none'));
  const { phase, pickedEntityId, pickedVertexIndex, offsetPickPoint, pendingValue } = progress;

  const setActiveTool = useCallback(
    (tool: ModifyToolKind) => {
      setModifyTool(tool);
      setProgress(freshProgress(tool));
    },
    [setModifyTool],
  );

  const cancel = useCallback(() => {
    // Re-enter pick-entity phase if a tool is still active (read synchronously from the store).
    setProgress(freshProgress(useToolStore.getState().modifyTool));
  }, []);

  const setPendingValue = useCallback((value: number) => {
    setProgress((previous) => ({ ...previous, pendingValue: value }));
  }, []);

  const commitValue = useCallback(() => {
    if (pickedEntityId === null) return;
    if (activeTool === 'offset') {
      const entity = useStore.getState().document.entities[pickedEntityId];
      const distance = signedOffsetDistance(entity, offsetPickPoint, pendingValue);
      dispatch('offset_2d', { id: pickedEntityId, distance });
    } else if (pickedVertexIndex !== null && activeTool === 'fillet') {
      dispatch('fillet_2d', {
        id: pickedEntityId,
        vertexIndex: pickedVertexIndex,
        radius: pendingValue,
      });
    } else if (pickedVertexIndex !== null && activeTool === 'chamfer') {
      dispatch('chamfer_2d', {
        id: pickedEntityId,
        vertexIndex: pickedVertexIndex,
        distance: pendingValue,
      });
    } else {
      return;
    }
    setProgress(freshProgress(activeTool));
  }, [activeTool, dispatch, offsetPickPoint, pendingValue, pickedEntityId, pickedVertexIndex]);

  const handleEntityPick = useCallback(
    (entityId: string, worldPoint: Vec2, entityPoints?: ReadonlyArray<Vec2>) => {
      switch (activeTool) {
        case 'explode':
          dispatch('explode_polyline', { id: entityId });
          setProgress(freshProgress(activeTool));
          break;

        case 'offset':
          // The pick point (not just the entity) decides which side the offset goes to.
          setProgress((previous) => ({
            ...previous,
            pickedEntityId: entityId,
            offsetPickPoint: worldPoint,
            phase: 'enter-value',
          }));
          break;

        case 'trim':
        case 'extend':
          if (phase === 'pick-entity') {
            // First pick: the line to trim/extend.
            setProgress((previous) => ({
              ...previous,
              pickedEntityId: entityId,
              phase: 'pick-boundary',
            }));
          } else if (phase === 'pick-boundary' && entityId !== pickedEntityId) {
            // Second pick: the boundary line (the same entity is ignored). Dispatch immediately.
            dispatch(activeTool, { id: pickedEntityId, boundaryId: entityId });
            setProgress(freshProgress(activeTool));
          }
          break;

        case 'fillet':
        case 'chamfer':
          if (phase === 'pick-entity') {
            // First pick: the polyline entity.
            setProgress((previous) => ({
              ...previous,
              pickedEntityId: entityId,
              phase: 'pick-vertex',
            }));
          } else if (phase === 'pick-vertex') {
            // Second pick: the vertex nearest to the click on the already-picked polyline.
            const nearest = entityPoints ? nearestVertex(entityPoints, worldPoint) : null;
            if (nearest !== null) {
              setProgress((previous) => ({
                ...previous,
                pickedVertexIndex: nearest.vertexIndex,
                phase: 'enter-value',
              }));
            }
          }
          break;
      }
    },
    [activeTool, dispatch, phase, pickedEntityId],
  );

  // Keyboard: Esc cancels the pick in progress, then disarms; Enter commits (value phase);
  // O/F/K/T/X/E activate tools. Keys typed into fields or dialogs are never consumed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditingKeyEvent(e)) return;
      if (e.key === 'Escape') {
        if (activeTool === 'none') return;
        e.preventDefault();
        if (phase === 'pick-entity') setActiveTool('none');
        else cancel();
      } else if (e.key === 'Enter' && phase === 'enter-value') {
        commitValue();
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const tool = KEY_TO_TOOL[e.key.toLowerCase()];
        if (tool !== undefined) {
          e.preventDefault();
          setActiveTool(activeTool === tool ? 'none' : tool);
        }
      }
    };
    // Capture phase: runs before the global shortcut handler, which skips consumed (prevented) keys.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [activeTool, cancel, commitValue, phase, setActiveTool]);

  return {
    activeTool,
    // A tool disarmed from outside (e.g. arming a draw tool) leaves no phase behind.
    phase: activeTool === 'none' ? 'idle' : phase,
    pickedEntityId,
    pickedVertexIndex,
    pendingValue,
    setActiveTool,
    handleEntityPick,
    setPendingValue,
    commitValue,
    cancel,
  };
}
