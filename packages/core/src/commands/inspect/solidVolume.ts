import { type CadDocument, type Entity, is2D } from '../../model/types';
import { signedMeshVolume } from '../../geometry/meshVolume';
import type { ExecutionContext } from '../types';
import { expandInstance } from '../../geometry/instanceExpansion';
import { closedFormVolume } from '../../geometry/closedFormVolume';
import { currentContext } from '../context';
import { recipeOf } from '../../geometry/shapeRecipe';
import { exactLeafVolume } from '../../geometry/resolveMassProperties';

/** Volume of one solid: how it was computed, or why it could not be. */
export type SolidVolume =
  | {
      readonly volume: number;
      /** 'exact': the kernel's B-rep volume; 'mesh': the display triangles; absent: a closed form. */
      readonly method?: 'exact' | 'mesh';
      /** Set when the figure is a bounding-box approximation (revolution profile crossing its axis). */
      readonly approximation?: string;
    }
  | { readonly error: string };

/**
 * Exact volume of a kernel result (a mesh entity that keeps its B-rep recipe), or null when no kernel with exact topology (OCC) is
 * installed. The display mesh is a coarse tessellation (0.1 linear / 0.5 rad angular deflection), so its volume is off by up to ~1 % on
 * small curved parts — too much for a mass check against a drawing.
 */
function exactVolume(e: Entity, ctx: ExecutionContext | undefined): number | null {
  if (e.kind !== 'mesh' || e.brep === undefined) return null;
  const kernel = (ctx ?? currentContext()).kernel;
  const shape = kernel?.evaluate(recipeOf(e)) ?? null;
  const topology = shape === null ? null : (kernel?.topology(shape) ?? null);
  return topology !== null && topology.volume > 0 ? topology.volume : null;
}

/**
 * The limit-surface patch solid of a subdivision entity as a stand-in kernel result (a world-placed mesh entity whose `brep` is the subdivision
 * recipe), so volume, centroid, inertia and method all come from ONE exact model; null without an exact kernel (mass properties + face queries) or
 * when the kernel cannot build the patches.
 */
export function limitPatchEntity(e: Entity, ctx: ExecutionContext | undefined): Entity | null {
  if (e.kind !== 'subdivision') return null;
  const kernel = (ctx ?? currentContext()).kernel;
  if (kernel?.massProperties === undefined || kernel.faceQuery === undefined) return null;
  const shape = kernel.evaluate(recipeOf(e));
  const volume = shape === null ? 0 : (kernel.massProperties(shape)?.volume ?? 0);
  if (!(volume > 0)) return null;
  return {
    id: e.id,
    kind: 'mesh',
    layerId: e.layerId,
    color: e.color,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    ...(e.materialId === undefined ? {} : { materialId: e.materialId }),
    mesh: { positions: [], indices: [] },
    brep: recipeOf(e),
  };
}

/**
 * Volume of one solid entity (instances: the sum of their baked solid children).
 * @failure instance with a missing component, or a non-solid kind -> { error }
 */
export function solidVolume(doc: CadDocument, e: Entity, ctx: ExecutionContext | undefined): SolidVolume {
  if (is2D(e))
    return {
      error:
        `entity '${e.id}' is kind '${e.kind}'; ` +
        "supported kinds are 'box', 'cylinder', 'sphere', 'extrusion', 'mesh', 'cone', 'torus', 'wedge', 'pyramid', 'revolution', 'sweep', 'loft', 'subdivision', 'instance'.",
    };
  if (e.kind === 'mesh') {
    const exact = exactVolume(e, ctx);
    return exact === null
      ? { volume: Math.abs(signedMeshVolume(e.mesh.positions, e.mesh.indices)), method: 'mesh' }
      : { volume: exact, method: 'exact' };
  }
  if (e.kind === 'instance') {
    const component = doc.components[e.componentId];
    if (!component) return { error: `instance '${e.id}' references missing component '${e.componentId}'.` };
    let volume = 0;
    for (const child of expandInstance(e, component)) volume += childVolume(doc, child, ctx);
    return { volume };
  }
  const exactLeaf = exactLeafVolume(e, (ctx ?? currentContext()).kernel);
  if (exactLeaf !== null) return { volume: exactLeaf, method: 'exact' };
  const closed = closedFormVolume(e);
  return closed === null
    ? { error: `entity '${e.id}' is kind '${e.kind}'; it has no solid volume.` }
    : { volume: closed.volume, ...(closed.approximation === undefined ? {} : { approximation: closed.approximation }) };
}

/** Volume of a baked instance child; 2D and unsupported children weigh nothing. */
export function childVolume(doc: CadDocument, child: Entity, ctx: ExecutionContext | undefined): number {
  const part = solidVolume({ ...doc, entities: { [child.id]: child } }, child, ctx);
  return 'error' in part ? 0 : part.volume;
}
