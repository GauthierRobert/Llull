/**
 * 2D draw-tool state machine over already-snapped world points → draw_* dispatch (no entity built here).
 * Esc cancels the shape in progress, then returns to Select; Enter / double-click finishes a chain (polyline, wall, spline);
 * 'move' translates the selection by (second − first click) via move_entities.
 */

import { useState, useCallback, useRef } from 'react';
import type { Vec2 } from '@core/model/types';
import { type DrawToolKind, useStore, useToolStore } from '@ui/store';
import { isEditingKeyEvent } from '@ui/hooks/useKeyboardShortcuts';
import { useCaptureKeydown } from '@ui/hooks/useCaptureKeydown';
import { useToolKeys } from '@ui/hooks/useToolKeys';
import { drawToolDescriptor, isChainTool } from './drawToolTable';

interface UseDrawToolResult {
  activeTool: DrawToolKind;
  collectedPoints: Vec2[];
  setActiveTool: (tool: DrawToolKind) => void;
  handleClick: (point: Vec2) => void;
  /** Double-click or Enter. */
  finishChain: () => void;
}

interface DrawProgress {
  tool: DrawToolKind;
  points: Vec2[];
}

const EMPTY_POINTS: Vec2[] = [];
const EMPTY_PROGRESS: DrawProgress = { tool: 'none', points: EMPTY_POINTS };

export function useDrawTool(): UseDrawToolResult {
  const dispatch = useStore((s) => s.dispatch);
  const activeTool = useToolStore((s) => s.drawTool);
  const setDrawTool = useToolStore((s) => s.setDrawTool);
  // Points belong to the tool that collected them, so switching tools drops them without an effect.
  const [progress, setProgress] = useState<DrawProgress>(EMPTY_PROGRESS);
  const collectedPoints = progress.tool === activeTool ? progress.points : EMPTY_POINTS;
  const inProgress = collectedPoints.length > 0;
  // Synchronous mirror: a fast double-click delivers click, click, dblclick before the root re-renders.
  const progressRef = useRef<DrawProgress>(EMPTY_PROGRESS);
  const setCollectedPoints = useCallback(
    (next: Vec2[] | ((previous: Vec2[]) => Vec2[])) => {
      const previous = progressRef.current;
      const current = previous.tool === activeTool ? previous.points : EMPTY_POINTS;
      progressRef.current = { tool: activeTool, points: typeof next === 'function' ? next(current) : next };
      setProgress(progressRef.current);
    },
    [activeTool],
  );

  const setActiveTool = useCallback(
    (tool: DrawToolKind) => {
      setDrawTool(tool);
      setCollectedPoints([]);
    },
    [setDrawTool, setCollectedPoints],
  );

  /** Read from the synchronous mirror, never the render closure. */
  const livePoints = useCallback(
    (): Vec2[] => (progressRef.current.tool === activeTool ? progressRef.current.points : EMPTY_POINTS),
    [activeTool],
  );

  const finishChain = useCallback(() => {
    const points = livePoints();
    if (points.length >= 2) drawToolDescriptor(activeTool)?.commit(points, dispatch);
    setCollectedPoints([]);
  }, [activeTool, dispatch, livePoints, setCollectedPoints]);

  const handleClick = useCallback(
    (point: Vec2) => {
      const descriptor = drawToolDescriptor(activeTool);
      if (!descriptor) return;
      if (descriptor.requiresSelection && useStore.getState().document.selection.length === 0) return;
      const next = [...livePoints(), point];
      // Chains append until finishChain(); the others commit at maxPoints.
      if (descriptor.maxPoints === null || next.length < descriptor.maxPoints) {
        setCollectedPoints(next);
        return;
      }
      descriptor.commit(next, dispatch);
      setCollectedPoints([]);
    },
    [activeTool, dispatch, livePoints, setCollectedPoints],
  );

  const clearPoints = useCallback(() => setCollectedPoints([]), [setCollectedPoints]);
  const disarm = useCallback(() => setActiveTool('none'), [setActiveTool]);
  useToolKeys({
    armed: activeTool !== 'none',
    inProgress,
    onCancel: clearPoints,
    onDisarm: disarm,
    onEnter: isChainTool(activeTool) ? finishChain : null,
  });

  // Ctrl/Cmd+Z mid-operation drops the last point; stopPropagation hides it from the global undo shortcut.
  const onUndoKey = useCallback(
    (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      if (isEditingKeyEvent(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setCollectedPoints((prev) => prev.slice(0, -1));
    },
    [setCollectedPoints],
  );
  useCaptureKeydown(inProgress ? onUndoKey : null);

  return { activeTool, collectedPoints, setActiveTool, handleClick, finishChain };
}
