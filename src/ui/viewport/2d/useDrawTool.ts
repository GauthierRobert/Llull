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
 * - 'move' translates the current selection by (second click - first click) via move_entity.
 * - The hook is purely React state + callbacks — no three.js here.
 */

import { useState, useCallback, useEffect } from 'react';
import type { Vec2 } from '@core/model/types';
import { useStore, useToolStore } from '@ui/store';
import type { DrawToolKind } from '@ui/store';
import { moveSelection } from '@ui/actions/selectionActions';
import { isEditingKeyEvent } from '@ui/hooks/useKeyboardShortcuts';
import {
  CHAIN_DRAW_TOOLS,
  rectParamsFromCorners,
  circleRadiusFromPoints,
  dropRepeatedPoints,
  ellipseParamsFromCenterCorner,
} from './drawHelpers';

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

/**
 * Wall-chain params: consecutive near-duplicate clicks (a double-click to finish adds the last
 * point twice) are merged; clicking the first point again closes the loop.
 */
export function wallChainParams(
  points: ReadonlyArray<Vec2>,
  closed: boolean,
): { points: Vec2[]; closed: boolean } {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const tolerance = Math.max(diagonal * 1e-3, 1e-9);
  const near = (a: Vec2, b: Vec2): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
  const distinct = points.filter(
    (point, index) => index === 0 || !near(point, points[index - 1] as Vec2),
  );
  const first = distinct[0];
  const last = distinct[distinct.length - 1];
  const returnsToStart =
    distinct.length >= 4 && first !== undefined && last !== undefined && near(first, last);
  return returnsToStart
    ? { points: distinct.slice(0, -1), closed: true }
    : { points: distinct, closed };
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
  const setCollectedPoints = useCallback(
    (next: Vec2[] | ((previous: Vec2[]) => Vec2[])) => {
      setProgress((previous) => {
        const current = previous.tool === activeTool ? previous.points : EMPTY_POINTS;
        return { tool: activeTool, points: typeof next === 'function' ? next(current) : next };
      });
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

  const finishChain = useCallback(() => {
    if (collectedPoints.length >= 2) {
      if (activeTool === 'wall') dispatch('draw_walls', wallChainParams(collectedPoints, false));
      else {
        const points = dropRepeatedPoints(collectedPoints);
        if (points.length >= 2) {
          dispatch(activeTool === 'spline' ? 'draw_spline' : 'draw_polyline', {
            points,
            closed: false,
          });
        }
      }
    }
    setCollectedPoints([]);
  }, [activeTool, collectedPoints, dispatch, setCollectedPoints]);

  const handleClick = useCallback(
    (point: Vec2) => {
      if (activeTool === 'none') return;
      if (activeTool === 'point') {
        dispatch('draw_point', { position: [point[0], point[1], 0] });
        return;
      }
      // Each click appends a vertex; finishChain() (Enter / double-click) commits.
      if (CHAIN_DRAW_TOOLS.has(activeTool)) {
        setCollectedPoints((previous) => [...previous, point]);
        return;
      }
      if (activeTool === 'move' && useStore.getState().document.selection.length === 0) return;

      // Two-click tools: the first click records the anchor, the second one commits the shape.
      const [first] = collectedPoints;
      if (first === undefined) {
        setCollectedPoints([point]);
        return;
      }
      switch (activeTool) {
        case 'move':
          moveSelection([point[0] - first[0], point[1] - first[1], 0]);
          break;
        case 'line':
          dispatch('draw_line', { start: first, end: point });
          break;
        case 'circle': {
          const radius = circleRadiusFromPoints(first, point);
          if (radius !== null) dispatch('draw_circle', { center: first, radius });
          break;
        }
        case 'rectangle': {
          const params = rectParamsFromCorners(first, point);
          if (params !== null) dispatch('draw_rectangle', params);
          break;
        }
        case 'ellipse': {
          const params = ellipseParamsFromCenterCorner(first, point);
          if (params !== null) dispatch('draw_ellipse', params);
          break;
        }
      }
      setCollectedPoints([]);
    },
    [activeTool, collectedPoints, dispatch, setCollectedPoints],
  );

  // Keyboard: Escape cancels; Enter finishes a polyline, wall chain or spline.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditingKeyEvent(e)) return;
      if (e.key === 'Escape') {
        // First Esc drops the shape in progress; a second Esc returns to Select.
        if (activeTool === 'none') return;
        e.preventDefault();
        if (inProgress) setCollectedPoints([]);
        else setActiveTool('none');
      } else if (e.key === 'Enter' && CHAIN_DRAW_TOOLS.has(activeTool)) {
        finishChain();
      }
    };
    // Capture phase: runs before the global shortcut handler, which skips consumed (prevented) keys.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [activeTool, inProgress, finishChain, setActiveTool, setCollectedPoints]);

  // Ctrl/Cmd+Z mid-operation removes the last collected point instead of undoing the document.
  // Capture phase + stopPropagation so the global undo shortcut never sees it.
  useEffect(() => {
    if (!inProgress) return;
    const onUndoKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      const target = e.composedPath()[0];
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      e.preventDefault();
      e.stopPropagation();
      setCollectedPoints((prev) => prev.slice(0, -1));
    };
    window.addEventListener('keydown', onUndoKey, true);
    return () => window.removeEventListener('keydown', onUndoKey, true);
  }, [inProgress, setCollectedPoints]);

  return { activeTool, collectedPoints, setActiveTool, handleClick, finishChain };
}
