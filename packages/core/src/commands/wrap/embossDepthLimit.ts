import { sampleSegment, type PlaneSegment } from '../../geometry/planeSegments';
import type { CommandResult } from '../types';
import { freeformDepthLimit } from './embossFreeform';
import { MAX_PROBES, type Mapped } from './embossMapping';
import type { EmbossRecipe } from './embossRecipe';
import type { EmbossCall } from './embossRequest';
import type { FaceSession } from './faceSession';
import { probePoints } from './wrapMapping';

/**
 * How deep a deboss can go before it passes through the material: the distance from the deepest point of the mapped profile to the axis (cylinder: its radius;
 * cone: the smallest v of the profile x sin(semi-angle); sphere: its radius; torus: the tube radius). A bore (material outside the face) and a plane have no such limit.
 */
function debossLimit(session: FaceSession, pieces: readonly (readonly PlaneSegment[])[], convex: boolean | null): number | null {
  if (convex === false) return null;
  if (session.surface.type === 'cylinder' || session.surface.type === 'sphere') return session.surface.radius;
  if (session.surface.type === 'torus') return session.surface.minor;
  if (session.surface.type !== 'cone') return null;
  const smallestV = Math.min(...pieces.flat().flatMap((piece) => sampleSegment(piece, 9).map((p) => p[1])));
  return smallestV * Math.sin(session.surface.semiAngle);
}

export function checkDepthLimits(call: EmbossCall, mapped: Mapped, built: EmbossRecipe): CommandResult | null {
  const { doc, session, resolved, fail, cutting, depth } = call;
  const { freeform, closed } = built;
  const reach = freeform !== null ? null : debossLimit(session, mapped.pieces, closed?.convex ?? null);
  if (cutting && freeform !== null) {
    const through = freeformDepthLimit({
      query: session.query,
      shape: session.shape,
      chart: resolved.chart,
      orientation: resolved.orientation,
      points: [resolved.anchorOn, ...probePoints(resolved.chart, mapped.pieces, MAX_PROBES)],
      depth,
    });
    if (through !== null) {
      const result = fail(
        'WRP_DEPTH_EXCEEDS_SOLID',
        `depth ${depth} passes through the material: it ends ${through.toPrecision(6)} ${doc.units} below the freeform face at the thinnest probed place`,
        ['depth'],
      );
      return { ...result, data: { maxDepth: through, unit: doc.units } };
    }
  }
  if (cutting && reach !== null && depth >= reach * (1 - 1e-9)) {
    const result = fail(
      'WRP_DEPTH_EXCEEDS_SOLID',
      `depth ${depth} reaches the ${reach.toPrecision(6)} ${doc.units} between the deepest point of the profile and the axis of the ${session.surface.type} face`,
      ['depth'],
    );
    return { ...result, data: { maxDepth: reach, unit: doc.units } };
  }
  return null;
}
