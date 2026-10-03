/**
 * Boolean solid commands — union, subtract, intersect.
 *
 * Each command consumes two 3D solid operands (by id) and produces a single
 * `MeshSolidEntity` whose geometry is evaluated by the injected GeometryKernel.
 * When the kernel is unavailable (null) or returns null, the command no-ops.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity } from '../model/types';
import { is3D } from '../model/types';
import type { MeshSolidEntity } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import type { BooleanOp } from '../geometry/kernel';
import type { ExecutionContext } from './context';
import { currentContext } from './context';
import { nextId } from '../lib/id';
import { replaceEntities } from './entityOps';
import { noOp, type NoOpResult } from './commandResult';

function validateOperands(
  doc: CadDocument,
  opName: string,
  a: string,
  b: string,
): NoOpResult | null {
  if (a === b) {
    return noOp(doc, `${opName}: operands a and b must be different ids (got '${a}').`);
  }
  const entA = doc.entities[a];
  if (!entA) {
    return noOp(doc, `${opName}: entity '${a}' not found.`);
  }
  const entB = doc.entities[b];
  if (!entB) {
    return noOp(doc, `${opName}: entity '${b}' not found.`);
  }
  if (!is3D(entA)) {
    return noOp(
      doc,
      `${opName}: entity '${a}' is a 2D shape; boolean operations require 3D solids.`,
    );
  }
  if (!is3D(entB)) {
    return noOp(
      doc,
      `${opName}: entity '${b}' is a 2D shape; boolean operations require 3D solids.`,
    );
  }
  return null;
}

function runBoolean(
  doc: CadDocument,
  opName: string,
  op: BooleanOp,
  a: string,
  b: string,
  ctx: ExecutionContext | undefined,
): CommandResult {
  const invalid = validateOperands(doc, opName, a, b);
  if (invalid) return invalid;

  const entA = doc.entities[a] as Entity;
  const entB = doc.entities[b] as Entity;

  const k = (ctx ?? currentContext()).kernel;
  if (!k) {
    return noOp(
      doc,
      `${opName}: geometry kernel not available (still loading or not installed); document unchanged — retry once the kernel is ready.`,
    );
  }

  const meshData = k.booleanOp(op, entA, entB);
  if (!meshData) {
    return noOp(
      doc,
      `${opName}: kernel returned null for operands '${a}' and '${b}'. The geometry may be degenerate or unsupported.`,
    );
  }

  const newId = nextId('mesh');
  const meshEntity: MeshSolidEntity = {
    id: newId,
    kind: 'mesh',
    mesh: meshData,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: entA.layerId,
    color: entA.color,
  };

  const triangleCount = meshData.indices.length / 3;
  return {
    document: replaceEntities(doc, [a, b], meshEntity),
    summary: `${opName}: merged '${a}' and '${b}' into mesh '${newId}' (${triangleCount} triangles). Operands consumed.`,
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
    'Both operands must be 3D solids (box, cylinder, sphere, extrusion, or mesh).',
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
    'Both operands must be 3D solids (box, cylinder, sphere, extrusion, or mesh).',
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
    'Both operands must be 3D solids (box, cylinder, sphere, extrusion, or mesh).',
  params: z.object({
    a: z.string().describe('Id of the first 3D solid operand.'),
    b: z.string().describe('Id of the second 3D solid operand.'),
  }),
  run: (doc, { a, b }, ctx): CommandResult =>
    runBoolean(doc, 'boolean_intersect', 'intersect', a, b, ctx),
});
