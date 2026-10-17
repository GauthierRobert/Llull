/** Guard of the material-model commands: a record imported from a library is read-only (MAT_RECORD_READONLY), as for set_material_property. */

import type { CadDocument, Material } from '../../model/types';
import type { CommandResult } from '../types';
import { refuseMaterial } from '../materials/refusal';

/** The refusal when `material` is a library record, else null. */
export function libraryRecordRefusal(doc: CadDocument, command: string, materialId: string, material: Material): CommandResult | null {
  const libraryRef = material.record?.libraryRef;
  return libraryRef === undefined
    ? null
    : refuseMaterial(doc, command, 'MAT_RECORD_READONLY', `'${materialId}' comes from library '${libraryRef.libraryId}'`, {
        ids: [materialId],
        path: 'material',
      });
}
