import type { CadDocument, Vec2, Vec3 } from '../../model/types';
import { cross3, dot3 } from '../../lib/vec3';
import { planeBasis } from './rigidMotion';

/** Segments of a cam outline as polyline points in the cam's rotation-centre frame; a circle becomes 720 chords. */
function outline(doc: CadDocument, profileId: string): Vec2[] | string {
  const entity = doc.entities[profileId];
  if (entity === undefined) return `profile '${profileId}' not found`;
  if (entity.kind === 'circle') {
    const [cx, cy] = entity.center;
    return Array.from(
      { length: 720 },
      (_, i): Vec2 => [cx + entity.radius * Math.cos((2 * Math.PI * i) / 720), cy + entity.radius * Math.sin((2 * Math.PI * i) / 720)],
    );
  }
  if (entity.kind === 'rectangle')
    return [
      [0, 0],
      [entity.width, 0],
      [entity.width, entity.height],
      [0, entity.height],
    ];
  if (entity.kind === 'polyline' && entity.closed && entity.points.length >= 3) return [...entity.points];
  return `profile '${profileId}' must be a closed polyline, a circle or a rectangle (got '${entity.kind}')`;
}

/** Distance from the origin to the outline along direction angle `phi`, or null when the ray misses (origin outside the outline). */
function radius(points: readonly Vec2[], phi: number): number | null {
  const [dx, dy] = [Math.cos(phi), Math.sin(phi)];
  let best: number | null = null;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i] ?? [0, 0];
    const [x2, y2] = points[(i + 1) % points.length] ?? [0, 0];
    const [ex, ey] = [x2 - x1, y2 - y1];
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-15) continue;
    const t = (x1 * ey - y1 * ex) / denominator;
    const s = (x1 * dy - y1 * dx) / denominator;
    if (t >= 0 && s >= -1e-12 && s <= 1 + 1e-12 && (best === null || t > best)) best = t;
  }
  return best;
}

/** Follower slide function of a cam: `slide(camAngle)` = r(ψ − θ) − r(ψ), r = outline radius from the cam centre. */
export interface CamFollower {
  readonly slide: (camAngle: number) => number;
}

/**
 * Cam follower for `profileId` (outline coordinates are the profile's local XY, origin = rotation centre; world X/Y when the cam axis is
 * +Z) pushed by an in-line knife-edge follower sliding along `followerAxis`, which must be perpendicular to the cam axis `camAxis`.
 * @failure unknown / unsupported profile, follower along the cam axis, centre outside the outline -> string reason
 */
export function camFollower(doc: CadDocument, profileId: string, camAxis: Vec3, followerAxis: Vec3): CamFollower | string {
  const points = outline(doc, profileId);
  if (typeof points === 'string') return points;
  const [e1] = planeBasis(camAxis);
  const e2 = cross3(camAxis, e1);
  if (Math.abs(dot3(followerAxis, camAxis)) > 1e-6) return 'follower axis must be perpendicular to the cam axis';
  const psi = Math.atan2(dot3(followerAxis, e2), dot3(followerAxis, e1));
  const rest = radius(points, psi);
  if (rest === null) return 'the cam rotation centre must lie inside the profile outline';
  return { slide: (camAngle) => (radius(points, psi - camAngle) ?? rest) - rest };
}
