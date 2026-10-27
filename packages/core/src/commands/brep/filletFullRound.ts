/**
 * fillet_full_round (BLD M4, TECHNICAL_SPEC §4, §5.6): a half-round tangent to two side faces and a center face between them, which it consumes
 * (the top of a rib). The radius is half the gap between the sides. Built by the exact kernel for planar parallel sides and a planar center
 * square to them.
 */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { faceSetSchema, pickedFaces, runFaceBlend } from './faceBlendRun';

/**
 * @affects removes the source solid; creates 1 mesh entity whose center face is replaced by the half-round; data { id, blends, consumedFaces, unit }
 * @invariant requiresKernel; side1 / side2 parallel and facing away from each other; center square to both and as wide as the gap; the blend is tangent to all three
 * @failure BLD_FACESET_EMPTY, BLD_FACESETS_OVERLAP, BLD_FULL_ROUND_NOT_OPPOSED, BLD_FULL_ROUND_NO_SOLUTION, BLD_FACE_BLEND_UNSUPPORTED, REF_LOST / REF_SPLIT -> unchanged document
 */
export const filletFullRound = defineCommand({
  name: 'fillet_full_round',
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  description:
    'Full round of a rib or wall top: replace the center face by a half-cylinder tangent to the two side faces (radius = half the distance between them, document units) and to where the center face was, and replace the solid by the result. ' +
    'side1 / side2 are the two parallel faces facing away from each other, center the face between them (all picked by points on them and/or persistent names); the center face is consumed (data.consumedFaces). ' +
    'This kernel build rounds ONE planar face per set, the center exactly as wide as the gap between the sides and the rib ending on flat faces square to it; BLD_FULL_ROUND_NOT_OPPOSED / BLD_FULL_ROUND_NO_SOLUTION / BLD_FACE_BLEND_UNSUPPORTED say what is not met. ' +
    'Needs the exact native kernel (check kernel_info); with the mesh kernel it no-ops. Run check_blends afterwards (radius, tangency).',
  params: z.object({
    id: z.string().describe('Id of the 3D solid entity to round. Must exist and be a 3D solid kind.'),
    side1: faceSetSchema.describe('First side face (one planar face).'),
    center: faceSetSchema.describe('The face between the sides that the round consumes (one planar face, square to both sides).'),
    side2: faceSetSchema.describe('Second side face (one planar face), parallel to side1 and facing away from it.'),
  }),
  run: (doc, { id, side1, center, side2 }, ctx): CommandResult =>
    runFaceBlend(doc, ctx, {
      command: 'fillet_full_round',
      id,
      sets: { side1, center, side2 },
      describe: (newId, triangles) =>
        `fillet_full_round: rounded the top of '${id}' → mesh '${newId}' (${triangles} triangles). Source entity consumed.`,
      build: (context) => ({
        recipe: {
          op: 'fullRound',
          source: context.source,
          side1: pickedFaces(context, 'side1'),
          center: pickedFaces(context, 'center'),
          side2: pickedFaces(context, 'side2'),
        },
      }),
    }),
});
