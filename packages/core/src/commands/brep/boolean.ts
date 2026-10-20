/**
 * Boolean solid commands (union, subtract, intersect): two 3D solid operands become one mesh entity whose `brep` is the boolean recipe of
 * their exact shapes (so later fillets/booleans see real edges and faces); the mesh is the kernel's display tessellation. A missing kernel
 * or a null result is a no-op.
 */

import { type CadDocument, type Entity, is3D } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import type { BooleanOp, ShapeRecipe } from '../../model/types';
import { currentContext } from '../context';
import type { ExecutionContext } from '../types';
import { kernelUnavailable } from '../kernelRefusal';
import { commitKernelResult, evaluateRecipe, operandRecipe } from './kernelShape';
import { noop } from '../noop';
import { signedMeshVolume } from '../../geometry/meshVolume';

/** Result volume (relative to its bounding box) at or below which a boolean result is treated as empty (zero-volume sliver mesh). */
const VANISHED_VOLUME_RATIO = 1e-9;

/** True when the mesh encloses no volume: it is flat (a sheet where solids only touch) or a skin of coincident faces (tangent subtract). */
function enclosesNoVolume(positions: readonly number[], indices: readonly number[]): boolean {
  const xyz = (axis: number): number[] => positions.filter((_, i) => i % 3 === axis);
  const [xs, ys, zs] = [xyz(0), xyz(1), xyz(2)];
  const span = (values: number[]): number => Math.max(...values) - Math.min(...values);
  const [sx, sy, sz] = [span(xs), span(ys), span(zs)];
  if (Math.min(sx, sy, sz) <= VANISHED_VOLUME_RATIO * Math.max(sx, sy, sz)) return true;
  const boxVolume = sx * sy * sz;
  return Math.abs(signedMeshVolume(positions, indices)) <= VANISHED_VOLUME_RATIO * boxVolume;
}

function runBoolean(
  doc: CadDocument,
  opName: string,
  op: BooleanOp,
  a: string,
  b: string,
  ctx: ExecutionContext | undefined,
): CommandResult {
  if (a === b) return noop(doc, `${opName}: operands a and b must be different ids (got '${a}').`);
  const ids = [a, b];
  const operands = ids.map((id) => doc.entities[id]);
  const missing = ids.find((_, i) => !operands[i]);
  if (missing !== undefined) return noop(doc, `${opName}: entity '${missing}' not found.`);
  const flat = ids.find((_, i) => !is3D(operands[i] as Entity));
  if (flat !== undefined) return noop(doc, `${opName}: entity '${flat}' is a 2D shape; boolean operations require 3D solids.`);
  const instanced = ids.find((_, i) => (operands[i] as Entity).kind === 'instance');
  if (instanced !== undefined)
    return noop(doc, `${opName}: entity '${instanced}' is a component instance; run explode_instance first to get solids.`);
  const [entA, entB] = operands as [Entity, Entity];
  const kernel = (ctx ?? currentContext()).kernel;
  if (!kernel) return noop(doc, kernelUnavailable(opName));
  const recipe: ShapeRecipe = { op: 'boolean', boolean: op, a: operandRecipe(kernel, entA), b: operandRecipe(kernel, entB) };
  const result = evaluateRecipe(kernel, recipe);
  if (result === 'refused')
    return noop(doc, `${opName}: kernel returned null for operands '${a}' and '${b}'. The geometry may be degenerate or unsupported.`);
  if (result === 'empty' || enclosesNoVolume(result.mesh.positions, result.mesh.indices))
    return noop(
      doc,
      `${opName}: the result of '${a}' and '${b}' has no usable mesh — it is empty (no volume remains, e.g. disjoint solids for an intersection) or its solid could not be meshed closed; operands kept.`,
    );
  return commitKernelResult(
    doc,
    kernel,
    result,
    [entA, entB],
    (newId, triangles) => `${opName}: merged '${a}' and '${b}' into mesh '${newId}' (${triangles} triangles). Operands consumed.`,
  );
}

const SOLID_OPERANDS_NOTE =
  'Both operands must be 3D solids (any solid kind: box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, revolution, mesh); 2D shapes are rejected.';

/**
 * @affects removes entities a and b; creates 1 mesh entity (a ∪ b, a − b or a ∩ b)
 * @invariant both a and b must be 3D solids; geometry kernel must be injected; subtract keeps a − b
 * @failure missing id, 2D operand, same id, kernel absent, empty result or kernel failure -> no-op, affected:[]
 */
export const booleanOperation = defineCommand({
  name: 'boolean',
  annotations: { requiresKernel: true },
  description:
    'Combine two 3D solid entities with a CSG operation into a single mesh entity: ' +
    'op "union" merges them, "subtract" removes the volume of b from a (order matters: result = a minus b), ' +
    '"intersect" keeps only the volume shared by both. ' +
    'Both operand entities are consumed (removed) and replaced by the result mesh. ' +
    'Requires a geometry kernel to be injected (available after app initialization). ' +
    SOLID_OPERANDS_NOTE,
  params: z.object({
    op: z.enum(['union', 'subtract', 'intersect']).describe('"union" (a ∪ b), "subtract" (a minus b) or "intersect" (a ∩ b).'),
    a: z.string().describe('Id of the first 3D solid operand (the base solid for subtract).'),
    b: z.string().describe('Id of the second 3D solid operand (the tool solid for subtract).'),
  }),
  run: (doc, { op, a, b }, ctx): CommandResult => runBoolean(doc, `boolean ${op}`, op, a, b, ctx),
});
