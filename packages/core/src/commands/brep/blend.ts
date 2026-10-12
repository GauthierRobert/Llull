/**
 * blend_union: weld several solids into one exact piece and round every joint where they meet —
 * the "one-piece frame" operation (tubes + lugs + dropouts → a single blended carbon frame).
 *
 * @layer core/commands
 */

import { type Entity, type ShapeRecipe, is3D } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { noop } from '../noop';
import { commitKernelResult, evaluateRecipe, operandRecipe } from './kernelShape';
import { OCC_KERNEL_HINT } from './modify3d';

const MAX_BLEND_OPERANDS = 200;

/**
 * @command blend_union
 * @pure
 * @layer core/commands
 * @affects removes the operand solids; creates 1 mesh entity (their union, joints filleted)
 * @invariant >= 2 distinct 3D solids; radius > 0; a kernel with fillets (OCC)
 * @failure missing / duplicate / 2D / instance operand, bad radius, no kernel, kernel lacks blends,
 *   kernel refusal (radius too large for a joint) -> no-op, affected:[]
 */
export const blendUnion = defineCommand({
  name: 'blend_union',
  annotations: { requiresKernel: true },
  description:
    'Weld 2+ solids into ONE exact solid and round every joint where they meet with a fillet: ' +
    'the one-piece frame operation (bike frame tubes, lugs and dropouts; pipe tees; brackets welded to ' +
    'plates; organic joints between swept or lofted parts). All intersection curves created by the ' +
    'union are filleted with `radius` (for a radius that varies along one edge, use fillet_edge ' +
    'radiusEnd on the result). The operands are consumed and replaced by one mesh entity that ' +
    'keeps the exact construction (STEP export, further fillets and booleans see true faces). ' +
    `Requires ${OCC_KERNEL_HINT}; the default Manifold kernel cannot fillet and gracefully no-ops ` +
    '(use boolean op union there). If the kernel refuses, try another radius: a blend must fit inside ' +
    'the smallest wall it touches, and a crotch where three solids meet can reject specific radii.',
  params: z.object({
    ids: z
      .array(z.string())
      .describe('Ids of the 3D solids to weld (>= 2, distinct). The first one styles the result.'),
    radius: z.number().describe('Joint fillet radius in document units (> 0).'),
  }),
  run: (doc, { ids, radius }, ctx): CommandResult => {
    const fail = (why: string): CommandResult => noop(doc, `blend_union: ${why}; no-op.`);
    if (ids.length < 2 || ids.length > MAX_BLEND_OPERANDS)
      return fail(`needs 2..${MAX_BLEND_OPERANDS} solids (got ${ids.length})`);
    if (new Set(ids).size !== ids.length) return fail('ids must be distinct');
    if (!(radius > 0)) return fail(`radius must be > 0 (got ${radius})`);
    const operands: Entity[] = [];
    for (const id of ids) {
      const entity = doc.entities[id];
      if (entity === undefined) return fail(`entity '${id}' not found`);
      if (!is3D(entity)) return fail(`entity '${id}' is a 2D shape; blends need 3D solids`);
      if (entity.kind === 'instance')
        return fail(`entity '${id}' is a component instance; run explode_instance first`);
      operands.push(entity);
    }
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('blend_union'));
    if (!kernel.supports('blend'))
      return fail(`this kernel cannot fillet joints; use ${OCC_KERNEL_HINT}, or boolean op union`);
    const recipe: ShapeRecipe = {
      op: 'blend',
      sources: operands.map((entity) => operandRecipe(kernel, entity)),
      radius,
    };
    const result = evaluateRecipe(kernel, recipe);
    if (result === 'refused')
      return fail(
        `the kernel could not blend the joints of [${ids.join(', ')}] with radius ${radius}; try another radius (smaller usually fits; a crotch where 3 solids meet can reject specific radii)`,
      );
    if (result === 'empty')
      return fail('the union is empty or could not be meshed as a closed solid');
    return commitKernelResult(
      doc,
      kernel,
      result,
      operands as [Entity, ...Entity[]],
      (newId, triangles) =>
        `blend_union: welded ${ids.length} solids [${ids.join(', ')}] into one piece '${newId}' with joints filleted (radius ${radius}; ${triangles} triangles). Operands consumed.`,
    );
  },
});
