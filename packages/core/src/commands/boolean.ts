/**
 * Boolean solid commands (union, subtract, intersect): two 3D solid operands become one mesh
 * entity evaluated by the injected GeometryKernel; a missing kernel or a null result is a no-op.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity } from '../model/types';
import { is3D } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import type { BooleanOp } from '../geometry/kernel';
import type { ExecutionContext } from './context';
import { currentContext } from './context';
import { nextId } from '../lib/id';
import { referenceLossSuffix, replaceEntities } from './entityOps';
import { kernelUnavailable } from './kernelRefusal';
import { newEntity } from './newEntity';
import { noop } from './noop';

function runBoolean(
  doc: CadDocument,
  opName: string,
  op: BooleanOp,
  a: string,
  b: string,
  ctx: ExecutionContext | undefined,
): CommandResult {
  if (a === b) {
    return noop(doc, `${opName}: operands a and b must be different ids (got '${a}').`);
  }
  const ids = [a, b];
  const operands = ids.map((id) => doc.entities[id]);
  const missing = ids.find((_, i) => !operands[i]);
  if (missing !== undefined) return noop(doc, `${opName}: entity '${missing}' not found.`);
  const flat = ids.find((_, i) => !is3D(operands[i] as Entity));
  if (flat !== undefined) {
    return noop(
      doc,
      `${opName}: entity '${flat}' is a 2D shape; boolean operations require 3D solids.`,
    );
  }
  const instanced = ids.find((_, i) => (operands[i] as Entity).kind === 'instance');
  if (instanced !== undefined) {
    return noop(
      doc,
      `${opName}: entity '${instanced}' is a component instance; run explode_instance first to get solids.`,
    );
  }
  const [entA, entB] = operands as [Entity, Entity];

  const k = (ctx ?? currentContext()).kernel;
  if (!k) return noop(doc, kernelUnavailable(opName));

  const meshData = k.booleanOp(op, entA, entB);
  if (!meshData) {
    return noop(
      doc,
      `${opName}: kernel returned null for operands '${a}' and '${b}'. The geometry may be degenerate or unsupported.`,
    );
  }

  if (meshData.indices.length === 0) {
    return noop(
      doc,
      `${opName}: the result of '${a}' and '${b}' is empty (no volume remains, e.g. disjoint solids for an intersection); operands kept.`,
    );
  }

  const newId = nextId('mesh');
  const meshEntity = newEntity('mesh', newId, { mesh: meshData }, [0, 0, 0], entA.color, {
    layerId: entA.layerId,
  });

  const triangleCount = meshData.indices.length / 3;
  const document = replaceEntities(doc, [a, b], meshEntity);
  return {
    document,
    summary: `${opName}: merged '${a}' and '${b}' into mesh '${newId}' (${triangleCount} triangles). Operands consumed.${referenceLossSuffix(doc, document)}`,
    affected: [newId],
  };
}

/**
 * @command boolean_union
 * @pure
 * @affects removes entities a and b; creates 1 mesh entity (their union)
 * @invariant both a and b must be 3D solids; geometry kernel must be injected
 * @failure missing id, 2D operand, same id, kernel absent, or kernel failure -> no-op, affected:[]
 */
export const booleanUnion = defineCommand({
  name: 'boolean_union',
  annotations: { requiresKernel: true },
  description:
    'Merge two 3D solid entities into a single mesh entity using a CSG union operation. ' +
    'Both operand entities are consumed (removed) and replaced by the union mesh. ' +
    'Requires a geometry kernel to be injected (available after app initialization). ' +
    'Both operands must be 3D solids (any solid kind: box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, revolution, mesh); 2D shapes are rejected.',
  params: z.object({
    a: z.string().describe('Id of the first 3D solid operand.'),
    b: z.string().describe('Id of the second 3D solid operand.'),
  }),
  run: (doc, { a, b }, ctx): CommandResult => runBoolean(doc, 'boolean_union', 'union', a, b, ctx),
});

/**
 * @command boolean_subtract
 * @pure
 * @affects removes entities a and b; creates 1 mesh entity (a minus b)
 * @invariant both a and b must be 3D solids; result = a − b (order matters)
 * @failure missing id, 2D operand, same id, kernel absent, or kernel failure -> no-op, affected:[]
 */
export const booleanSubtract = defineCommand({
  name: 'boolean_subtract',
  annotations: { requiresKernel: true },
  description:
    'Subtract the volume of 3D solid b from 3D solid a, producing a mesh entity. ' +
    'Order matters: result = a minus b. ' +
    'Both operand entities are consumed (removed) and replaced by the result mesh. ' +
    'Requires a geometry kernel to be injected. ' +
    'Both operands must be 3D solids (any solid kind: box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, revolution, mesh); 2D shapes are rejected.',
  params: z.object({
    a: z.string().describe('Id of the base 3D solid (the solid to subtract from).'),
    b: z.string().describe('Id of the tool 3D solid (the solid to subtract with).'),
  }),
  run: (doc, { a, b }, ctx): CommandResult =>
    runBoolean(doc, 'boolean_subtract', 'subtract', a, b, ctx),
});

/**
 * @command boolean_intersect
 * @pure
 * @affects removes entities a and b; creates 1 mesh entity (their intersection)
 * @invariant both a and b must be 3D solids; kernel must be injected
 * @failure missing id, 2D operand, same id, kernel absent, or kernel failure -> no-op, affected:[]
 */
export const booleanIntersect = defineCommand({
  name: 'boolean_intersect',
  annotations: { requiresKernel: true },
  description:
    'Compute the intersection of two 3D solid entities, producing a mesh entity that covers ' +
    'only the volume shared by both solids. ' +
    'Both operand entities are consumed (removed) and replaced by the intersection mesh. ' +
    'Requires a geometry kernel to be injected. ' +
    'Both operands must be 3D solids (any solid kind: box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, revolution, mesh); 2D shapes are rejected.',
  params: z.object({
    a: z.string().describe('Id of the first 3D solid operand.'),
    b: z.string().describe('Id of the second 3D solid operand.'),
  }),
  run: (doc, { a, b }, ctx): CommandResult =>
    runBoolean(doc, 'boolean_intersect', 'intersect', a, b, ctx),
});
