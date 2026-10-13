/**
 * @layer ui/viewport/2d
 *
 * Vertex buffers of technical-drawing primitives (`@core/model/drawing`) by ISO 128 line weight:
 * thick continuous (cut, visible), thin continuous (thin, annotation, hatching, dimensions, chain
 * centre lines pre-split into long dash + dot) and thin dashed (hidden); solid poché fills and
 * text labels. Shared by every 2D technical drawing — the building plan and the solids' views.
 */

import * as THREE from 'three';
import type { Vec2 } from '@core/model/types';
import { type DrawingPrimitive, LINE_PATTERNS } from '@core/model/drawing';
import { ansi31Hatch } from '@lib/hatch';
import { positiveSweep } from '@lib/angle';
import { sampleArc } from '@lib/arc';

const ARC_SEGMENTS = 32;

/** A primitive with the colour it is stroked in. */
export interface StyledPrimitive {
  readonly primitive: DrawingPrimitive;
  readonly color: string;
}

export interface DrawingLabel {
  readonly key: string;
  readonly at: Vec2;
  readonly height: number;
  readonly content: string;
  readonly color: string;
  readonly rotation: number;
  /** Dimension values keep a minimum on-screen size when zoomed out. */
  readonly dimension: boolean;
}

/** Flat xyz positions + rgb colours of independent segments, relative to an anchor. */
export class SegmentBuffer {
  readonly positions: number[] = [];
  readonly colors: number[] = [];

  constructor(private readonly anchor: Vec2) {}

  add(a: Vec2, b: Vec2, color: THREE.Color): void {
    const [ax, ay] = this.anchor;
    this.positions.push(a[0] - ax, a[1] - ay, 0, b[0] - ax, b[1] - ay, 0);
    this.colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  }

  ring(points: ReadonlyArray<Vec2>, closed: boolean, color: THREE.Color): void {
    const count = closed ? points.length : points.length - 1;
    for (let index = 0; index < count; index++) {
      this.add(points[index] as Vec2, points[(index + 1) % points.length] as Vec2, color);
    }
  }
}

export interface DrawingBuffers {
  readonly thick: SegmentBuffer;
  readonly thin: SegmentBuffer;
  readonly dashed: SegmentBuffer;
  /** Solid poché regions (outer ring + holes), relative to the anchor. */
  readonly fills: Array<{ readonly outer: Vec2[]; readonly holes: Vec2[][] }>;
  readonly labels: DrawingLabel[];
}

export interface DrawingScale {
  /** Unit of the ISO line patterns (`LINE_PATTERNS`), model units. */
  readonly patternUnit: number;
  /** Distance between hatch lines, model units. */
  readonly hatchSpacing: number;
}

/** `ARC_SEGMENTS + 1` points from `start` CCW to `end`, both ends included. */
function arcPoints(center: Vec2, radius: number, start: number, end: number): Vec2[] {
  const first: Vec2 = [center[0] + radius * Math.cos(start), center[1] + radius * Math.sin(start)];
  return [first, ...sampleArc(center, radius, start, positiveSweep(end - start), ARC_SEGMENTS)];
}

/** Chain line along `points` (ISO 128 type 04: long dash, gap, dot, gap), one pattern for the whole run. */
function chainRing(
  buffer: SegmentBuffer,
  points: ReadonlyArray<Vec2>,
  closed: boolean,
  unit: number,
  color: THREE.Color,
): void {
  const count = closed ? points.length : points.length - 1;
  const pattern = LINE_PATTERNS.center.map((length) => length * unit);
  let phase = 0;
  let drawn = 0;
  for (let index = 0; index < count; index++) {
    const a = points[index] as Vec2;
    const b = points[(index + 1) % points.length] as Vec2;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let s = 0;
    while (s < length) {
      const left = (pattern[phase] as number) - drawn;
      const end = Math.min(length, s + left);
      if (phase % 2 === 0) {
        const lerp = (t: number): Vec2 => [
          a[0] + ((b[0] - a[0]) * t) / length,
          a[1] + ((b[1] - a[1]) * t) / length,
        ];
        buffer.add(lerp(s), lerp(end), color);
      }
      drawn += end - s;
      s = end;
      if (drawn >= (pattern[phase] as number) - 1e-12) {
        phase = (phase + 1) % pattern.length;
        drawn = 0;
      }
    }
  }
}

