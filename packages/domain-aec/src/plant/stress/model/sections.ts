/** Arc length along a centreline and the pipe section that applies there (a reducer changes it, 07 PST M5a). Pure geometry. */

import type { Vec3 } from '@core/model/vectors';

export interface Section {
  readonly odMm: number;
  readonly wallMm: number;
}

/** The section from `fromArcMm` on, along the centreline of a pipe. The first step starts at 0. */
export interface SectionStep {
  readonly fromArcMm: number;
  readonly section: Section;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Cumulative arc length of every vertex of the polyline. */
export function vertexArcs(points: readonly Vec3[]): number[] {
  const arcs = [0];
  for (let i = 1; i < points.length; i++) arcs.push((arcs[i - 1] as number) + dist(points[i - 1] as Vec3, points[i] as Vec3));
  return arcs;
}

/** Arc length of the point of the polyline nearest to `point`. */
export function arcOf(points: readonly Vec3[], point: Vec3): number {
  const arcs = vertexArcs(points);
  let best = { arc: 0, distance: Number.POSITIVE_INFINITY };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec3;
    const b = points[i] as Vec3;
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const t =
      l2 === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * d[0] + (point[1] - a[1]) * d[1] + (point[2] - a[2]) * d[2]) / l2));
    const distance = dist(point, [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t]);
    if (distance < best.distance - 1e-9) best = { arc: (arcs[i - 1] as number) + t * Math.sqrt(l2), distance };
  }
  return best.arc;
}

/** The section at `arcMm`: the last step that starts at or before it. */
export function sectionAt(steps: readonly SectionStep[], arcMm: number): Section {
  let section = (steps[0] as SectionStep).section;
  for (const step of steps) if (step.fromArcMm <= arcMm + 1e-6) section = step.section;
  return section;
}

/** Mean of two sections (the stiffness section of a reducer element, 07 PST M5a: arithmetic mean of OD and wall). */
export const meanSection = (a: Section, b: Section): Section => ({ odMm: (a.odMm + b.odMm) / 2, wallMm: (a.wallMm + b.wallMm) / 2 });

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Point at arc length `atMm` along the polyline (clamped to its ends), or null when the polyline is empty. */
export function pointAtArc(points: readonly Vec3[], atMm: number): Vec3 | null {
  let remaining = atMm;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec3;
    const b = points[i] as Vec3;
    const leg = Math.hypot(...sub(b, a));
    if (remaining <= leg || i === points.length - 1) return lerp(a, b, leg === 0 ? 0 : Math.min(1, remaining / leg));
    remaining -= leg;
  }
  return points[0] ?? null;
}
