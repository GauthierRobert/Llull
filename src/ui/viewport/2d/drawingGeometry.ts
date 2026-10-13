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
import { type DrawingFill, type DrawingPrimitive, LINE_PATTERNS } from '@core/model/drawing';
import { ansi31Hatch } from '@lib/hatch';
import { positiveSweep } from '@lib/angle';
import { sampleArc } from '@lib/arc';
import { dimensionGeometry } from '@core/geometry/dimensionGeometry';

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
  const { segments, label } = dimensionGeometry(primitive);
  for (const [a, b] of segments) buffer.add(a, b, stroke);
  labels.push({
    key,
    at: [label.at[0] - anchor[0], label.at[1] - anchor[1]],
    height: label.height,
    content: primitive.label,
    color,
    rotation: label.angle,
    dimension: true,
  });
}

/** An explicitly filled area: ANSI31 hatch lines (thin) or a solid poché region. */
function fillArea(
  buffers: DrawingBuffers,
  { anchor, hatchSpacing }: { readonly anchor: Vec2; readonly hatchSpacing: number },
  outer: ReadonlyArray<Vec2>,
  holes: ReadonlyArray<ReadonlyArray<Vec2>>,
  fill: DrawingFill | undefined,
  stroke: THREE.Color,
): void {
  if (fill === 'hatch') {
    for (const [a, b] of ansi31Hatch([outer, ...holes], hatchSpacing))
      buffers.thin.add(a, b, stroke);
  } else if (fill === 'solid') {
    buffers.fills.push({
      outer: relative(outer, anchor),
      holes: holes.map((hole) => relative(hole, anchor)),
    });
  }
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
  const area = { anchor, hatchSpacing };
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
        fillArea(buffers, area, primitive.points, primitive.holes ?? [], primitive.fill, stroke);
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
        fillArea(buffers, area, points, [], primitive.fill, stroke);
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
