// World-space 2D snap candidates of a document's entities.

import type { CadDocument, Entity, Vec2 } from '@core/model/types';
import { wrapAngle } from '@lib/angle';
import { solidSnaps } from '../solidDrawing';
import type { CollectOpts, SnapPoint, SnapType } from './types';
import { curveCurveIntersections, segmentCurveIntersections, type CircularCurve } from './curveIntersections';
import { allSegmentIntersections } from './segmentSweep';
import {
  entityToSegments,
  isAngleOnArc,
  localToWorld2D,
  mid,
  nearestOnArc,
  nearestOnSegment,
  snapExtension,
  snapPerpendicular,
  snapTangentToCircle,
  type Segment,
} from './geometry';

type World = (lx: number, ly: number) => [number, number];
type EntityOf<K extends Entity['kind']> = Extract<Entity, { kind: K }>;

interface Collector {
  readonly doEndpoints: boolean;
  readonly doMidpoints: boolean;
  readonly doCenters: boolean;
  readonly add: (type: SnapType, x: number, y: number) => void;
  readonly addSegmentSnaps: (segments: ReadonlyArray<Segment>) => void;
  readonly addCurveSnaps: (cx: number, cy: number, r: number, startAngle: number, endAngle: number, full: boolean) => void;
}

function lineSnaps(entity: EntityOf<'line'>, world: World, c: Collector): void {
  const { add } = c;
  const [ax, ay] = world(entity.start[0], entity.start[1]);
  const [bx, by] = world(entity.end[0], entity.end[1]);

  if (c.doEndpoints) {
    add('endpoint', ax, ay);
    add('endpoint', bx, by);
  }
  if (c.doMidpoints) add('midpoint', ...mid(ax, ay, bx, by));
  c.addSegmentSnaps([[ax, ay, bx, by]]);
}

function polylineSnaps(entity: EntityOf<'polyline'>, world: World, c: Collector): void {
  const { add } = c;
  const pts = entity.points;
  pts.forEach((p, i) => {
    const [px, py] = world(p[0], p[1]);

    if (c.doEndpoints) add('endpoint', px, py);
    const q = pts[i + 1];
    if (c.doMidpoints && q) add('midpoint', ...mid(px, py, ...world(q[0], q[1])));
  });
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (entity.closed && c.doMidpoints && pts.length >= 2 && first && last) {
    add('midpoint', ...mid(...world(first[0], first[1]), ...world(last[0], last[1])));
  }
  c.addSegmentSnaps(entityToSegments(entity));
}

function regionSnaps(entity: EntityOf<'region'>, world: World, c: Collector): void {
  const { add } = c;
  // Corners and joints of the exact loops (a tessellated circle snaps at its quadrants, not at every sample); straight edges also at midpoints.
  entity.loops.forEach((loop, index) => {
    const chain = entity.curves?.[index];
    const joints = chain === undefined ? loop : chain.map((segment) => segment.points[0]);
    if (c.doEndpoints) for (const [px, py] of joints) add('endpoint', ...world(px, py));
    const edges =
      chain === undefined
        ? loop.map((p, i) => [p, loop[(i + 1) % loop.length] as Vec2] as const)
        : chain.flatMap((segment) => (segment.type === 'line' ? [[segment.points[0], segment.points[1]] as const] : []));
    if (c.doMidpoints) for (const [a, b] of edges) add('midpoint', ...mid(...world(a[0], a[1]), ...world(b[0], b[1])));
  });
  c.addSegmentSnaps(entityToSegments(entity));
}

function arcSnaps(entity: EntityOf<'arc'>, world: World, c: Collector): void {
  const { add } = c;
  const rotationZ = entity.rotation[2] ?? 0;
  const [cx, cy] = world(entity.center[0], entity.center[1]);
  const { radius: r } = entity;
  const startAngle = entity.startAngle + rotationZ;
  const endAngle = entity.endAngle + rotationZ;
  const onArc = (angle: number): [number, number] => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];

  if (c.doCenters) add('center', cx, cy);
  if (c.doEndpoints) {
    add('endpoint', ...onArc(startAngle));
    add('endpoint', ...onArc(endAngle));
  }
  // Middle of the SWEPT arc, so an arc crossing the 0/2π wrap lands on itself, not the opposite side.
  if (c.doMidpoints) add('midpoint', ...onArc(startAngle + wrapAngle(endAngle - startAngle) / 2));
  c.addCurveSnaps(cx, cy, r, startAngle, endAngle, false);
}

