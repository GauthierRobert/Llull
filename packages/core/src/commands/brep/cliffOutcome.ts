/**
 * What a fillet_faces `cliff` request built (TECHNICAL_SPEC 13.28): the cliff engaged (the face was narrower than the tangent contact, the blend
 * touches its far edge and is sharp there) or the plain tangent blend fit and `cliff` changed nothing.
 * @invariant read from the built shape: engaged <=> a blend face has a straight edge against a face that is not one of its supports
 */

import type { GeometryKernel, ShapeTopology } from '../../geometry/kernel';
import type { ShapeHandle } from '../../geometry/kernelTypes';
import { blendSource } from '../../geometry/blend/continuity';
import { cliffEdgeOf } from '../../geometry/blend/cliffEdge';
import { roundSignificant } from '../../lib/significant';
import type { FaceBlendOutcome } from './faceBlendRun';

const degrees = (radians: number): number => roundSignificant((radians * 180) / Math.PI, 6);

export function cliffOutcome(
  kernel: GeometryKernel,
  shape: ShapeHandle,
  after: ShapeTopology | null,
  before: ShapeTopology | null,
  cliff: 'A' | 'B',
): FaceBlendOutcome {
  const other = cliff === 'A' ? 'B' : 'A';
  const graph = kernel.faceQuery?.faceGraph(shape) ?? null;
  for (const face of after?.faces ?? []) {
    const cliffEdge = after === null || graph === null ? null : cliffEdgeOf(kernel, shape, after, graph, face.index);
    if (cliffEdge === null) continue;
    const kept = new Set((after?.faces ?? []).map((candidate) => candidate.name));
    const consumed = (blendSource(face.name ?? '')?.supports ?? []).find(
      (name) => !kept.has(name) && before?.faces.some((b) => b.name === name),
    );
    const angle = degrees(cliffEdge.angleRad);
    return {
      data: { cliffEngaged: true, cliffEdgeAngle: angle, cliffFace: consumed },
      note: ` Cliff engaged: the blend is G1 to set ${other}, sharp (${angle}°) at the cliff edge (angle between the surface normals, 0 = tangent); the cliff face ${consumed ?? `of set ${cliff}`} was consumed.`,
    };
  }
  return { data: { cliffEngaged: false }, note: ` Cliff not needed: set ${cliff} is wide enough, the plain tangent blend was built.` };
}
