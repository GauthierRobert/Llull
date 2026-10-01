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
 * - Esc cancels the current in-progress shape; the tool stays active.
 * - The hook is purely React state + callbacks — no three.js here.
 */

import { useState, useCallback, useEffect } from 'react';
import type { Vec2 } from '@core/model/types';
import { useStore } from '@ui/store';
import {
  rectParamsFromCorners,
  circleRadiusFromPoints,
  ellipseParamsFromCenterCorner,
} from './drawHelpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DrawToolKind =
  | 'none'
  | 'line'
  | 'polyline'
  | 'wall'
  | 'circle'
  | 'rectangle'
  | 'point'
  | 'ellipse'
  | 'spline';

export interface DrawToolState {
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
 * Wall-chain params: clicking the first point again closes the loop (the repeated
 * vertex is dropped and `closed` is set).
 */
export function wallChainParams(
  points: ReadonlyArray<Vec2>,
  closed: boolean,
): { points: Vec2[]; closed: boolean } {
  const first = points[0];
  const last = points[points.length - 1];
  const returnsToStart =
    points.length >= 4 &&
    first !== undefined &&
    last !== undefined &&
    Math.hypot(last[0] - first[0], last[1] - first[1]) < 1e-9;
  return returnsToStart
    ? { points: points.slice(0, -1), closed: true }
    : { points: [...points], closed };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDrawTool(): UseDrawToolResult {
  const dispatch = useStore((s) => s.dispatch);
  const [activeTool, setActiveToolState] = useState<DrawToolKind>('none');
  const [collectedPoints, setCollectedPoints] = useState<Vec2[]>([]);

  // Reset collected points whenever the tool changes.
  const setActiveTool = useCallback((tool: DrawToolKind) => {
    setActiveToolState(tool);
    setCollectedPoints([]);
  }, []);

  const cancel = useCallback(() => {
    setCollectedPoints([]);
  }, []);

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
    [activeTool, collectedPoints, dispatch],
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
    [collectedPoints, dispatch],
  );

  const handleClick = useCallback(
    (point: Vec2) => {
      switch (activeTool) {
        case 'none':
          break;

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
    [activeTool, collectedPoints, dispatch],
  );

  // Keyboard: Escape cancels; Enter finishes polyline or spline.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        cancel();
      } else if (e.key === 'Enter') {
        if (activeTool === 'polyline' || activeTool === 'wall') finishPolyline(false);
        else if (activeTool === 'spline') finishSpline(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTool, cancel, finishPolyline, finishSpline]);

  // Ctrl/Cmd+Z mid-operation removes the last collected point instead of undoing the document.
  // Capture phase + stopPropagation so the global undo shortcut never sees it.
  const hasCollectedPoints = collectedPoints.length > 0;
  useEffect(() => {
    if (!hasCollectedPoints) return;
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
  }, [hasCollectedPoints]);

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
