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
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { meshLeafTriangles, operandRecipe } from '../../geometry/operandRecipe';
import { recipeOf } from '../../geometry/shapeRecipe';
import { KERNEL_MESH_LEAF_CAP } from '../kernelMeshGuard';
import { noop } from '../noop';
import { isTriangleOnly, meshBoolean } from './meshBoolean';
import { signedMeshVolume } from '../../geometry/meshVolume';
import { tupleExtent } from '../../lib/extent';

/** Result volume (relative to its bounding box) at or below which a boolean result is treated as empty (zero-volume sliver mesh). */
const VANISHED_VOLUME_RATIO = 1e-9;

/** True when the mesh encloses no volume: it is flat (a sheet where solids only touch) or a skin of coincident faces (tangent subtract). */
function enclosesNoVolume(positions: readonly number[], indices: readonly number[]): boolean {
  // a linear scan, not Math.max(...values): a dense result (> ~150k vertices) overflows the call stack as spread arguments
  const { min, max } = tupleExtent(positions, 3);
  const [sx, sy, sz] = [0, 1, 2].map((axis) => (max[axis] as number) - (min[axis] as number)) as [number, number, number];
  if (Math.min(sx, sy, sz) <= VANISHED_VOLUME_RATIO * Math.max(sx, sy, sz)) return true;
  const boxVolume = sx * sy * sz;
  return Math.abs(signedMeshVolume(positions, indices)) <= VANISHED_VOLUME_RATIO * boxVolume;
}

/** At most this many tool solids in one boolean (a plan step lists them; the kernel unions them as a balanced tree). */
const MAX_TOOLS = 1000;

/**
 * Union of `recipes` as a balanced tree: depth log2(n), so hundreds of patterned tools neither nest the recipe hundreds deep (a sequential
 * chain overflows the kernel request parser around 120 levels) nor re-fuse a growing solid n times.
 */
function balancedUnion(recipes: readonly ShapeRecipe[]): ShapeRecipe {
  if (recipes.length === 1) return recipes[0] as ShapeRecipe;
  const middle = Math.ceil(recipes.length / 2);
  return { op: 'boolean', boolean: 'union', a: balancedUnion(recipes.slice(0, middle)), b: balancedUnion(recipes.slice(middle)) };
}

/** Boolean nesting past which the native kernel request parser gives up (serde_json depth 128): the refusal names the cure. */
const DEEP_RECIPE = 100;

/** Nesting depth of boolean nodes along the base operand chain (the depth sequential cuts grow). */
function booleanChainDepth(recipe: ShapeRecipe): number {
  let depth = 0;
  for (let node = recipe; node.op === 'boolean'; node = node.a) depth++;
  return depth;
}

/** `'b'` for one tool, `N tools ('b1', …)` for several (summaries). */
function toolLabel(tools: readonly string[]): string {
  if (tools.length === 1) return `'${tools[0]}'`;
  const shown = tools.slice(0, 3).map((id) => `'${id}'`);
  return `${tools.length} tools (${shown.join(', ')}${tools.length > 3 ? ', …' : ''})`;
}

function runBoolean(
  doc: CadDocument,
  opName: string,
  op: BooleanOp,
  a: string,
  tools: readonly string[],
  engine: BooleanEngine,
  ctx: ExecutionContext | undefined,
): CommandResult {
  if (tools.includes(a)) return noop(doc, `${opName}: operands a and b must be different ids (got '${a}').`);
  const repeated = tools.find((id, i) => tools.indexOf(id) !== i);
  if (repeated !== undefined) return noop(doc, `${opName}: tool '${repeated}' is listed twice in b.`);
  if (op === 'intersect' && tools.length > 1)
    return noop(doc, `${opName}: intersect takes one tool solid b (got ${tools.length}); intersect them one boolean at a time.`);
  const ids = [a, ...tools];
  const operands = ids.map((id) => doc.entities[id]);
  const missing = ids.find((_, i) => !operands[i]);
  if (missing !== undefined) return noop(doc, `${opName}: entity '${missing}' not found.`);
  const flat = ids.find((_, i) => !is3D(operands[i] as Entity));
  if (flat !== undefined) return noop(doc, `${opName}: entity '${flat}' is a 2D shape; boolean operations require 3D solids.`);
  const instanced = ids.find((_, i) => (operands[i] as Entity).kind === 'instance');
  if (instanced !== undefined)
    return noop(doc, `${opName}: entity '${instanced}' is a component instance; run explode_instance first to get solids.`);
  const [entA, ...toolEntities] = operands as [Entity, ...Entity[]];
  const scan = [entA, ...toolEntities]
    .map((entity) => ({ id: entity.id, triangles: meshLeafTriangles(recipeOf(entity)) }))
    .find((operand) => operand.triangles > KERNEL_MESH_LEAF_CAP);
  const bySize = engine === 'auto' && scan !== undefined;
  const viaMesh = engine === 'mesh' || bySize || (engine === 'auto' && isTriangleOnly([entA, ...toolEntities]));
  if (viaMesh) {
    const context = ctx ?? currentContext();
    const result = meshBoolean(doc, opName, op, a, tools, context.meshProcessing ?? null, context.meshAssets);
    return !bySize || scan === undefined || result.affected.length === 0
      ? result
      : {
          ...result,
          summary: `${result.summary} (engine "auto": '${scan.id}' is built on ${scan.triangles} imported-mesh triangles, above the exact kernel's ${KERNEL_MESH_LEAF_CAP}, so the mesh engine ran)`,
        };
  }
  const kernel = (ctx ?? currentContext()).kernel;
  if (!kernel) return noop(doc, kernelUnavailable(opName));
  const toolRecipe = balancedUnion(toolEntities.map((tool) => operandRecipe(kernel, tool)));
  const recipe: ShapeRecipe = { op: 'boolean', boolean: op, a: operandRecipe(kernel, entA), b: toolRecipe };
  const result = evaluateRecipe(kernel, recipe);
  const b = toolLabel(tools);
  if (result === 'refused')
    return noop(
      doc,
      `${opName}: kernel returned null for operands '${a}' and ${b}. The geometry may be degenerate or unsupported.` +
        (booleanChainDepth(recipe) > DEEP_RECIPE
          ? ` '${a}' is already the result of ${booleanChainDepth(recipe) - 1} nested booleans: cut patterned tools in one boolean with b as a list of ids.`
          : ''),
    );
  if (result === 'empty' || enclosesNoVolume(result.mesh.positions, result.mesh.indices))
    return noop(
      doc,
      `${opName}: the result of '${a}' and ${b} has no usable mesh — it is empty (no volume remains, e.g. disjoint solids for an intersection) or its solid could not be meshed closed; operands kept.`,
    );
  return commitKernelResult(
    doc,
    kernel,
    result,
    [entA, ...toolEntities],
    (newId, triangles) => `${opName}: merged '${a}' and ${b} into mesh '${newId}' (${triangles} triangles). Operands consumed.`,
  );
}

