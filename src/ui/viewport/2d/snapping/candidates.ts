/**
 * @layer ui/viewport/2d
 *
 * Derive snap candidate points from the 2D entities of a document.
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { is2D } from '@core/model/types';
import type { CollectOpts, SnapPoint, SnapType } from './types';
import {
  curveCurveIntersections,
  segmentCurveIntersections,
  type CircularCurve,
} from './curveIntersections';
import { allSegmentIntersections } from './segmentSweep';
import {
  entityToSegments,
  isAngleOnArc,
  localToWorld2D,
  mid,
  nearestOnArc,
  nearestOnSegment,
  normalizeAngle,
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
  const allCurves: CircularCurve[] = [];

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
    allCurves.push({ cx, cy, r, startAngle, endAngle, full });
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

    // Entity-local -> world XY (rotation about Z, then position).
    const world = (lx: number, ly: number): [number, number] => localToWorld2D(entity, lx, ly);
    const rotationZ = entity.rotation[2] ?? 0;

    switch (entity.kind) {
      case 'line': {
        const [ax, ay] = world(entity.start[0], entity.start[1]);
        const [bx, by] = world(entity.end[0], entity.end[1]);

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
          const [px, py] = world(p[0], p[1]);

          if (doEndpoints) add('endpoint', px, py);
          const q = pts[i + 1];
          if (doMidpoints && q) add('midpoint', ...mid(px, py, ...world(q[0], q[1])));
        });
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (entity.closed && doMidpoints && pts.length >= 2 && first && last) {
          add('midpoint', ...mid(...world(first[0], first[1]), ...world(last[0], last[1])));
        }
        addSegmentSnaps(entityToSegments(entity));
        break;
      }

      case 'arc': {
        const [cx, cy] = world(entity.center[0], entity.center[1]);
        const { radius: r } = entity;
        const startAngle = entity.startAngle + rotationZ;
        const endAngle = entity.endAngle + rotationZ;
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
        const [cx, cy] = world(entity.center[0], entity.center[1]);
        const r = entity.radius;

        if (doCenters) add('center', cx, cy);
        // Cardinal points (in the entity's local axes) as endpoints.
        if (doEndpoints) {
          add('endpoint', ...world(entity.center[0] + r, entity.center[1]));
          add('endpoint', ...world(entity.center[0] - r, entity.center[1]));
          add('endpoint', ...world(entity.center[0], entity.center[1] + r));
          add('endpoint', ...world(entity.center[0], entity.center[1] - r));
        }
        addCurveSnaps(cx, cy, r, 0, 0, true);
        break;
      }

      case 'rectangle': {
        const { width, height } = entity;

        if (doEndpoints) {
          add('endpoint', ...world(0, 0));
          add('endpoint', ...world(width, 0));
          add('endpoint', ...world(width, height));
          add('endpoint', ...world(0, height));
        }
        if (doMidpoints) {
          add('midpoint', ...world(width / 2, 0));
          add('midpoint', ...world(width, height / 2));
          add('midpoint', ...world(width / 2, height));
          add('midpoint', ...world(0, height / 2));
        }
        if (doCenters) add('center', ...world(width / 2, height / 2));
        addSegmentSnaps(entityToSegments(entity));
        break;
      }

      case 'ellipse': {
        const [lx, ly] = entity.center;
        const { radiusX, radiusY } = entity;

        if (doCenters) add('center', ...world(lx, ly));
        if (doEndpoints) {
          add('endpoint', ...world(lx + radiusX, ly));
          add('endpoint', ...world(lx - radiusX, ly));
          add('endpoint', ...world(lx, ly + radiusY));
          add('endpoint', ...world(lx, ly - radiusY));
        }
        break;
      }

      case 'spline': {
        if (doEndpoints) for (const p of entity.points) add('endpoint', ...world(p[0], p[1]));
        break;
      }

      case 'point': {
        if (doEndpoints) add('endpoint', ...world(0, 0));
        break;
      }

      // 3D solids have no 2D snap geometry — already filtered by is2D above.
      default:
        break;
    }
  }

  // Segment × segment intersections.
  if (doIntersections) {
    for (const pt of allSegmentIntersections(allSegments)) add('intersection', ...pt);
    for (const [i, curve] of allCurves.entries()) {
      for (const segment of allSegments) {
        for (const pt of segmentCurveIntersections(segment, curve)) add('intersection', ...pt);
      }
      for (const other of allCurves.slice(i + 1)) {
        for (const pt of curveCurveIntersections(curve, other)) add('intersection', ...pt);
      }
    }
  }

  return candidates;
}
