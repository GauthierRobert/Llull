/**
 * The holes and pockets of a part for `check_machining` / `hole_table`: authored (`feature` nodes of its recipe) when it has any, else
 * recognised from the exact B-rep (imported parts, 07 FTR M4).
 */

import type { GeometryKernel } from '../../geometry/kernel';
import type { ShapeRecipe } from '../../model/types';
import { type MachinedHole, type MachinedPocket, authoredFeatures } from '../../geometry/featureInstances';
import { countersinkDepth } from '../../lib/holeMath';
import { planeFrame, worldToFrame } from '../../geometry/featureFrame';
import { recognizeFeatures } from '../../geometry/recognition/recognize';
import type { Recognition } from '../../geometry/recognition/types';
import { lengthToleranceOf, recognitionOf } from './recognition';

export interface MachinedPart {
  readonly holes: readonly MachinedHole[];
  readonly pockets: readonly MachinedPocket[];
  readonly source: 'authored' | 'recognized' | 'none';
}

function fromRecognition(found: Recognition): MachinedPart {
  const holes = found.holes.map((hole, index): MachinedHole => {
    const normal = hole.axis.map((c) => -c) as unknown as MachinedHole['frame']['normal'];
    const frame = planeFrame(normal, hole.axisPoint);
    return {
      id: `hole-r${index}`,
      kind: hole.subtype,
      diameter: hole.diameter,
      ...(hole.cboreDiameter === undefined ? {} : { cboreDiameter: hole.cboreDiameter }),
      ...(hole.cboreDepth === undefined ? {} : { cboreDepth: hole.cboreDepth }),
      ...(hole.cskDiameter === undefined ? {} : { cskDiameter: hole.cskDiameter }),
      ...(hole.cskAngleDeg === undefined ? {} : { cskAngle: hole.cskAngleDeg }),
      ...(hole.cskDiameter === undefined || hole.cskAngleDeg === undefined
        ? {}
        : { cskDepth: countersinkDepth(hole.diameter, hole.cskDiameter, hole.cskAngleDeg).value }),
      ...(hole.depth === undefined ? {} : { depth: hole.depth }),
      through: hole.through,
      ...(hole.drillPointAngleDeg === undefined ? {} : { drillPointAngle: { value: hole.drillPointAngleDeg, defaulted: false } }),
      frame,
      position: hole.axisPoint,
      point: worldToFrame(frame, hole.axisPoint),
    };
  });
  const pockets = found.pockets.map(
    (pocket, index): MachinedPocket => ({
      id: `pocket-r${index}`,
      cornerRadius: pocket.cornerRadius,
      floorFillet: pocket.floorFillet,
      depth: pocket.depth,
      frame: planeFrame(pocket.normal, [
        pocket.normal[0] * pocket.floorZ,
        pocket.normal[1] * pocket.floorZ,
        pocket.normal[2] * pocket.floorZ,
      ]),
    }),
  );
  return { holes, pockets, source: 'recognized' };
}

/** Features of `recipe`; recognition runs only when the recipe carries none and the kernel has the face-query port. */
export function machinedPart(kernel: GeometryKernel, recipe: ShapeRecipe): MachinedPart {
  const authored = authoredFeatures(recipe);
  if (authored.holes.length + authored.pockets.length > 0) return { ...authored, source: 'authored' };
  const input = recognitionOf(kernel, recipe);
  if (typeof input === 'string') return { holes: [], pockets: [], source: 'none' };
  const found = recognizeFeatures(
    input.graph,
    input.topology,
    { kinds: ['hole', 'pocket'], mergeSplitFaces: true, angularTolerance: 1e-6, lengthTolerance: lengthToleranceOf(input.topology) },
    input.orientation,
  );
  return fromRecognition(found);
}
