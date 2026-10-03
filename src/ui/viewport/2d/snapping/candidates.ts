/**
 * @layer ui/viewport/2d
 *
 * Derive snap candidate points from the 2D entities of a document.
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { is2D } from '@core/model/types';
import type { CollectOpts, SnapPoint } from './types';
import {
  entityToSegments,
  mid,
  nearestOnArc,
  nearestOnSegment,
  segmentIntersection,
  snapExtension,
  snapPerpendicular,
  snapTangentToCircle,
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
  document: CadDocument,
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

  const from = fromPoint ?? null;
  const cursor = cursorPoint ?? null;

  const candidates: SnapPoint[] = [];

  // Collect all line segments first (needed for intersection computation).
  const allSegments: Array<[number, number, number, number]> = [];

  /** Perpendicular / extension / nearest snaps for each segment, then register it for intersections. */
  const addSegmentSnaps = (segments: ReadonlyArray<[number, number, number, number]>): void => {
    for (const seg of segments) {
      if (doPerpendiculars) {
        const snap = snapPerpendicular(from, seg[0], seg[1], seg[2], seg[3]);
        if (snap) candidates.push(snap);
      }
      if (doExtensions && cursor !== null) {
        const snap = snapExtension(cursor[0], cursor[1], seg[0], seg[1], seg[2], seg[3]);
        if (snap) candidates.push(snap);
      }
      if (doNearest && cursor !== null) {
        const [nx, ny] = nearestOnSegment(cursor[0], cursor[1], seg[0], seg[1], seg[2], seg[3]);
        candidates.push({ x: nx, y: ny, type: 'nearest' });
      }
    }
    allSegments.push(...segments);
  };

  for (const id of document.order) {
    const entity = document.entities[id];
    if (!entity || !is2D(entity)) continue;

    const ox = entity.position[0];
    const oy = entity.position[1];

    switch (entity.kind) {
      case 'line': {
        const ax = entity.start[0] + ox;
        const ay = entity.start[1] + oy;
        const bx = entity.end[0] + ox;
        const by = entity.end[1] + oy;

        if (doEndpoints) {
          candidates.push({ x: ax, y: ay, type: 'endpoint' });
          candidates.push({ x: bx, y: by, type: 'endpoint' });
        }
        if (doMidpoints) {
          const [mx, my] = mid(ax, ay, bx, by);
          candidates.push({ x: mx, y: my, type: 'midpoint' });
        }
        addSegmentSnaps([[ax, ay, bx, by]]);
        break;
      }

      case 'polyline': {
        const pts = entity.points;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i]!;
          const px = p[0] + ox;
          const py = p[1] + oy;

          if (doEndpoints) {
            candidates.push({ x: px, y: py, type: 'endpoint' });
          }
          if (doMidpoints && i < pts.length - 1) {
            const q = pts[i + 1]!;
            const [mx, my] = mid(px, py, q[0] + ox, q[1] + oy);
            candidates.push({ x: mx, y: my, type: 'midpoint' });
          }
        }
        if (entity.closed && doMidpoints && pts.length >= 2) {
          const first = pts[0]!;
          const last = pts[pts.length - 1]!;
          const [mx, my] = mid(first[0] + ox, first[1] + oy, last[0] + ox, last[1] + oy);
          candidates.push({ x: mx, y: my, type: 'midpoint' });
        }
        const segs = entityToSegments(entity);
        addSegmentSnaps(segs);
        break;
      }

      case 'arc': {
        const cx = entity.center[0] + ox;
        const cy = entity.center[1] + oy;
        const r = entity.radius;

        if (doCenters) {
          candidates.push({ x: cx, y: cy, type: 'center' });
        }
        if (doEndpoints) {
          candidates.push({
            x: cx + r * Math.cos(entity.startAngle),
            y: cy + r * Math.sin(entity.startAngle),
            type: 'endpoint',
          });
          candidates.push({
            x: cx + r * Math.cos(entity.endAngle),
            y: cy + r * Math.sin(entity.endAngle),
            type: 'endpoint',
          });
        }
        if (doMidpoints) {
          // Midpoint along the SWEPT arc (direction-respecting), so an arc that
          // crosses the 0/2π wrap still lands on the arc itself rather than the
          // opposite side. sweep is normalized to [0, 2π).
          const sweep =
            (((entity.endAngle - entity.startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          const midAngle = entity.startAngle + sweep / 2;
          candidates.push({
            x: cx + r * Math.cos(midAngle),
            y: cy + r * Math.sin(midAngle),
            type: 'midpoint',
          });
        }
        if (doTangents) {
          const snaps = snapTangentToCircle(from, cx, cy, r);
          candidates.push(...snaps);
        }
        if (doNearest && cursor !== null) {
          const [nx, ny] = nearestOnArc(
            cursor[0],
            cursor[1],
            cx,
            cy,
            r,
            entity.startAngle,
            entity.endAngle,
            false,
          );
          candidates.push({ x: nx, y: ny, type: 'nearest' });
        }
        break;
      }

      case 'circle': {
        const cx = entity.center[0] + ox;
        const cy = entity.center[1] + oy;
        const r = entity.radius;

        if (doCenters) {
          candidates.push({ x: cx, y: cy, type: 'center' });
        }
        // Cardinal points as endpoints (useful snaps for circles).
        if (doEndpoints) {
          candidates.push({ x: cx + r, y: cy, type: 'endpoint' });
          candidates.push({ x: cx - r, y: cy, type: 'endpoint' });
          candidates.push({ x: cx, y: cy + r, type: 'endpoint' });
          candidates.push({ x: cx, y: cy - r, type: 'endpoint' });
        }
        if (doTangents) {
          const snaps = snapTangentToCircle(from, cx, cy, r);
          candidates.push(...snaps);
        }
        if (doNearest && cursor !== null) {
          const [nx, ny] = nearestOnArc(cursor[0], cursor[1], cx, cy, r, 0, 0, true);
          candidates.push({ x: nx, y: ny, type: 'nearest' });
        }
        break;
      }

      case 'rectangle': {
        const x0 = ox;
        const y0 = oy;
        const x1 = ox + entity.width;
        const y1 = oy + entity.height;

        if (doEndpoints) {
          candidates.push({ x: x0, y: y0, type: 'endpoint' });
          candidates.push({ x: x1, y: y0, type: 'endpoint' });
          candidates.push({ x: x1, y: y1, type: 'endpoint' });
          candidates.push({ x: x0, y: y1, type: 'endpoint' });
        }
        if (doMidpoints) {
          candidates.push({ x: (x0 + x1) / 2, y: y0, type: 'midpoint' });
          candidates.push({ x: x1, y: (y0 + y1) / 2, type: 'midpoint' });
          candidates.push({ x: (x0 + x1) / 2, y: y1, type: 'midpoint' });
          candidates.push({ x: x0, y: (y0 + y1) / 2, type: 'midpoint' });
        }
        if (doCenters) {
          candidates.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, type: 'center' });
        }
        const rectSegs = entityToSegments(entity);
        addSegmentSnaps(rectSegs);
        break;
      }

      case 'point': {
        if (doEndpoints) {
          candidates.push({ x: ox, y: oy, type: 'endpoint' });
        }
        break;
      }

      // 3D solids have no 2D snap geometry — already filtered by is2D above.
      default:
        break;
    }
  }

  // Segment × segment intersections.
  if (doIntersections && allSegments.length >= 2) {
    for (let i = 0; i < allSegments.length; i++) {
      for (let j = i + 1; j < allSegments.length; j++) {
        const a = allSegments[i]!;
        const b = allSegments[j]!;
        const pt = segmentIntersection(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]);
        if (pt) {
          candidates.push({ x: pt[0], y: pt[1], type: 'intersection' });
        }
      }
    }
  }

  return candidates;
}
