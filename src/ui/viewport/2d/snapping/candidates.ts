/**
 * @layer ui/viewport/2d
 *
 * Derive snap candidate points from the 2D entities of a document.
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { is2D } from '@core/model/types';
import type { CollectOpts, SnapPoint, SnapType } from './types';
import {
  entityToSegments,
  isAngleOnArc,
  mid,
  nearestOnArc,
  nearestOnSegment,
  normalizeAngle,
  segmentIntersection,
  snapExtension,
  snapPerpendicular,
  snapTangentToCircle,
  type Segment,
} from './geometry';

/**
 * Derive all snap candidate points from the 2D entities in a document.
 * Returns world-space 2D snap points (entity position offset applied).
 *
 * Advanced snaps (perpendicular, tangent, extension, nearest) require a
 * `fromPoint` — the last placed point in an ongoing draw operation.
 *
 * @pure deterministic, no side effects
 */
export function collectSnapCandidates(
  document: Pick<CadDocument, 'entities' | 'order'>,
  opts: CollectOpts = {},
  fromPoint?: Vec2 | null,
  cursorPoint?: Vec2 | null,
): SnapPoint[] {
  const doEndpoints = opts.endpoints !== false;
  const doMidpoints = opts.midpoints !== false;
  const doCenters = opts.centers !== false;
  const doIntersections = opts.intersections !== false;
  const doPerpendiculars = opts.perpendiculars !== false;
  const doTangents = opts.tangents !== false;
  const doExtensions = opts.extensions === true;
  const doNearest = opts.nearest === true;
  const isVisible = opts.isVisible ?? (() => true);

  const from = fromPoint ?? null;
  const cursor = cursorPoint ?? null;

  const candidates: SnapPoint[] = [];
  const add = (type: SnapType, x: number, y: number): void => {
    candidates.push({ x, y, type });
  };

  // Collect all line segments first (needed for intersection computation).
  const allSegments: Segment[] = [];

  /** Perpendicular / extension / nearest snaps for each segment, then register it for intersections. */
  const addSegmentSnaps = (segments: ReadonlyArray<Segment>): void => {
    for (const [ax, ay, bx, by] of segments) {
      if (doPerpendiculars) {
        const snap = snapPerpendicular(from, ax, ay, bx, by);
        if (snap) candidates.push(snap);
      }
      if (doExtensions && cursor !== null) {
        const snap = snapExtension(cursor[0], cursor[1], ax, ay, bx, by);
        if (snap) candidates.push(snap);
      }
      if (doNearest && cursor !== null) {
        add('nearest', ...nearestOnSegment(cursor[0], cursor[1], ax, ay, bx, by));
      }
    }
    allSegments.push(...segments);
  };

  /** Tangent + nearest snaps shared by arcs (full = false) and circles (full = true). */
  const addCurveSnaps = (
    cx: number,
    cy: number,
    r: number,
    startAngle: number,
    endAngle: number,
    full: boolean,
  ): void => {
    if (doTangents) {
      for (const snap of snapTangentToCircle(from, cx, cy, r)) {
        if (full || isAngleOnArc(Math.atan2(snap.y - cy, snap.x - cx), startAngle, endAngle)) {
          candidates.push(snap);
        }
      }
    }
    if (doNearest && cursor !== null) {
      add('nearest', ...nearestOnArc(cursor[0], cursor[1], cx, cy, r, startAngle, endAngle, full));
    }
  };

  for (const id of document.order) {
    const entity = document.entities[id];
    if (!entity || !is2D(entity) || !isVisible(entity)) continue;

    const ox = entity.position[0];
    const oy = entity.position[1];

    switch (entity.kind) {
      case 'line': {
        const ax = entity.start[0] + ox;
        const ay = entity.start[1] + oy;
        const bx = entity.end[0] + ox;
        const by = entity.end[1] + oy;

        if (doEndpoints) {
          add('endpoint', ax, ay);
          add('endpoint', bx, by);
        }
        if (doMidpoints) add('midpoint', ...mid(ax, ay, bx, by));
        addSegmentSnaps([[ax, ay, bx, by]]);
        break;
      }

      case 'polyline': {
        const pts = entity.points;
        pts.forEach((p, i) => {
          const px = p[0] + ox;
          const py = p[1] + oy;

          if (doEndpoints) add('endpoint', px, py);
          const q = pts[i + 1];
          if (doMidpoints && q) add('midpoint', ...mid(px, py, q[0] + ox, q[1] + oy));
        });
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (entity.closed && doMidpoints && pts.length >= 2 && first && last) {
          add('midpoint', ...mid(first[0] + ox, first[1] + oy, last[0] + ox, last[1] + oy));
        }
        addSegmentSnaps(entityToSegments(entity));
        break;
      }

      case 'arc': {
        const cx = entity.center[0] + ox;
        const cy = entity.center[1] + oy;
        const { radius: r, startAngle, endAngle } = entity;
        const onArc = (angle: number): [number, number] => [
          cx + r * Math.cos(angle),
          cy + r * Math.sin(angle),
        ];

        if (doCenters) add('center', cx, cy);
        if (doEndpoints) {
          add('endpoint', ...onArc(startAngle));
          add('endpoint', ...onArc(endAngle));
        }
        // Midpoint along the SWEPT arc (direction-respecting), so an arc that crosses the 0/2π
        // wrap still lands on the arc itself rather than the opposite side.
        if (doMidpoints)
          add('midpoint', ...onArc(startAngle + normalizeAngle(endAngle - startAngle) / 2));
        addCurveSnaps(cx, cy, r, startAngle, endAngle, false);
        break;
      }

      case 'circle': {
        const cx = entity.center[0] + ox;
        const cy = entity.center[1] + oy;
        const r = entity.radius;

        if (doCenters) add('center', cx, cy);
        // Cardinal points as endpoints (useful snaps for circles).
        if (doEndpoints) {
          add('endpoint', cx + r, cy);
          add('endpoint', cx - r, cy);
          add('endpoint', cx, cy + r);
          add('endpoint', cx, cy - r);
        }
        addCurveSnaps(cx, cy, r, 0, 0, true);
        break;
      }

      case 'rectangle': {
        const x0 = ox;
        const y0 = oy;
        const x1 = ox + entity.width;
        const y1 = oy + entity.height;

        if (doEndpoints) {
          add('endpoint', x0, y0);
          add('endpoint', x1, y0);
          add('endpoint', x1, y1);
          add('endpoint', x0, y1);
        }
        if (doMidpoints) {
          add('midpoint', (x0 + x1) / 2, y0);
          add('midpoint', x1, (y0 + y1) / 2);
          add('midpoint', (x0 + x1) / 2, y1);
          add('midpoint', x0, (y0 + y1) / 2);
        }
        if (doCenters) add('center', (x0 + x1) / 2, (y0 + y1) / 2);
        addSegmentSnaps(entityToSegments(entity));
        break;
      }

      case 'ellipse': {
        const cx = entity.center[0] + ox;
        const cy = entity.center[1] + oy;
        const { radiusX, radiusY } = entity;

        if (doCenters) add('center', cx, cy);
        if (doEndpoints) {
          add('endpoint', cx + radiusX, cy);
          add('endpoint', cx - radiusX, cy);
          add('endpoint', cx, cy + radiusY);
          add('endpoint', cx, cy - radiusY);
        }
        break;
      }

      case 'spline': {
        if (doEndpoints) for (const p of entity.points) add('endpoint', p[0] + ox, p[1] + oy);
        break;
      }

      case 'point': {
        if (doEndpoints) add('endpoint', ox, oy);
        break;
      }

      // 3D solids have no 2D snap geometry — already filtered by is2D above.
      default:
        break;
    }
  }

  // Segment × segment intersections.
  if (doIntersections) {
    for (let i = 0; i < allSegments.length; i++) {
      for (let j = i + 1; j < allSegments.length; j++) {
        const a = allSegments[i];
        const b = allSegments[j];
        const pt = a && b ? segmentIntersection(...a, ...b) : null;
        if (pt) add('intersection', ...pt);
      }
    }
  }

  return candidates;
}
