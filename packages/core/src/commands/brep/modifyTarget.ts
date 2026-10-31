/** Shared checks and refusal texts of the edge-modifying commands (fillet_edge, chamfer_edge, shell_solid). */

import { type CadDocument, type Entity, type ShapeRecipe, is3D } from '../../model/types';
import type { GeometryKernel, ShapeTopology } from '../../geometry/kernel';
import type { CommandResult } from '../types';
import { noop } from '../noop';

/** Surface-neutral pointer to the B-rep kernel (server env var). */
export const OCC_KERNEL_HINT = 'the OCC kernel (the desktop default; LLULL_KERNEL=occt-native or occt for the CLI and server)';

/** The name of one sub-patch of an exact corner star: `blend(v:<edge name>,...)#k`. */
const STAR_FACE = /^blend\(v:.*\)#\d+$/;

export function validateSolidTarget(doc: CadDocument, opName: string, id: string): { entity: Entity } | CommandResult {
  const entity = doc.entities[id];
  if (!entity) return noop(doc, `${opName}: entity '${id}' not found.`);
  if (!is3D(entity))
    return noop(
      doc,
      `${opName}: entity '${id}' is a 2D shape (kind '${entity.kind}'); only 3D solids can be filleted, chamfered or shelled.`,
    );
  if (entity.kind === 'instance')
    return noop(doc, `${opName}: entity '${id}' is a component instance; run explode_instance first to get solids.`);
  return { entity };
}

/** Why the kernel gave no usable result: an unsupported op, a failed / invalid solid, or an open mesh. */
export function modifyFailure(
  command: string,
  kernel: GeometryKernel,
  modified: ShapeRecipe,
  result: 'refused' | 'empty',
  source: ShapeTopology | null = null,
): string {
  if (!kernel.supports(modified.op))
    return `${command}: kernel does not support ${command} for this operand (returned null). Use ${OCC_KERNEL_HINT} or a different operand.`;
  if (result === 'empty')
    return (
      `${command}: the result could not be tessellated into a closed mesh (typically a corner where ` +
      'several rounded edges meet); document unchanged. Round fewer edges per call, or clip the corners ' +
      'with boolean op intersect (e.g. a rounded-rectangle prism) instead.'
    );
  if (command === 'shell_solid') {
    // a refusal the kernel named before it tried (SHL_*: corner-star faces too fine for the inward offset, 06 BLD 13.33.5): its own words, with the remedy
    const named = kernel.lastRefusal?.() ?? null;
    const at = named === null ? -1 : named.indexOf('[SHL_');
    if (named !== null && at >= 0) return `shell_solid: ${named.slice(at)}; document unchanged.`;
    // the kernel keeps no reason for a recipe it already refused (it caches the refusal as null): a sealed shell of a solid with corner-star faces says so from the topology
    const stars =
      modified.op === 'shell' && modified.openNear === undefined
        ? (source?.faces ?? []).filter((face) => STAR_FACE.test(face.name ?? '')).length
        : 0;
    return (
      'shell_solid: the kernel could not hollow this solid into a valid one (returned null: thickness too ' +
      'large for a feature, a rounded edge whose radius is not larger than the thickness, an openFacesNear point that picks no face, or a ' +
      'self-intersecting offset); document unchanged. Try a smaller thickness (below the smallest fillet radius), or shell BEFORE filleting.' +
      (stars === 0
        ? ''
        : ` The solid carries ${stars} corner-star faces (setback corners): the sealed shell of fine ones (36 poles per direction or more) is refused by the kernel as [SHL_STAR_FACES] before the offset; open the shell at a face (openFacesNear) instead.`)
    );
  }
  return (
    `${command}: the kernel could not round these edges into a valid solid (returned null: size too large ` +
    'for a neighbouring face, or a blend meeting a tangent face; a recipe with per-edge radii also needs a kernel that reads them); ' +
    'document unchanged. Try a smaller size, fewer edges per call, or build the round from sketch arcs + booleans.'
  );
}