type BooleanEngine = 'auto' | 'kernel' | 'mesh';

const SOLID_OPERANDS_NOTE =
  'Both operands must be 3D solids (any solid kind: box, cylinder, sphere, cone, torus, wedge, pyramid, extrusion, revolution, mesh); 2D shapes are rejected.';

/**
 * @affects removes entities a and b; creates 1 mesh entity (a ∪ b, a − b or a ∩ b)
 * @invariant both a and b must be 3D solids; subtract keeps a − b
 * @invariant kernel-optional: triangle-only operands or one built on more than KERNEL_MESH_LEAF_CAP imported-mesh triangles (engine "auto", decided from the operands alone so replay is host-independent) or engine "mesh" use ctx.meshProcessing and need no kernel; the kernel path refuses without one
 * @failure triangle-only operands without a mesh engine -> MESH_ENGINE_UNSUPPORTED
 * @failure missing id, 2D operand, same id, kernel absent, empty result or kernel failure -> no-op, affected:[]
 */
export const booleanOperation = defineCommand({
  name: 'boolean',
  annotations: { readsMeshTriangles: true },
  description:
    'Combine two 3D solid entities with a CSG operation into a single mesh entity: ' +
    'op "union" merges them, "subtract" removes the volume of b from a (order matters: result = a minus b), ' +
    '"intersect" keeps only the volume shared by both. ' +
    'Both operand entities are consumed (removed) and replaced by the result mesh. ' +
    'The kernel path requires a geometry kernel to be injected (available after app initialization); the mesh path needs only a mesh engine. ' +
    'Triangle-only operands (imported meshes, mesh results with no exact shape) are always combined by the mesh engine under engine "auto" (default; decided from the operands alone, so replay does not depend on the host): ' +
    'the result stays a plain mesh with guaranteed-manifold output and no polyhedral B-rep; engine "kernel" forces the B-rep kernel, engine "mesh" forces the ' +
    'mesh engine (refuses MESH_ENGINE_UNSUPPORTED without one; non-manifold operands refuse MESH_NON_MANIFOLD). ' +
    SOLID_OPERANDS_NOTE,
  params: z.object({
    op: z.enum(['union', 'subtract', 'intersect']).describe('"union" (a ∪ b), "subtract" (a minus b) or "intersect" (a ∩ b).'),
    a: z.string().describe('Id of the first 3D solid operand (the base solid for subtract).'),
    b: z
      .union([z.string(), z.array(z.string()).min(1).max(MAX_TOOLS)])
      .describe(
        'Id of the second 3D solid operand (the tool solid for subtract), or a list of tool ids for union / subtract: the tools are ' +
          'unioned as a balanced tree and applied in ONE boolean — use a list for patterned cuts (coolant channels, bolt holes) instead ' +
          'of hundreds of sequential booleans, which nest the recipe deeper each step and slow down quadratically.',
      ),
    engine: z
      .enum(['auto', 'kernel', 'mesh'])
      .optional()
      .describe(
        '"auto" (default): the mesh engine for triangle-only operands (imported meshes and results deformed from them) or when an operand is built on more than 20,000 imported-mesh triangles, else the kernel. "kernel": always the B-rep kernel (a recipe over more than 20,000 imported-mesh triangles is refused). "mesh": always the mesh engine (B-rep operands are tessellated).',
      ),
  }),
  run: (doc, { op, a, b, engine }, ctx): CommandResult =>
    runBoolean(doc, `boolean ${op}`, op, a, typeof b === 'string' ? [b] : b, engine ?? 'auto', ctx),
});
