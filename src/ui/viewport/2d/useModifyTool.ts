/**
 * Pick state machine of the 2D modify tools → dispatch only (no entity built here):
 *   explode: pick polyline → explode_polyline · offset: pick entity (pick point = side) → value → offset_2d
 *   trim/extend: pick target → pick boundary → trim/extend · fillet/chamfer: pick polyline → vertex → value → fillet_2d/chamfer_2d
 * Esc cancels the pick (tool stays armed), then disarms; Enter commits; O/F/K/T/X/E toggle tools.
 */

import { useState, useCallback } from 'react';
import type { Vec2 } from '@core/model/types';
import { type ModifyToolKind, useStore, useToolStore } from '@ui/store';
import { useToolKeys } from '@ui/hooks/useToolKeys';
import { MODIFY_KEYS } from '@ui/hooks/shortcuts';
import { nearestVertex, signedOffsetDistance } from './modifyHelpers';

export type ModifyToolPhase = 'idle' | 'pick-entity' | 'pick-boundary' | 'pick-vertex' | 'enter-value';

interface ModifyProgress {
  phase: ModifyToolPhase;
  pickedEntityId: string | null;
  pickedVertexIndex: number | null;
  offsetPickPoint: Vec2 | null;
  /** Offset distance, fillet radius or chamfer distance. */
  pendingValue: number;
}

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
  /** Arm `tool`, or disarm it when it is already armed. */
  toggleTool: (tool: ModifyToolKind) => void;
  /** `worldPoint` picks the offset side / nearest vertex; `entityPoints` = polyline vertices (fillet/chamfer). */
  handleEntityPick: (entityId: string, worldPoint: Vec2, entityPoints?: ReadonlyArray<Vec2>) => void;
  setPendingValue: (v: number) => void;
  commitValue: () => void;
  cancel: () => void;
}

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
      dispatch('fillet_2d', { id: pickedEntityId, vertexIndex: pickedVertexIndex, radius: pendingValue });
    } else if (pickedVertexIndex !== null && activeTool === 'chamfer') {
      dispatch('chamfer_2d', { id: pickedEntityId, vertexIndex: pickedVertexIndex, distance: pendingValue });
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
          setProgress((previous) => ({ ...previous, pickedEntityId: entityId, offsetPickPoint: worldPoint, phase: 'enter-value' }));
          break;
        case 'trim':
        case 'extend':
          if (phase === 'pick-entity') {
            setProgress((previous) => ({ ...previous, pickedEntityId: entityId, phase: 'pick-boundary' }));
          } else if (phase === 'pick-boundary' && entityId !== pickedEntityId) {
            dispatch(activeTool, { id: pickedEntityId, boundaryId: entityId });
            setProgress(freshProgress(activeTool));
          }
          break;
        case 'fillet':
        case 'chamfer':
          if (phase === 'pick-entity') {
            setProgress((previous) => ({ ...previous, pickedEntityId: entityId, phase: 'pick-vertex' }));
          } else if (phase === 'pick-vertex' && entityId === pickedEntityId) {
            // Only on the picked polyline: another entity's click must not index the wrong vertex list.
            const nearest = entityPoints ? nearestVertex(entityPoints, worldPoint) : null;
            if (nearest !== null) {
              setProgress((previous) => ({ ...previous, pickedVertexIndex: nearest.vertexIndex, phase: 'enter-value' }));
            }
          }
          break;
      }
    },
    [activeTool, dispatch, phase, pickedEntityId],
  );

  // Keys typed into fields or dialogs are never consumed.
  const disarm = useCallback(() => setActiveTool('none'), [setActiveTool]);
  const toggleTool = useCallback(
    (tool: ModifyToolKind) => setActiveTool(useToolStore.getState().modifyTool === tool ? 'none' : tool),
    [setActiveTool],
  );
  const onHotkey = useCallback(
    (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tool = MODIFY_KEYS[e.key.toLowerCase()];
      if (tool === undefined) return;
      e.preventDefault();
      toggleTool(tool);
    },
    [toggleTool],
  );
  useToolKeys({
    armed: activeTool !== 'none',
    inProgress: phase !== 'pick-entity',
    onCancel: cancel,
    onDisarm: disarm,
    onEnter: phase === 'enter-value' ? commitValue : null,
    onOtherKey: onHotkey,
  });

  return {
    activeTool,
    // A tool disarmed from outside (e.g. arming a draw tool) leaves no phase behind.
    phase: activeTool === 'none' ? 'idle' : phase,
    pickedEntityId,
    pickedVertexIndex,
    pendingValue,
    setActiveTool,
    toggleTool,
    handleEntityPick,
    setPendingValue,
    commitValue,
    cancel,
  };
}
