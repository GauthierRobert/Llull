// Scan-point snap: the resident cloud point nearest to a screen position, within a pixel tolerance. Pure; the viewport feeds it the camera
// matrices and the resident tiles. Tiles are culled by their bounding sphere, so the point loop only runs near the pointer.

import type { Vec3 } from '@core/model/vectors';

/** A resident tile as the snap sees it: positions relative to `origin` (float32), both in document coordinates. */
export interface SnapTile {
  readonly origin: Vec3;
  readonly positions: Float32Array;
  readonly centre: Vec3;
  readonly radius: number;
}

export interface SnapView {
  /** Column-major 4 x 4 (three `Matrix4.elements`) of projection × view, for RENDER space (document − renderOrigin). */
  readonly viewProjection: ArrayLike<number>;
  readonly renderOrigin: Vec3;
  /** Viewport size in px. */
  readonly width: number;
  readonly height: number;
  /** Pixels per metre at unit distance: height / (2 tan(fov / 2)). */
  readonly focalPx: number;
}

export interface ScanSnapHit {
  /** Document coordinates of the cloud point. */
  readonly position: Vec3;
  readonly pixelDistance: number;
}

interface Projected {
  readonly x: number;
  readonly y: number;
  /** Clip-space w: the distance along the view axis. */
  readonly depth: number;
}

/** Screen position (px, y down) of a document point, or null behind the camera. */
export function projectToScreen(view: SnapView, x: number, y: number, z: number): Projected | null {
  const m = view.viewProjection;
  const rx = x - view.renderOrigin[0];
  const ry = y - view.renderOrigin[1];
  const rz = z - view.renderOrigin[2];
  const w = (m[3] ?? 0) * rx + (m[7] ?? 0) * ry + (m[11] ?? 0) * rz + (m[15] ?? 0);
  if (!(w > 0)) return null;
  const cx = (m[0] ?? 0) * rx + (m[4] ?? 0) * ry + (m[8] ?? 0) * rz + (m[12] ?? 0);
  const cy = (m[1] ?? 0) * rx + (m[5] ?? 0) * ry + (m[9] ?? 0) * rz + (m[13] ?? 0);
  return { x: (cx / w / 2 + 0.5) * view.width, y: (0.5 - cy / w / 2) * view.height, depth: w };
}

/** The nearest projected point of `tiles` to `pointer` (px) within `tolerancePx`; ties go to the nearer point along the view axis. */
export function nearestScreenPoint(
  tiles: readonly SnapTile[],
  view: SnapView,
  pointer: { readonly x: number; readonly y: number },
  tolerancePx: number,
): ScanSnapHit | null {
  let best: ScanSnapHit | null = null;
  let bestDepth = Infinity;
  for (const tile of tiles) {
    const centre = projectToScreen(view, tile.centre[0], tile.centre[1], tile.centre[2]);
    if (centre === null) continue;
    const reach = tolerancePx + (tile.radius * view.focalPx) / centre.depth;
    const inside = centre.depth <= tile.radius;
    if (!inside && Math.hypot(centre.x - pointer.x, centre.y - pointer.y) > reach) continue;
    const { positions, origin } = tile;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const x = origin[0] + (positions[i] ?? 0);
      const y = origin[1] + (positions[i + 1] ?? 0);
      const z = origin[2] + (positions[i + 2] ?? 0);
      const p = projectToScreen(view, x, y, z);
      if (p === null) continue;
      const distance = Math.hypot(p.x - pointer.x, p.y - pointer.y);
      if (distance > tolerancePx) continue;
      const closer = best === null || distance < best.pixelDistance - 1e-9;
      const tied = best !== null && Math.abs(distance - best.pixelDistance) <= 1e-9 && p.depth < bestDepth;
      if (closer || tied) {
        best = { position: [x, y, z], pixelDistance: distance };
        bestDepth = p.depth;
      }
    }
  }
  return best;
}
