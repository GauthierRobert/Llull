/**
 * The exact kernel is never asked to rebuild a large scan (DES-7e, 01 DEF §15): a `mesh` leaf becomes one OCCT face per triangle, sewn, which grows
 * faster than linearly (a 5,120-triangle boolean 3.1 s, a 20,480-triangle deform 41 s, 327,680 triangles never finished). `execute` hands commands
 * a view of the kernel whose `evaluate` refuses (null, as for any refused recipe) a recipe over more than KERNEL_MESH_LEAF_CAP scan triangles, and
 * the summary names it with the remedy. Mesh kernels (Manifold) take triangles natively and are not guarded.
 */

import type { GeometryKernel } from '../geometry/kernel';
import { meshLeafTriangles } from '../geometry/operandRecipe';
import type { ShapeRecipe } from '../model/types';
import type { CommandResult, ExecutionContext } from './types';

/** Named guard: scan triangles above which the exact kernel is not asked to rebuild a recipe. */
export const KERNEL_MESH_LEAF_CAP = 20_000;

const views = new WeakMap<GeometryKernel, GeometryKernel>();
const isView = new WeakSet<GeometryKernel>();
/** Largest refused scan size of the outermost running execute, or null outside one. */
let refusedTriangles: number | null = null;

const isExactKernel = (kernel: GeometryKernel): boolean => kernel.name === 'occt' || kernel.info?.().occtVersion !== undefined;

/** `call(recipe)` when its scan is within the cap, else null (recorded for the note). */
function capped<T>(recipe: ShapeRecipe, call: (recipe: ShapeRecipe) => T | null): T | null {
  const triangles = meshLeafTriangles(recipe);
  if (triangles <= KERNEL_MESH_LEAF_CAP) return call(recipe);
  if (refusedTriangles !== null) refusedTriangles = Math.max(refusedTriangles, triangles);
  return null;
}

/**
 * The guarded view of `kernel`: every member that takes a recipe (`evaluate`, `blendReport`, `deformReport`; the rest take handles, which only
 * `evaluate` makes) goes through the cap. The same object for the same kernel, so caches keyed by kernel keep working. Hosts that build kernel
 * work outside `execute` (FEA geometry) use it too.
 */
export function guardedKernel(kernel: GeometryKernel): GeometryKernel {
  if (isView.has(kernel) || !isExactKernel(kernel)) return kernel;
  const known = views.get(kernel);
  if (known !== undefined) return known;
  const { blendReport, deformReport } = kernel;
  const view: GeometryKernel = {
    ...kernel,
    evaluate: (recipe) => capped(recipe, (inner) => kernel.evaluate(inner)),
    ...(blendReport === undefined ? {} : { blendReport: (recipe: ShapeRecipe) => capped(recipe, (inner) => blendReport(inner)) }),
    ...(deformReport === undefined ? {} : { deformReport: (recipe: ShapeRecipe) => capped(recipe, (inner) => deformReport(inner)) }),
  };
  views.set(kernel, view);
  isView.add(view);
  return view;
}

/** `ctx` with the guarded view of its kernel. */
export function guardedContext(ctx: ExecutionContext): ExecutionContext {
  if (ctx.kernel === null) return ctx;
  const kernel = guardedKernel(ctx.kernel);
  return kernel === ctx.kernel ? ctx : { ...ctx, kernel };
}

/** Run one execute; the outermost appends the note when the guard refused a recipe during it. */
export function withKernelMeshGuard(run: () => CommandResult): CommandResult {
  if (refusedTriangles !== null) return run();
  refusedTriangles = 0;
  let result: CommandResult;
  let refused: number;
  try {
    result = run();
  } finally {
    refused = refusedTriangles;
    refusedTriangles = null;
  }
  if (refused === 0) return result;
  return {
    ...result,
    summary:
      `${result.summary} Note: the exact kernel was not asked to rebuild ${refused} triangles of an imported mesh (above ${KERNEL_MESH_LEAF_CAP}: one face per ` +
      'triangle would take minutes); use the mesh tools (boolean engine "mesh", the deform commands, analyze_mesh), or decimate_mesh a copy before an exact operation.',
  };
}
