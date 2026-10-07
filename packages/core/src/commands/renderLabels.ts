/**
 * render_view showLabels overlay: per-entity id/name labels, key-point markers, legend.
 *
 * @layer core/commands
 */

import type { Entity, Vec3 } from '../model/types';
import type { RenderViewData } from './renderTypes';
import { boundsCorners, entityBounds } from './sceneBounds';
import { escapeXml } from '../lib/escapeXml';
import { type Projector, makeProjector, computeOrthoHalf } from './renderCamera';
import { appendBeforeClose, r2, svgDot } from './renderSvg';

/** Colour-coding group of an entity in the label overlay. */
type EntityCategory = 'point' | 'curve2d' | 'solid3d' | 'annotation';

/** Marker colour and legend caption per category (insertion order = legend order). */
const CATEGORY_STYLE: Record<EntityCategory, { color: string; caption: string }> = {
  solid3d: { color: '#bb88ff', caption: '3D solid' },
  curve2d: { color: '#44ddff', caption: '2D curve' },
  point: { color: '#ff9944', caption: 'point' },
  annotation: { color: '#ffdd44', caption: 'annotation' },
};

function entityCategory(e: Entity): EntityCategory {
  switch (e.kind) {
    case 'point':
      return 'point';
    case 'line':
    case 'polyline':
    case 'arc':
    case 'circle':
    case 'rectangle':
    case 'ellipse':
    case 'spline':
      return 'curve2d';
    case 'text':
    case 'dimension':
      return 'annotation';
    default:
      return 'solid3d';
  }
}

/** Most key points marked per entity; longer lists are sampled evenly. */
const MAX_KEY_POINTS = 16;

function evenlySampled<T>(points: T[]): T[] {
  if (points.length <= MAX_KEY_POINTS) return points;
  const step = points.length / MAX_KEY_POINTS;
  return Array.from({ length: MAX_KEY_POINTS }, (_, i) => points[Math.round(i * step)] as T);
}

/**
 * World-space key points of an entity. 2D geometry is local to the work plane, so it is lifted by
 * `position` (plane origin, z = position z). Solids use the 8 corners of their AABB (rotation is
 * not applied).
 */
function entityKeyPoints(e: Entity): Vec3[] {
  const pos = e.position;
  const lift = (x: number, y: number): Vec3 => [pos[0] + x, pos[1] + y, pos[2]];

  switch (e.kind) {
    case 'point':
    case 'text':
    case 'dimension':
      return [pos];
    case 'line':
      return [lift(e.start[0], e.start[1]), lift(e.end[0], e.end[1])];
    case 'polyline':
    case 'spline':
      return evenlySampled(e.points.map(([x, y]) => lift(x, y)));
    case 'arc': {
      // Centre + a radius handle at the mid-sweep angle, so the marker sits ON the curve.
      const mid = (e.startAngle + e.endAngle) / 2;
      return [
        lift(e.center[0], e.center[1]),
        lift(e.center[0] + e.radius * Math.cos(mid), e.center[1] + e.radius * Math.sin(mid)),
      ];
    }
    case 'circle':
      return [lift(e.center[0], e.center[1]), lift(e.center[0] + e.radius, e.center[1])];
    case 'ellipse':
      return [
        lift(e.center[0], e.center[1]),
        lift(e.center[0] + e.radiusX, e.center[1]),
        lift(e.center[0], e.center[1] + e.radiusY),
      ];
    case 'rectangle':
      return [lift(0, 0), lift(e.width, 0), lift(e.width, e.height), lift(0, e.height)];
    case 'instance':
      return [pos]; // its component's extent needs the document; anchor the label at its origin
    default:
      return boundsCorners(entityBounds(e));
  }
}

/** Screen-space label anchor: centroid of the projected key points, nudged up off the markers. */
function labelAnchor(keyPoints: Vec3[], project: Projector): [number, number] {
  if (keyPoints.length === 0) return [0, 0];
  const screen = keyPoints.map((point) => project(point));
  const mean = (axis: 0 | 1): number =>
    screen.reduce((sum, point) => sum + point[axis], 0) / screen.length;
  return [mean(0), mean(1) - 8];
}

/**
 * Append per-entity id/name labels, key-point markers (circles in the category colour) and a
 * category legend (top-right) to an SVG string, projected like the other overlays.
 *
 * @pure — returns a new SVG string; does not modify the input.
 */
export function appendEntityLabels(
  svgString: string,
  data: RenderViewData,
  entities: ReadonlyArray<Entity>,
): string {
  const { camera, width, height } = data;
  const project = makeProjector(camera, computeOrthoHalf(data.bounds), width, height);

  const lines: string[] = ['  <!-- entity labels overlay -->'];
  const labelStyle = `font-family="monospace" font-size="10" stroke="#0d0d1a" stroke-width="2.5" paint-order="stroke"`;

  for (const e of entities) {
    const { color } = CATEGORY_STYLE[entityCategory(e)];
    const keyPoints = entityKeyPoints(e);

    lines.push(`  <g data-entity-id="${escapeXml(e.id)}" data-kind="${escapeXml(e.kind)}">`);
    for (const point of keyPoints) {
      const screen = project(point);
      // Only draw markers reasonably within the viewport (with generous margin).
      if (screen[0] < -20 || screen[0] > width + 20 || screen[1] < -20 || screen[1] > height + 20) {
        continue;
      }
      lines.push(
        `    ${svgDot(screen, `fill="${color}" opacity="0.85" stroke="#0d0d1a" stroke-width="0.8"`)}`,
      );
    }

    // The label is always drawn (clamped inside the viewport), even if its markers clip.
    const [lx, ly] = labelAnchor(keyPoints, project);
    const clampedLx = Math.max(4, Math.min(width - 4, lx));
    const clampedLy = Math.max(12, Math.min(height - 4, ly));
    lines.push(
      `    <text x="${r2(clampedLx)}" y="${r2(clampedLy)}" ${labelStyle} fill="${color}" text-anchor="middle">${escapeXml(e.name ?? e.id)}</text>`,
    );
    lines.push(`  </g>`);
  }

  const legendX = width - 4;
  lines.push(`  <g id="entity-labels-legend" font-family="monospace" font-size="10">`);
  Object.values(CATEGORY_STYLE).forEach(({ color, caption }, i) => {
    const y = 16 + i * 14;
    lines.push(`    ${svgDot([legendX - 60, y - 3], `fill="${color}"`)}`);
    lines.push(
      `    <text x="${r2(legendX - 54)}" y="${r2(y)}" fill="${color}" stroke="#0d0d1a" stroke-width="2" paint-order="stroke">${escapeXml(caption)}</text>`,
    );
  });
  lines.push(`  </g>`);

  return appendBeforeClose(svgString, lines.join('\n'));
}