function circleSnaps(entity: EntityOf<'circle'>, world: World, c: Collector): void {
  const { add } = c;
  const [cx, cy] = world(entity.center[0], entity.center[1]);
  const r = entity.radius;

  if (c.doCenters) add('center', cx, cy);
  // Cardinal points in local axes.
  if (c.doEndpoints) {
    add('endpoint', ...world(entity.center[0] + r, entity.center[1]));
    add('endpoint', ...world(entity.center[0] - r, entity.center[1]));
    add('endpoint', ...world(entity.center[0], entity.center[1] + r));
    add('endpoint', ...world(entity.center[0], entity.center[1] - r));
  }
  c.addCurveSnaps(cx, cy, r, 0, 0, true);
}

function rectangleSnaps(entity: EntityOf<'rectangle'>, world: World, c: Collector): void {
  const { add } = c;
  const { width, height } = entity;

  if (c.doEndpoints) {
    add('endpoint', ...world(0, 0));
    add('endpoint', ...world(width, 0));
    add('endpoint', ...world(width, height));
    add('endpoint', ...world(0, height));
  }
  if (c.doMidpoints) {
    add('midpoint', ...world(width / 2, 0));
    add('midpoint', ...world(width, height / 2));
    add('midpoint', ...world(width / 2, height));
    add('midpoint', ...world(0, height / 2));
  }
  if (c.doCenters) add('center', ...world(width / 2, height / 2));
  c.addSegmentSnaps(entityToSegments(entity));
}

function ellipseSnaps(entity: EntityOf<'ellipse'>, world: World, c: Collector): void {
  const { add } = c;
  const [lx, ly] = entity.center;
  const { radiusX, radiusY } = entity;

  if (c.doCenters) add('center', ...world(lx, ly));
  if (c.doEndpoints) {
    add('endpoint', ...world(lx + radiusX, ly));
    add('endpoint', ...world(lx - radiusX, ly));
    add('endpoint', ...world(lx, ly + radiusY));
    add('endpoint', ...world(lx, ly - radiusY));
  }
}

function entitySnaps(
  entity: Entity,
  document: Pick<CadDocument, 'entities' | 'order' | 'components'>,
  opts: CollectOpts,
  c: Collector,
  candidates: SnapPoint[],
): void {
  const world: World = (lx, ly) => localToWorld2D(entity, lx, ly);

  switch (entity.kind) {
    case 'line':
      lineSnaps(entity, world, c);
      break;
    case 'polyline':
      polylineSnaps(entity, world, c);
      break;
    case 'region':
      regionSnaps(entity, world, c);
      break;
    case 'arc':
      arcSnaps(entity, world, c);
      break;
    case 'circle':
      circleSnaps(entity, world, c);
      break;
    case 'rectangle':
      rectangleSnaps(entity, world, c);
      break;
    case 'ellipse':
      ellipseSnaps(entity, world, c);
      break;
    case 'spline': {
      if (c.doEndpoints) for (const p of entity.points) c.add('endpoint', ...world(p[0], p[1]));
      break;
    }
    case 'point': {
      if (c.doEndpoints) c.add('endpoint', ...world(0, 0));
      break;
    }

    // Text and dimensions have no snap geometry; 3D solids snap to their top-view outline.
    default:
      if (!(c.doEndpoints || c.doMidpoints || c.doCenters)) break;
      for (const snap of solidSnaps(document, entity, opts.cutDepth)) {
        const wanted = snap.type === 'endpoint' ? c.doEndpoints : snap.type === 'midpoint' ? c.doMidpoints : c.doCenters;
        if (wanted) candidates.push(snap);
      }
      break;
  }
}

function addIntersections(
  allSegments: ReadonlyArray<Segment>,
  allCurves: ReadonlyArray<CircularCurve>,
  add: (type: SnapType, x: number, y: number) => void,
): void {
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

/** Perpendicular / tangent need `fromPoint` (the last placed point); extension / nearest need `cursor`. */
export function collectSnapCandidates(
  document: Pick<CadDocument, 'entities' | 'order' | 'components'>,
  opts: CollectOpts = {},
  fromPoint?: Vec2 | null,
  cursorPoint?: Vec2 | null,
): SnapPoint[] {
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

  const allSegments: Segment[] = [];
  const allCurves: CircularCurve[] = [];

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

  /** Arcs (full = false) and circles. */
  const addCurveSnaps = (cx: number, cy: number, r: number, startAngle: number, endAngle: number, full: boolean): void => {
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

  const collector: Collector = {
    doEndpoints: opts.endpoints !== false,
    doMidpoints: opts.midpoints !== false,
    doCenters: opts.centers !== false,
    add,
    addSegmentSnaps,
    addCurveSnaps,
  };

  for (const id of document.order) {
    const entity = document.entities[id];
    if (!entity || !isVisible(entity)) continue;
    entitySnaps(entity, document, opts, collector, candidates);
  }

  if (opts.intersections !== false) addIntersections(allSegments, allCurves, add);

  return candidates;
}