function addDimension(
  primitive: Extract<DrawingPrimitive, { type: 'dimension' }>,
  buffer: SegmentBuffer,
  labels: DrawingLabel[],
  key: string,
  color: string,
  anchor: Vec2,
): void {
  const stroke = new THREE.Color(color);
  const dx = primitive.b[0] - primitive.a[0];
  const dy = primitive.b[1] - primitive.a[1];
  const length = Math.hypot(dx, dy) || 1;
  const normal: Vec2 = [dy / length, -dx / length];
  const shift = (point: Vec2, distance: number): Vec2 => [
    point[0] + normal[0] * distance,
    point[1] + normal[1] * distance,
  ];
  const a = shift(primitive.a, primitive.offset);
  const b = shift(primitive.b, primitive.offset);
  buffer.add(
    shift(primitive.a, primitive.offset * 0.15),
    shift(primitive.a, primitive.offset * 1.1),
    stroke,
  );
  buffer.add(
    shift(primitive.b, primitive.offset * 0.15),
    shift(primitive.b, primitive.offset * 1.1),
    stroke,
  );
  buffer.add(a, b, stroke);
  const tick = primitive.offset * 0.12;
  for (const end of [a, b])
    buffer.add([end[0] - tick, end[1] - tick], [end[0] + tick, end[1] + tick], stroke);
  let angle = Math.atan2(dy, dx);
  if (angle > Math.PI / 2 + 1e-9 || angle <= -Math.PI / 2 + 1e-9) angle += Math.PI;
  const lift = primitive.offset * 0.22;
  labels.push({
    key,
    at: [
      (a[0] + b[0]) / 2 - Math.sin(angle) * lift - anchor[0],
      (a[1] + b[1]) / 2 + Math.cos(angle) * lift - anchor[1],
    ],
    height: primitive.offset * 0.25,
    content: primitive.label,
    color,
    rotation: angle,
    dimension: true,
  });
}

const relative = (points: ReadonlyArray<Vec2>, [ax, ay]: Vec2): Vec2[] =>
  points.map(([x, y]): Vec2 => [x - ax, y - ay]);

/**
 * Line-weight buffers, fills and labels of `items`, relative to `anchor`.
 * @pure
 */
export function buildDrawingBuffers(
  items: ReadonlyArray<StyledPrimitive>,
  { patternUnit, hatchSpacing }: DrawingScale,
  anchor: Vec2,
): DrawingBuffers {
  const buffers: DrawingBuffers = {
    thick: new SegmentBuffer(anchor),
    thin: new SegmentBuffer(anchor),
    dashed: new SegmentBuffer(anchor),
    fills: [],
    labels: [],
  };
  items.forEach(({ primitive, color }, index) => {
    const stroke = new THREE.Color(color);
    const style = primitive.style;
    const target =
      style === 'cut' || style === 'visible'
        ? buffers.thick
        : style === 'hidden'
          ? buffers.dashed
          : buffers.thin;
    const ring = (points: ReadonlyArray<Vec2>, closed: boolean): void => {
      if (style === 'center') chainRing(buffers.thin, points, closed, patternUnit, stroke);
      else target.ring(points, closed, stroke);
    };
    switch (primitive.type) {
      case 'polygon':
        ring(primitive.points, true);
        if (primitive.fill === 'hatch') {
          for (const [a, b] of ansi31Hatch(
            [primitive.points, ...(primitive.holes ?? [])],
            hatchSpacing,
          ))
            buffers.thin.add(a, b, stroke);
        } else if (primitive.fill === 'solid' || style === 'cut') {
          buffers.fills.push({
            outer: relative(primitive.points, anchor),
            holes: (primitive.holes ?? []).map((hole) => relative(hole, anchor)),
          });
        }
        break;
      case 'polyline':
        ring(primitive.points, false);
        break;
      case 'line':
        ring([primitive.a, primitive.b], false);
        break;
      case 'arc':
        ring(
          arcPoints(primitive.center, primitive.radius, primitive.startAngle, primitive.endAngle),
          false,
        );
        break;
      case 'circle': {
        const points = arcPoints(primitive.center, primitive.radius, 0, Math.PI * 2).slice(0, -1);
        ring(points, true);
        if (style === 'cut') buffers.fills.push({ outer: relative(points, anchor), holes: [] });
        break;
      }
      case 'text':
        buffers.labels.push({
          key: `text-${index}`,
          at: [primitive.at[0] - anchor[0], primitive.at[1] - anchor[1]],
          height: primitive.height,
          content: primitive.content,
          color,
          rotation: 0,
          dimension: false,
        });
        break;
      case 'dimension':
        addDimension(primitive, buffers.thin, buffers.labels, `dimension-${index}`, color, anchor);
        break;
    }
  });
  return buffers;
}
