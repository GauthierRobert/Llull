/**
 * @layer ui/viewport/2d
 *
 * State machine for interactive 2D draw tools.
 *
 * Collects snapped click points, manages in-progress state, and on
 * completion calls store.dispatch with the matching draw_* command.
 *
 * Rules:
 * - NO entity is built here (PRIME DIRECTIVE). Dispatch only.
 * - Snap is applied by the caller via useSnap; this hook receives
 *   already-snapped world coords.
 * - Esc cancels the current in-progress shape; Esc with nothing in progress returns to Select.
 * - Enter or double-click finishes a polyline, wall chain or spline in progress.
 * - 'move' translates the current selection by (second click - first click) via move_entities.
 * - The hook is purely React state + callbacks — no three.js here.
 */

import { useState, useCallback, useRef } from 'react';
import type { Vec2 } from '@core/model/types';
import { type DrawToolKind, useStore, useToolStore } from '@ui/store';
import { isEditingKeyEvent } from '@ui/hooks/useKeyboardShortcuts';
import { useCaptureKeydown } from '@ui/hooks/useCaptureKeydown';
import { drawToolDescriptor, isChainTool } from './drawToolTable';

interface UseDrawToolResult {
  /** The currently active tool. */
  activeTool: DrawToolKind;
  /** Points collected so far in the current drawing operation. */
  collectedPoints: Vec2[];
  /** Set the active draw tool; resets in-progress state. */
  setActiveTool: (tool: DrawToolKind) => void;
  /**
   * Record a snapped click at world position.
   * Handles the state transitions and dispatch for each tool.
   */
  handleClick: (point: Vec2) => void;
  /** Finish the polyline / wall chain / spline in progress (double-click or Enter). */
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
  // Points belong to the tool that collected them; switching tools (toolbar, shortcut, palette)
  // therefore drops them without an effect.
  const [progress, setProgress] = useState<DrawProgress>(EMPTY_PROGRESS);
  const collectedPoints = progress.tool === activeTool ? progress.points : EMPTY_POINTS;
  const inProgress = collectedPoints.length > 0;
  // Synchronous mirror of `progress`: a fast double-click delivers click, click, dblclick before the
  // canvas root re-renders, so finishChain must not read the points from its render closure.
  const progressRef = useRef<DrawProgress>(EMPTY_PROGRESS);
  const setCollectedPoints = useCallback(
    (next: Vec2[] | ((previous: Vec2[]) => Vec2[])) => {
      const previous = progressRef.current;
      const current = previous.tool === activeTool ? previous.points : EMPTY_POINTS;
      progressRef.current = {
        tool: activeTool,
        points: typeof next === 'function' ? next(current) : next,
      };
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

  /** Points of the shape in progress, read from the synchronous mirror (never the render closure). */
  const livePoints = useCallback(
    (): Vec2[] =>
      progressRef.current.tool === activeTool ? progressRef.current.points : EMPTY_POINTS,
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
      if (descriptor.requiresSelection && useStore.getState().document.selection.length === 0) {
        return;
      }
      const next = [...livePoints(), point];
      // Chains keep appending until finishChain() (Enter / double-click); the others commit at maxPoints.
      if (descriptor.maxPoints === null || next.length < descriptor.maxPoints) {
        setCollectedPoints(next);
        return;
      }
      descriptor.commit(next, dispatch);
      setCollectedPoints([]);
    },
    [activeTool, dispatch, livePoints, setCollectedPoints],
  );

  // Keyboard: Escape cancels; Enter finishes a polyline, wall chain or spline.
  const onKey = useCallback(
    (e: KeyboardEvent): void => {
      if (isEditingKeyEvent(e)) return;
      if (e.key === 'Escape') {
        // First Esc drops the shape in progress; a second Esc returns to Select.
        if (activeTool === 'none') return;
        e.preventDefault();
        if (inProgress) setCollectedPoints([]);
        else setActiveTool('none');
      } else if (e.key === 'Enter' && isChainTool(activeTool)) {
        finishChain();
      }
    },
    [activeTool, inProgress, finishChain, setActiveTool, setCollectedPoints],
  );
  useCaptureKeydown(onKey);

  // Ctrl/Cmd+Z mid-operation removes the last collected point instead of undoing the document.
  // stopPropagation so the global undo shortcut never sees it.
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
