/**
 * split_body (SC-F1): cut a solid in two along a plane. Each half is the solid intersected with a half-space box (a cube 4x the solid's
 * size, one face on the plane), so any kernel with booleans splits it, exact or mesh.
 */

import type { CadDocument, Entity, ShapeRecipe, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { changed, noop } from '../noop';
import { nextId } from '../../lib/id';
import { add3, normalize3, scale3 } from '../../lib/vec3';
import { meshDiagonal } from '../../geometry/meshExtent';
import { newEntity } from '../entity/newEntity';
import { replaceEntities, withEntity } from '../entity/entityOps';
import { evaluateRecipe, kernelResultEntity } from '../kernelShape';
import { operandRecipe } from '../../geometry/operandRecipe';
import { validateSolidTarget } from './modifyTarget';

/** Euler angles (M = Rx·Ry·Rz, Rz = 0) turning +Z onto unit `n`. */
function tiltOnto([nx, ny, nz]: Vec3): Vec3 {
  return [Math.atan2(-ny, nz), Math.asin(Math.max(-1, Math.min(1, nx))), 0];
}

/** A cube of edge `size` whose face lies on the plane, on the `side` (+1 along the normal, -1 against) of it. */
function halfSpace(origin: Vec3, normal: Vec3, size: number, side: 1 | -1, template: Entity): ShapeRecipe {
  const cube = newEntity('box', 'split-half-space', { size: [size, size, size] }, [0, 0, 0], template.color, { layerId: template.layerId });
  return {
    op: 'place',
    source: { op: 'solid', entity: cube },
    position: add3(origin, scale3(normal, (side * size) / 2)),
    rotation: tiltOnto(normal),
  };
}

/**
 * @affects removes source entity; creates 2 mesh entities (the halves above and below the plane)
 * @failure missing / non-solid target, no kernel, zero normal, plane missing the solid (one half empty), kernel refusal -> no-op
 */
export const splitBody = defineCommand({
  name: 'split_body',
  annotations: { requiresKernel: true },
  description:
    'Split a 3D solid in two along a plane: the source is replaced by two mesh entities, the half on the normal side first, then the other. ' +
    'Works on every kernel with booleans (exact B-rep halves on the native kernel). Refused when the plane misses the solid.',
  params: z.object({
    id: z.string().describe('Id of the 3D solid to split.'),
    plane: z
      .object({ origin: vec3('A point [x, y, z] on the plane.'), normal: vec3('Plane normal [x, y, z] (any length > 0).') })
      .describe('The cutting plane.'),
  }),
  run: (doc, { id, plane }, ctx): CommandResult => splitAlong(doc, id, plane.origin, plane.normal, ctx?.kernel ?? currentContext().kernel),
});

function splitAlong(
  doc: CadDocument,
  id: string,
  origin: Vec3,
  normal: Vec3,
  kernel: ReturnType<typeof currentContext>['kernel'],
): CommandResult {
  const fail = (why: string): CommandResult => noop(doc, `split_body: ${why}; document unchanged.`);
  const validation = validateSolidTarget(doc, 'split_body', id);
  if ('summary' in validation) return validation;
  const { entity } = validation;
  if (!kernel) return noop(doc, kernelUnavailable('split_body'));
  if (Math.hypot(...normal) === 0) return fail('plane.normal must be non-zero');
  const n = normalize3(normal);
  const source = operandRecipe(kernel, entity);
  const shape = kernel.evaluate(source);
  const mesh = shape === null ? null : kernel.tessellate(shape);
  if (mesh === null) return fail(`kernel could not build entity '${id}'`);
  const size = 4 * meshDiagonal(mesh) + 1;
  const halves = ([1, -1] as const).map((side) =>
    evaluateRecipe(kernel, { op: 'boolean', boolean: 'intersect', a: source, b: halfSpace(origin, n, size, side, entity) }),
  );
  const [above, below] = halves;
  if (typeof above === 'string' || typeof below === 'string' || above === undefined || below === undefined)
    return fail('the plane does not cut the solid in two (one side is empty) or the kernel refused the cut');
  const [first, second] = [nextId('mesh'), nextId('mesh')];
  const replaced = replaceEntities(doc, [id], kernelResultEntity(first, above, entity));
  const document = withEntity(replaced, kernelResultEntity(second, below, entity));
  return changed(document, `split_body: split '${id}' into '${first}' (normal side) and '${second}'. Source entity consumed.`, [
    first,
    second,
  ]);
}
