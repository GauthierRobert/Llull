/** Imported solids as document bodies (aerospace 01 TR-KRN-21, 04 XCH): healed B-rep blob + `brep` leaf mesh entity, shared by the STEP and IGES imports. */

import type { CadDocument, DocumentBlob, Entity, ShapeRecipe } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import type { ImportedShapes, ImportedSolid } from '../../geometry/kernelPorts';
import { nextId } from '../../lib/id';
import { makeBlob } from '../../model/blobs';
import { MM_PER_UNIT } from '../../model/units';
import { newEntity } from '../entity/newEntity';
import { evaluateRecipe } from '../kernelShape';
import { DEFAULT_MESH_COLOR } from './importMesh';

export interface Body {
  readonly entity: Entity;
  readonly blob: DocumentBlob;
  readonly solid: ImportedSolid;
}

/** Recipe leaf of a stored healed solid, scaled from the kernel's millimetres into the document unit. */
function bodyRecipe(doc: CadDocument, blob: string): ShapeRecipe {
  const leaf: ShapeRecipe = { op: 'brep', blob, format: 'occt-brep-v1' };
  const factor = 1 / MM_PER_UNIT[doc.units];
  return factor === 1 ? leaf : { op: 'scale', source: leaf, factor };
}

/**
 * Entities of the imported solids (a given `name` overrides the names of the file; several solids get a numeric suffix), or the index of the first
 * solid the kernel cannot rebuild from its stored text.
 */
export function buildBodies(doc: CadDocument, kernel: GeometryKernel, imported: ImportedShapes, name: string | undefined): Body[] | number {
  const bodies: Body[] = [];
  for (const [index, solid] of imported.solids.entries()) {
    const blob = makeBlob('model/x-occt-brep', solid.brep);
    kernel.loadBlob?.(blob.sha256, solid.brep);
    const result = evaluateRecipe(kernel, bodyRecipe(doc, blob.sha256));
    if (typeof result === 'string') return index;
    const label = name !== undefined && imported.solids.length > 1 ? `${name} ${index + 1}` : (name ?? solid.name);
    const entity = newEntity(
      'mesh',
      nextId('mesh'),
      { mesh: result.mesh, brep: result.recipe },
      [0, 0, 0],
      solid.color !== undefined && solid.color !== '' ? solid.color : DEFAULT_MESH_COLOR,
      { name: label === undefined || label === '' ? undefined : label },
    );
    bodies.push({ entity, blob, solid });
  }
  return bodies;
}
