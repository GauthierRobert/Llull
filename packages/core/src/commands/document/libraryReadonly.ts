/** Guard of the material-model commands: a record imported from a library is read-only (MAT_RECORD_READONLY), as for set_material_property. */

import type { CadDocument, Material } from '../../model/types';
import type { CommandResult } from '../types';
import { refuseMaterial } from '../materials/refusal';

/** Rejection with a family's remediation table (`matlRefusal`, `refuseWith`). */
type Refuse = (doc: CadDocument, command: string, code: string, message: string, ids?: readonly string[], path?: string) => CommandResult;

/** The refusal when `material` is a library record, else null. */
function libraryRecordRefusal(doc: CadDocument, command: string, materialId: string, material: Material): CommandResult | null {
  const libraryRef = material.record?.libraryRef;
  return libraryRef === undefined
    ? null
    : refuseMaterial(doc, command, 'MAT_RECORD_READONLY', `'${materialId}' comes from library '${libraryRef.libraryId}'`, {
        ids: [materialId],
        path: 'material',
      });
}

/** The material `materialId` when it exists and is editable; else MAT_RECORD_NOT_FOUND (through `refuse`) or MAT_RECORD_READONLY. */
export function editableMaterial(
  doc: CadDocument,
  command: string,
  materialId: string,
  refuse: Refuse,
): { readonly material: Material } | { readonly refusal: CommandResult } {
  const material = Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  if (material === undefined)
    return { refusal: refuse(doc, command, 'MAT_RECORD_NOT_FOUND', `no material '${materialId}'`, [materialId], 'material') };
  const readonly = libraryRecordRefusal(doc, command, materialId, material);
  return readonly === null ? { material } : { refusal: readonly };
}
