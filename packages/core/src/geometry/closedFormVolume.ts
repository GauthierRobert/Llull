/**
 * Closed-form volume of one non-instance solid entity, shared by `solidVolume` (commands/inspect) and `resolveMassProperties`.
 * `analytic: false` marks volumes that are themselves a closed-mesh sum (loft, subdivision, non-round sweep): no closed form exists.
 * 'mesh' kind (kernel result or display triangles) and 'instance' are not handled here.
 */

import { type Entity } from '../model/types';
import { signedMeshVolume } from './meshVolume';
import { entityBounds } from './bounds';
import { polygonArea, polygonCentroid } from '../lib/polygon';
import { chainLength } from './curveSegments';
import { sweepTriangles } from './sweep';
import { loftTriangles } from './loft';
import { subdivisionTriangles } from './subdivision';

export interface ClosedFormVolume {
  readonly volume: number;
  readonly analytic: boolean;
  /** Set when the figure is a bounding-box approximation (revolution profile crossing its axis). */
  readonly approximation?: string;
}

/** Volume of a closed, outward-wound triangle soup. */
function closedMeshVolume(positions: number[]): number {
  return Math.abs(signedMeshVolume(positions, []));
}

/** Round sections: annulus area x path length (Pappus); other sections: tessellated volume. */
function sweepVolume(e: Extract<Entity, { kind: 'sweep' }>): ClosedFormVolume {
  const { section } = e;
  if (section.shape === 'circle' && e.stations === undefined) {
    const bore = section.innerRadius ?? 0;
    return { volume: Math.PI * (section.radius ** 2 - bore ** 2) * chainLength(e.path), analytic: true };
  }
  return { volume: closedMeshVolume(sweepTriangles(e).flat(2)), analytic: false };
}

/** Pappus: V = sweepAngle x |centroid x| x profile area; a profile crossing the axis falls back to the bounding-box volume. */
function revolutionVolume(e: Extract<Entity, { kind: 'revolution' }>): ClosedFormVolume {
  if (e.profile.some(([x]) => x < 0)) {
    const b = entityBounds(e);
    return {
      volume: (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]),
      analytic: false,
      approximation: 'bounding-box approximation — profile crosses revolution axis; Pappus requires profile x ≥ 0',
    };
  }
  const profileArea = polygonArea(e.profile);
  return {
    volume: profileArea < 1e-12 ? 0 : (e.angle ?? 2 * Math.PI) * Math.abs(polygonCentroid(e.profile)[0]) * profileArea,
    analytic: true,
  };
}

/** Closed-form (or closed-mesh) volume of a solid; null for 2D shapes, 'mesh' and 'instance'. */
export function closedFormVolume(e: Entity): ClosedFormVolume | null {
  const exact = (volume: number): ClosedFormVolume => ({ volume, analytic: true });
  switch (e.kind) {
    case 'box':
      return exact(e.size[0] * e.size[1] * e.size[2]);
    case 'cylinder':
      return exact(Math.PI * e.radius * e.radius * e.height);
    case 'sphere':
      return exact((4 / 3) * Math.PI * e.radius * e.radius * e.radius);
    case 'extrusion':
      return exact(polygonArea(e.profile) * e.depth);
    case 'cone':
      return exact((Math.PI * e.radius * e.radius * e.height) / 3);
    case 'torus':
      return exact(2 * Math.PI * Math.PI * e.ringRadius * e.tubeRadius * e.tubeRadius);
    case 'wedge':
      return exact((e.size[0] * e.size[1] * e.size[2]) / 2);
    case 'pyramid':
      return exact((e.baseWidth * e.baseDepth * e.height) / 3);
    case 'revolution':
      return revolutionVolume(e);
    case 'sweep':
      return sweepVolume(e);
    case 'loft':
      return { volume: closedMeshVolume(loftTriangles(e).flat(2)), analytic: false };
    case 'subdivision':
      return { volume: closedMeshVolume(subdivisionTriangles(e).flat(2)), analytic: false };
    default:
      return null;
  }
}
