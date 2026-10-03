/**
 * @layer server
 *
 * render_view showLabels overlay: per-entity id/name labels, key-point markers, legend.
 */

import type { Entity } from '@core/model/types';
import type { RenderViewData } from '@core/commands/renderTypes';
import { entityBounds } from '@core/commands/sceneBounds';
import { escapeXml } from '@lib/escapeXml';
import { r2 } from '@core/commands/renderMath';
import { computeOrthoHalf, makeProjector } from './svgHelpers';

/**
 * Category of an entity for colour-coding in the label overlay.
 *   point    — PointEntity
 *   curve2d  — 2D lines, polylines, arcs, circles, ellipses, splines, rectangles
 *   solid3d  — all 3D solid kinds
 *   annotation — text, dimension
 */
type EntityCategory = 'point' | 'curve2d' | 'solid3d' | 'annotation';

/** CSS colours per category (must stay in sync with the legend). */
const CATEGORY_COLORS: Record<EntityCategory, string> = {
  point: '#ff9944', // orange
  curve2d: '#44ddff', // cyan
  solid3d: '#bb88ff', // purple
  annotation: '#ffdd44', // yellow
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

/**
 * Collect the world-space key points for an entity.
 *
 * For 2D entities the geometry is LOCAL (Vec2) to the work plane; we lift each
 * 2D point into world space by adding `entity.position` as the plane origin and
 * keeping z = entity.position[2] (the default Z=0 plane convention).
 *
 * For 3D solids we derive the 8 corners of the world-space AABB using
 * `entityBounds` — the same helper used by the scene snapshot. Rotation is NOT
 * applied (AABB only); this is acceptable for v1 corner markers.
 *
 * Point limit: at most MAX_KEY_POINTS per entity to avoid marker floods on
 * dense polylines/splines. We sample evenly when over the cap.
 */
const MAX_KEY_POINTS = 16;

function entityKeyPoints(e: Entity): Array<[number, number, number]> {
  const pos = e.position;

  // Helper to lift a local 2D point to world space.
  function lift(x: number, y: number): [number, number, number] {
    return [pos[0] + x, pos[1] + y, pos[2]];
  }

  // Evenly sample an array down to at most MAX_KEY_POINTS items.
  function cap<T>(pts: T[]): T[] {
    if (pts.length <= MAX_KEY_POINTS) return pts;
    const step = pts.length / MAX_KEY_POINTS;
    const result: T[] = [];
    for (let i = 0; i < MAX_KEY_POINTS; i++) {
      result.push(pts[Math.round(i * step)] as T);
    }
    return result;
  }

  switch (e.kind) {
    // -----------------------------------------------------------------------
    // 2D shapes
    // -----------------------------------------------------------------------
    case 'point':
      return [[pos[0], pos[1], pos[2]]];

    case 'line':
      return [lift(e.start[0], e.start[1]), lift(e.end[0], e.end[1])];

    case 'polyline':
      return cap(e.points.map(([x, y]) => lift(x, y)));

    case 'spline':
      return cap(e.points.map(([x, y]) => lift(x, y)));

    case 'arc': {
      // Center + a radius handle at the arc's mid-sweep angle, so the marker
      // sits ON the curve (a +X handle can fall outside the angular sweep).
      const mid = (e.startAngle + e.endAngle) / 2;
      return [
        lift(e.center[0], e.center[1]),
        lift(e.center[0] + e.radius * Math.cos(mid), e.center[1] + e.radius * Math.sin(mid)),
      ];
    }

    case 'circle':
      // Center + a radius-handle point along +X (so the agent can read the radius visually).
      return [lift(e.center[0], e.center[1]), lift(e.center[0] + e.radius, e.center[1])];

    case 'ellipse':
      // Center + semi-axis tip along +X and +Y.
      return [
        lift(e.center[0], e.center[1]),
        lift(e.center[0] + e.radiusX, e.center[1]),
        lift(e.center[0], e.center[1] + e.radiusY),
      ];

    case 'rectangle':
      // 4 corners: lower-left, lower-right, upper-right, upper-left.
      return [lift(0, 0), lift(e.width, 0), lift(e.width, e.height), lift(0, e.height)];

    case 'text':
    case 'dimension':
      // Single anchor at entity position (position is the placement point).
      return [[pos[0], pos[1], pos[2]]];

    // -----------------------------------------------------------------------
    // 3D solids — 8 AABB corners
    // -----------------------------------------------------------------------
    default: {
      const b = entityBounds(e);
      const { min, max } = b;
      return [
        [min[0], min[1], min[2]],
        [max[0], min[1], min[2]],
        [max[0], max[1], min[2]],
        [min[0], max[1], min[2]],
        [min[0], min[1], max[2]],
        [max[0], min[1], max[2]],
        [max[0], max[1], max[2]],
        [min[0], max[1], max[2]],
      ];
    }
  }
}

/**
 * Compute the screen-space anchor for a label: centroid of the key points,
 * offset slightly up so the label doesn't overlap the centre marker.
 */
function labelAnchor(
  keyPoints: Array<[number, number, number]>,
  project: (p: [number, number, number]) => [number, number],
): [number, number] {
  if (keyPoints.length === 0) return [0, 0];
  let sumX = 0,
    sumY = 0;
  for (const pt of keyPoints) {
    const [sx, sy] = project(pt);
    sumX += sx;
    sumY += sy;
  }
  return [sumX / keyPoints.length, sumY / keyPoints.length - 8];
}

/**
 * Append per-entity id/name labels, key-point markers, and a category legend
 * to an existing SVG string.
 *
 * Reuses the same world→screen projection as appendDimensionLabels / appendAxesAndGrid.
 *
 * Label design:
 *   - Each entity gets a text label (name if set, else id) at the centroid of its
 *     key points, with a dark stroke outline for readability over any background.
 *   - Key points are shown as small filled circles (r=3) in the category colour.
 *   - Marker shapes: circle for all categories (simple and robust in SVG).
 *   - Legend: top-right corner, lists the 4 categories with their colours.
 *
 * Scene density: all entities are labelled. At >30 entities labels may become
 * crowded; the agent can still use individual key-point markers for orientation.
 *
 * @pure — returns a new SVG string; does not modify the input.
 */
export function appendEntityLabels(
  svgString: string,
  data: RenderViewData,
  entities: ReadonlyArray<Entity>,
): string {
  const { camera, width, height } = data;
  const project = makeProjector(camera, computeOrthoHalf(data), width, height);

  const lines: string[] = ['  <!-- entity labels overlay -->'];
  const labelStyle = `font-family="monospace" font-size="10" stroke="#0d0d1a" stroke-width="2.5" paint-order="stroke"`;

  // -------------------------------------------------------------------------
  // Per-entity markers and labels
  // -------------------------------------------------------------------------
  for (const e of entities) {
    const cat = entityCategory(e);
    const color = CATEGORY_COLORS[cat];
    const label = e.name ?? e.id;
    const keyPts = entityKeyPoints(e);

    // Key-point markers
    lines.push(`  <g data-entity-id="${escapeXml(e.id)}" data-kind="${escapeXml(e.kind)}">`);
    for (const pt of keyPts) {
      const [sx, sy] = project(pt);
      // Only draw if reasonably within the viewport (with generous margin).
      if (sx < -20 || sx > width + 20 || sy < -20 || sy > height + 20) continue;
      lines.push(
        `    <circle cx="${r2(sx)}" cy="${r2(sy)}" r="3" fill="${color}" opacity="0.85" stroke="#0d0d1a" stroke-width="0.8"/>`,
      );
    }

    // Label at centroid of key points (always drawn even if markers clip)
    const [lx, ly] = labelAnchor(keyPts, project);
    // Clamp label position inside the viewport so it stays readable.
    const clampedLx = Math.max(4, Math.min(width - 4, lx));
    const clampedLy = Math.max(12, Math.min(height - 4, ly));
    lines.push(
      `    <text x="${r2(clampedLx)}" y="${r2(clampedLy)}" ${labelStyle} fill="${color}" text-anchor="middle">${escapeXml(label)}</text>`,
    );
    lines.push(`  </g>`);
  }

  // -------------------------------------------------------------------------
  // Legend — top-right corner
  // -------------------------------------------------------------------------
  const legendEntries: Array<{ cat: EntityCategory; label: string }> = [
    { cat: 'solid3d', label: '3D solid' },
    { cat: 'curve2d', label: '2D curve' },
    { cat: 'point', label: 'point' },
    { cat: 'annotation', label: 'annotation' },
  ];
  const legendX = width - 4;
  const legendY0 = 16;
  const lineH = 14;
  lines.push(`  <g id="entity-labels-legend" font-family="monospace" font-size="10">`);
  for (let i = 0; i < legendEntries.length; i++) {
    const entry = legendEntries[i] as { cat: EntityCategory; label: string };
    const color = CATEGORY_COLORS[entry.cat];
    const y = legendY0 + i * lineH;
    lines.push(`    <circle cx="${r2(legendX - 60)}" cy="${r2(y - 3)}" r="3" fill="${color}"/>`);
    lines.push(
      `    <text x="${r2(legendX - 54)}" y="${r2(y)}" fill="${color}" stroke="#0d0d1a" stroke-width="2" paint-order="stroke">${escapeXml(entry.label)}</text>`,
    );
  }
  lines.push(`  </g>`);

  const overlay = lines.join('\n');
  return svgString.replace('</svg>', `${overlay}\n</svg>`);
}
