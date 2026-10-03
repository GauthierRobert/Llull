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
  rectParamsFromCorners,
  circleRadiusFromPoints,
  ellipseParamsFromCenterCorner,
} from './drawHelpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DrawToolState {
  /** The currently active tool. */
  activeTool: DrawToolKind;
  /** Points collected so far in the current drawing operation. */
  collectedPoints: Vec2[];
}

export interface UseDrawToolResult extends DrawToolState {
  /** Set the active draw tool; resets in-progress state. */
  setActiveTool: (tool: DrawToolKind) => void;
  /**
   * Record a snapped click at world position.
   * Handles the state transitions and dispatch for each tool.
   */
  handleClick: (point: Vec2) => void;
  /** Finish a polyline in progress (double-click or Enter). */
  finishPolyline: (closed?: boolean) => void;
  /** Finish a spline in progress (double-click or Enter). */
  finishSpline: (closed?: boolean) => void;
  /** Cancel the current in-progress shape. The tool stays active. */
  cancel: () => void;
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

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

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

  const cancel = useCallback(() => {
    setCollectedPoints([]);
  }, [setCollectedPoints]);

  const finishPolyline = useCallback(
    (closed = false) => {
      if (collectedPoints.length < 2) {
        setCollectedPoints([]);
        return;
      }
      if (activeTool === 'wall') {
        dispatch('draw_walls', wallChainParams(collectedPoints, closed));
      } else {
        dispatch('draw_polyline', { points: collectedPoints, closed });
      }
      setCollectedPoints([]);
    },
    [activeTool, collectedPoints, dispatch, setCollectedPoints],
  );

  const finishSpline = useCallback(
    (closed = false) => {
      if (collectedPoints.length < 2) {
        setCollectedPoints([]);
        return;
      }
      dispatch('draw_spline', { points: collectedPoints, closed });
      setCollectedPoints([]);
    },
    [collectedPoints, dispatch, setCollectedPoints],
  );

  const handleClick = useCallback(
    (point: Vec2) => {
      switch (activeTool) {
        case 'none':
          break;

        case 'move': {
          if (useStore.getState().document.selection.length === 0) break;
          if (collectedPoints.length === 0) {
            setCollectedPoints([point]);
            break;
          }
          const base = collectedPoints[0]!;
          moveSelection([point[0] - base[0], point[1] - base[1], 0]);
          setCollectedPoints([]);
          break;
        }

        case 'point': {
          dispatch('draw_point', { position: [point[0], point[1], 0] });
          break;
        }

        case 'line': {
          const pts = [...collectedPoints, point];
          if (pts.length === 1) {
            // First click: record start.
            setCollectedPoints(pts);
          } else {
            // Second click: complete the line.
            const [start, end] = pts as [Vec2, Vec2];
            dispatch('draw_line', { start, end });
            setCollectedPoints([]);
          }
          break;
        }

        case 'polyline':
        case 'wall': {
          // Each click appends a vertex; finishPolyline() or Enter commits.
          setCollectedPoints((prev) => [...prev, point]);
          break;
        }

        case 'circle': {
          const pts = [...collectedPoints, point];
          if (pts.length === 1) {
            // First click: record center.
            setCollectedPoints(pts);
          } else {
            // Second click: compute radius and dispatch.
            const center = pts[0]!;
            const rim = pts[1]!;
            const radius = circleRadiusFromPoints(center, rim);
            if (radius !== null) {
              dispatch('draw_circle', { center, radius });
            }
            setCollectedPoints([]);
          }
          break;
        }

        case 'rectangle': {
          const pts = [...collectedPoints, point];
          if (pts.length === 1) {
            // First click: record first corner.
            setCollectedPoints(pts);
          } else {
            // Second click: compute and dispatch.
            const params = rectParamsFromCorners(pts[0]!, pts[1]!);
            if (params !== null) {
              dispatch('draw_rectangle', {
                width: params.width,
                height: params.height,
                position: params.position,
              });
            }
            setCollectedPoints([]);
          }
          break;
        }

        case 'ellipse': {
          const pts = [...collectedPoints, point];
          if (pts.length === 1) {
            // First click: record center.
            setCollectedPoints(pts);
          } else {
            // Second click: compute semi-axes from center + corner and dispatch.
            const params = ellipseParamsFromCenterCorner(pts[0]!, pts[1]!);
            if (params !== null) {
              dispatch('draw_ellipse', {
                center: params.center,
                radiusX: params.radiusX,
                radiusY: params.radiusY,
              });
            }
            setCollectedPoints([]);
          }
          break;
        }

        case 'spline': {
          // Each click appends a vertex; finishSpline() or Enter commits.
          setCollectedPoints((prev) => [...prev, point]);
          break;
        }
      }
    },
    [activeTool, collectedPoints, dispatch, setCollectedPoints],
  );

  // Keyboard: Escape cancels; Enter finishes polyline or spline.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditingKeyEvent(e)) return;
      if (e.key === 'Escape') {
        // First Esc drops the shape in progress; a second Esc returns to Select.
        if (activeTool === 'none') return;
        e.preventDefault();
        if (inProgress) cancel();
        else setActiveTool('none');
      } else if (e.key === 'Enter') {
        if (activeTool === 'polyline' || activeTool === 'wall') finishPolyline(false);
        else if (activeTool === 'spline') finishSpline(false);
      }
    };
    // Capture phase: runs before the global shortcut handler, which skips consumed (prevented) keys.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [activeTool, inProgress, cancel, finishPolyline, finishSpline, setActiveTool]);

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

  return {
    activeTool,
    collectedPoints,
    setActiveTool,
    handleClick,
    finishPolyline,
    finishSpline,
    cancel,
  };
}
