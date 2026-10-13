// ONE descriptor per draw tool (clicks to complete, command dispatched, preview), read by useDrawTool, DrawPreview and
// DrawInteraction. A new tool = one descriptor here + its toolbar spec in drawTools.ts. Params come from clicks only.

import type { Vec2 } from '@core/model/types';
import type { DrawToolKind } from '@ui/store';
import { moveSelection } from '@ui/actions/selectionActions';
import { ellipseOutline, loopSegments } from '../lineGeometry';
import {
  chainTolerance,
  circleRadiusFromPoints,
  dropRepeatedPoints,
  ellipseParamsFromCenterCorner,
  rectParamsFromCorners,
} from './drawHelpers';

const OUTLINE_SEGMENTS = 32;

type Dispatch = (name: string, params?: unknown) => void;

/** Rubber band from the single placed point to the cursor; null while degenerate. */
type AnchoredOutline = (anchor: Vec2, cursor: Vec2) => Vec2[] | null;

interface DrawToolDescriptor {
  /** Clicks that complete the tool; null = open chain finished by Enter / double-click. */
  maxPoints: number | null;
  /** The move tool needs something selected before its first click is accepted. */
  requiresSelection?: true;
  /** Degenerate input dispatches nothing. */
  commit: (points: ReadonlyArray<Vec2>, dispatch: Dispatch) => void;
  /** 'chain' = straight segments through every placed point; else an outline from one anchor. */
  preview: 'chain' | AnchoredOutline;
}

/** Near-duplicate clicks (double-click finish) merge; re-clicking the first point closes the loop. */
export function wallChainParams(points: ReadonlyArray<Vec2>, closed: boolean): { points: Vec2[]; closed: boolean } {
  const distinct = dropRepeatedPoints(points);
  const first = distinct[0];
  const last = distinct[distinct.length - 1];
  const returnsToStart =
    distinct.length >= 4 &&
    first !== undefined &&
    last !== undefined &&
    Math.hypot(first[0] - last[0], first[1] - last[1]) <= chainTolerance(points);
  return returnsToStart ? { points: distinct.slice(0, -1), closed: true } : { points: distinct, closed };
}

const segment: AnchoredOutline = (anchor, cursor) => [anchor, cursor];

/** An open chain whose distinct points (>= 2) dispatch `command`. */
function openChain(command: string): DrawToolDescriptor {
  return {
    maxPoints: null,
    preview: 'chain',
    commit: (points, dispatch) => {
      const distinct = dropRepeatedPoints(points);
      if (distinct.length >= 2) dispatch(command, { points: distinct, closed: false });
    },
  };
}

const polyline = openChain('draw_polyline');

const DESCRIPTORS: Partial<Record<DrawToolKind, DrawToolDescriptor>> = {
  polyline,
  // A line is a two-point polyline.
  line: {
    ...polyline,
    maxPoints: 2,
    preview: segment,
    commit: ([first, second], dispatch) => {
      if (first && second) dispatch('draw_polyline', { points: [first, second] });
    },
  },
  spline: openChain('draw_spline'),
  wall: { maxPoints: null, preview: 'chain', commit: (points, dispatch) => dispatch('draw_walls', wallChainParams(points, false)) },
  point: {
    maxPoints: 1,
    preview: () => null,
    commit: ([at], dispatch) => {
      if (at) dispatch('draw_point', { position: [at[0], at[1], 0] });
    },
  },
  move: {
    maxPoints: 2,
    requiresSelection: true,
    preview: segment,
    commit: ([from, to]) => {
      if (from && to) moveSelection([to[0] - from[0], to[1] - from[1], 0]);
    },
  },
  circle: {
    maxPoints: 2,
    commit: ([center, rim], dispatch) => {
      if (!center || !rim) return;
      const radius = circleRadiusFromPoints(center, rim);
      if (radius !== null) dispatch('draw_arc', { center, radius });
    },
    preview: (center, rim) => {
      const radius = circleRadiusFromPoints(center, rim);
      return radius === null ? null : ellipseOutline(center[0], center[1], radius, radius, OUTLINE_SEGMENTS);
    },
  },
  rectangle: {
    maxPoints: 2,
    commit: ([a, b], dispatch) => {
      const params = a && b ? rectParamsFromCorners(a, b) : null;
      if (params !== null) dispatch('draw_rectangle', params);
    },
    preview: (a, b) => {
      if (rectParamsFromCorners(a, b) === null) return null;
      const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
      const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
      return loopSegments([
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ]);
    },
  },
  ellipse: {
    maxPoints: 2,
    commit: ([center, corner], dispatch) => {
      const params = center && corner ? ellipseParamsFromCenterCorner(center, corner) : null;
      if (params !== null) dispatch('draw_ellipse', params);
    },
    preview: (center, corner) => {
      const ellipse = ellipseParamsFromCenterCorner(center, corner);
      return ellipse === null
        ? null
        : ellipseOutline(ellipse.center[0], ellipse.center[1], ellipse.radiusX, ellipse.radiusY, OUTLINE_SEGMENTS);
    },
  },
};

export function drawToolDescriptor(tool: DrawToolKind): DrawToolDescriptor | undefined {
  return DESCRIPTORS[tool];
}

/** Tools that collect any number of vertices until finished (Enter / double-click). */
export function isChainTool(tool: DrawToolKind): boolean {
  return DESCRIPTORS[tool]?.maxPoints === null;
}
