/**
 * blend_union: weld several solids into one exact piece and round every joint where they meet — the "one-piece frame" operation (tubes +
 * lugs + dropouts → a single blended carbon frame).
 */

import { type Entity, type ShapeRecipe, is3D } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { noop, failer } from '../noop';
import { blendRejection } from './blendCodes';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { round6 } from '../../lib/compactNumber';
import { operandRecipe } from '../../geometry/operandRecipe';
import { OCC_KERNEL_HINT } from './modifyTarget';

const MAX_BLEND_OPERANDS = 200;

/**
 * @affects removes the operand solids; creates 1 mesh entity (their union, joints filleted)
 * @invariant >= 2 distinct 3D solids; radius > 0; a kernel with fillets (OCC); every joint has `radius` except the joints (and their tangent chains) nearest to a `joints` pick, which have the pick's radius
 * @failure missing / duplicate / 2D / instance operand, bad radius, no kernel, kernel lacks blends, kernel refusal (radius too large for a
 *   joint) -> no-op, affected:[]; a joint radius <= 0, two radii on one tangent chain, a pick farther than 10 x its radius from every joint, no joint to pick -> BLD_JOINT_PARAMS (path joints[i].near / .radius)
 * data = { joints [{ index, distanceToJoint, radius }], unit } when joints were given
 */
export const blendUnion = defineCommand({
  name: 'blend_union',
  annotations: { requiresKernel: true },
  description:
    'Weld 2+ solids into ONE exact solid and round every joint where they meet with a fillet: ' +
    'the one-piece frame operation (bike frame tubes, lugs and dropouts; pipe tees; brackets welded to ' +
    'plates; organic joints between swept or lofted parts). All intersection curves created by the ' +
    'union are filleted with `radius` (for a radius that varies along one edge, use fillet_edge ' +
    'radiusEnd on the result); `joints` [{ near, radius }] gives the joint nearest to each point its own radius (the whole tangent chain of that joint: one radius per chain, two different radii on one chain are refused). The operands are consumed and replaced by one mesh entity that ' +
    'keeps the exact construction (STEP export, further fillets and booleans see true faces). ' +
    `Needs the exact kernel (check kernel_info): ${OCC_KERNEL_HINT}; with the mesh kernel it cannot fillet and no-ops ` +
    '(use boolean op union there). If the kernel refuses, try another radius: a blend must fit inside ' +
    'the smallest wall it touches, and a crotch where three solids meet can reject specific radii.',
  params: z.object({
    ids: z.array(z.string()).describe('Ids of the 3D solids to weld (>= 2, distinct). The first one styles the result.'),
    radius: z.number().describe('Joint fillet radius in document units (> 0), for every joint that has no entry in joints.'),
    joints: z
      .array(
        z.object({
          near: vec3(
            'A point [x, y, z] in document units on or near the joint (the intersection curve the union creates) to give its own radius; the joint nearest to it is picked.',
          ),
          radius: z.number().describe('Fillet radius of that joint and its tangent chain in document units (> 0).'),
        }),
      )
      .describe(
        'Per-joint radii: each entry picks the joint nearest to near and rounds it (with the joints tangent to it) with radius instead of the default radius. Several entries may name the same chain only with the same radius; a point farther than 10 x its radius from every joint is refused (BLD_JOINT_PARAMS). The result reports each pick distance to its joint (distanceToJoint) in data.joints.',
      )
      .optional(),
  }),
  run: (doc, { ids, radius, joints }, ctx): CommandResult => {
    const fail = failer(doc, 'blend_union');
    if (ids.length < 2 || ids.length > MAX_BLEND_OPERANDS) return fail(`needs 2..${MAX_BLEND_OPERANDS} solids (got ${ids.length})`);
    if (new Set(ids).size !== ids.length) return fail('ids must be distinct');
    if (!(radius > 0)) return fail(`radius must be > 0 (got ${radius})`);
    const operands: Entity[] = [];
    for (const id of ids) {
      const entity = doc.entities[id];
      if (entity === undefined) return fail(`entity '${id}' not found`);
      if (!is3D(entity)) return fail(`entity '${id}' is a 2D shape; blends need 3D solids`);
      if (entity.kind === 'instance') return fail(`entity '${id}' is a component instance; run explode_instance first`);
      operands.push(entity);
    }
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('blend_union'));
    if (!kernel.supports('blend')) return fail(`this kernel cannot fillet joints; use ${OCC_KERNEL_HINT}, or boolean op union`);
    for (const [at, joint] of (joints ?? []).entries())
      if (!(joint.radius > 0))
        return blendRejection(doc, 'blend_union', 'BLD_JOINT_PARAMS', `joints[${at}].radius must be > 0 (got ${joint.radius})`, ids, [
          `joints[${at}].radius`,
        ]);
    const recipe: ShapeRecipe = {
      op: 'blend',
      sources: operands.map((entity) => operandRecipe(kernel, entity)),
      radius,
      ...(joints === undefined || joints.length === 0
        ? {}
        : { joints: joints.map((joint) => ({ near: joint.near, radius: joint.radius })) }),
    };
    const result = evaluateRecipe(kernel, recipe);
    if (result === 'refused') {
      const why = kernel.blendReport?.(recipe)?.message;
      const coded = /^\[BLD_JOINT_PARAMS\]\s*(joints(?:\[\d+\])?(?:\.\w+)?):\s*([\s\S]*)$/.exec(why ?? '');
      if (coded !== null) return blendRejection(doc, 'blend_union', 'BLD_JOINT_PARAMS', coded[2] ?? '', ids, [coded[1] ?? 'joints']);
      return fail(
        `the kernel could not blend the joints of [${ids.join(', ')}] with radius ${radius}${why === undefined || why === '' ? '' : ` (${why})`}; try another radius (smaller usually fits; a crotch where 3 solids meet can reject specific radii)`,
      );
    }
    if (result === 'empty') return fail('the union is empty or could not be meshed as a closed solid');
    const committed = commitKernelResult(
      doc,
      kernel,
      result,
      operands as [Entity, ...Entity[]],
      (newId, triangles) =>
        `blend_union: welded ${ids.length} solids [${ids.join(', ')}] into one piece '${newId}' with joints filleted (radius ${radius}; ${triangles} triangles). Operands consumed.`,
    );
    const picks = kernel.blendReport?.(recipe)?.notes?.picks;
    if (committed.document === doc || picks === undefined || picks.length === 0) return committed;
    return {
      ...committed,
      data: {
        joints: picks.map((pick, at) => ({ index: at, distanceToJoint: round6(pick.distance), radius: pick.radius })),
        unit: doc.units,
      },
    };
  },
});
