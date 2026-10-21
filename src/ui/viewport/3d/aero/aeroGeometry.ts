// Pure geometry of the aerodynamics overlay: wind-arrow layout, the silhouette rectangle normal to the flow, and the Cp colour scale
// of an airfoil outline. No three.js, no React (unit-tested).

import type { Vec2, Vec3 } from '@core/model/types';
import { boundsCenter, boundsCorners, type Bounds } from '@core/geometry/bounds';
import { add3, cross3, dot3, scale3, sub3 } from '@lib/vec3';

const add = (a: Vec3, b: Vec3, k: number): Vec3 => add3(a, scale3(b, k));

export function normalized(direction: Vec3): Vec3 {
  const length = Math.hypot(...direction);
  return length > 0 ? [direction[0] / length, direction[1] / length, direction[2] / length] : [1, 0, 0];
}

/** Two unit axes spanning the plane normal to the unit flow direction. */
function planeAxes(flow: Vec3): { u: Vec3; v: Vec3 } {
  const helper: Vec3 = Math.abs(flow[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalized(cross3(helper, flow));
  return { u, v: cross3(flow, u) };
}

export interface FlowFrame {
  readonly center: Vec3;
  /** Half extent of the body along the flow. */
  readonly depth: number;
  /** Silhouette extent of the bounds in the plane normal to the flow, relative to `center`. */
  readonly uRange: readonly [number, number];
  readonly vRange: readonly [number, number];
  readonly u: Vec3;
  readonly v: Vec3;
}

/** The body bounds seen along `flow` (unit vector): where it sits and how wide its bounding silhouette is. */
export function flowFrame(bounds: Bounds, flow: Vec3): FlowFrame {
  const center = boundsCenter(bounds);
  const { u, v } = planeAxes(flow);
  const offsets = boundsCorners(bounds).map((corner) => sub3(corner, center));
  const range = (axis: Vec3): [number, number] => [
    Math.min(...offsets.map((o) => dot3(o, axis))),
    Math.max(...offsets.map((o) => dot3(o, axis))),
  ];
  return { center, depth: Math.max(...offsets.map((o) => Math.abs(dot3(o, flow)))), uRange: range(u), vRange: range(v), u, v };
}

/** Closed loop of the bounding rectangle normal to the flow, `gap` downstream of the body (the "A = …" frontal-area plane). */
export function silhouetteLoop(frame: FlowFrame, flow: Vec3, gap: number): Vec3[] {
  const plane = add(frame.center, flow, frame.depth + gap);
  const at = (a: number, b: number): Vec3 => add(add(plane, frame.u, a), frame.v, b);
  const [u0, u1] = frame.uRange;
  const [v0, v1] = frame.vRange;
  return [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1), at(u0, v0)];
}

export interface WindArrow {
  readonly origin: Vec3;
  readonly length: number;
}

/** `grid`×`grid` streamline arrows upstream of the body, spread across its silhouette and pointing along the flow. */
export function windArrows(frame: FlowFrame, flow: Vec3, length: number, gap: number, grid = 3): WindArrow[] {
  const start = add(frame.center, flow, -(frame.depth + gap + length));
  const arrows: WindArrow[] = [];
  for (let i = 0; i < grid; i += 1)
    for (let j = 0; j < grid; j += 1) {
      const a = frame.uRange[0] + ((frame.uRange[1] - frame.uRange[0]) * (i + 0.5)) / grid;
      const b = frame.vRange[0] + ((frame.vRange[1] - frame.vRange[0]) * (j + 0.5)) / grid;
      arrows.push({ origin: add(add(start, frame.u, a), frame.v, b), length });
    }
  return arrows;
}

/** Point on the downstream side of the body where the drag arrow starts (the centroid) and its tip. */
export function dragArrowTip(center: Vec3, flow: Vec3, length: number): Vec3 {
  return add(center, flow, length);
}

export type Rgb = readonly [number, number, number];
const LOW_CP: Rgb = [0.12, 0.35, 0.95];
const MID_CP: Rgb = [0.92, 0.92, 0.92];
const HIGH_CP: Rgb = [0.92, 0.18, 0.15];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Diverging scale pivoting at Cp = 0: blue = suction (Cp < 0), grey = free-stream pressure, red = pressure (Cp > 0). */
export function cpColor(cp: number, cpMin: number, cpMax: number): Rgb {
  if (cp < 0) return mix(MID_CP, LOW_CP, cpMin < 0 ? Math.min(1, cp / cpMin) : 0);
  return mix(MID_CP, HIGH_CP, cpMax > 0 ? Math.min(1, cp / cpMax) : 0);
}

export interface SurfacePoint {
  readonly x: number;
  readonly y: number;
  readonly cp: number;
}

/**
 * Cp at each polyline vertex: the nearest panel control point in chord-normalised coordinates
 * (x/c from the leading edge, y/c from the leading-edge height — the frame analyze_airfoil reports).
 */
export function vertexPressures(points: ReadonlyArray<Vec2>, surface: ReadonlyArray<SurfacePoint>): number[] {
  if (surface.length === 0 || points.length === 0) return points.map(() => 0);
  const leading = points.reduce((best, point) => (point[0] < best[0] ? point : best), points[0] as Vec2);
  const chord = Math.max(...points.map(([x]) => x)) - leading[0];
  if (!(chord > 0)) return points.map(() => 0);
  return points.map(([px, py]) => {
    const x = (px - leading[0]) / chord;
    const y = (py - leading[1]) / chord;
    let best = surface[0] as SurfacePoint;
    let bestDistance = Infinity;
    for (const candidate of surface) {
      const distance = (candidate.x - x) ** 2 + (candidate.y - y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best.cp;
  });
}

/** One colour per aerodynamic quantity: the panel swatches and the glyphs on the model share them. */
export const AERO_COLORS = { wind: '#5ab4ff', drag: '#ef4444', area: '#f59e0b', lift: '#22c55e', pressure: '#a78bfa' } as const;
