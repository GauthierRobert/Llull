/** GATE-UID: the human signature of an export-controlled export and of lowering an export marking is bound to the document (VIS-ID). */
import { describe, it } from 'vitest';
import type { GeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { expectBoundToDocument } from '../../helpers/documentBinding';
import { boxOf, libraryFile, mmDocument, step } from './support';

const itar = { regime: 'ITAR' };
const record = { id: 'secret', designation: 'X', specs: [], licence: 'company-proprietary', exportMarking: itar };

describe('a signature of a material human gate does not verify in a copy of the document', () => {
  it('export_stl of ITAR content (MAT_HUMAN_GATE)', () => {
    const { doc } = boxOf(step(mmDocument(), 'define_material_record', record), 'secret');
    expectBoundToDocument(
      doc,
      (document, confirmExportControlled, ctx) =>
        execute(document, 'export_stl', { confirmExportControlled }, { ...ctx, kernel: {} as unknown as GeometryKernel }),
      'MAT_HUMAN_GATE',
    );
  });

  it('set_export_marking lowering a marking (MAT_HUMAN_GATE)', () => {
    const { doc } = boxOf(step(mmDocument(), 'define_material_record', record), 'secret');
    expectBoundToDocument(
      doc,
      (document, confirmation, ctx) =>
        execute(document, 'set_export_marking', { material: 'secret', marking: { regime: 'none' }, confirmation }, ctx),
      'MAT_HUMAN_GATE',
    );
  });

  it('import_material_library lowering the marking of a record (MAT_HUMAN_GATE)', () => {
    const doc = step(mmDocument(), 'import_material_library', { library: libraryFile({ marking: itar }) });
    const file = libraryFile({ version: '2', marking: { regime: 'none' } });
    const materials = (file['materials'] as Record<string, unknown>[]).map((material) => ({
      ...material,
      exportMarking: { regime: 'none' },
    }));
    expectBoundToDocument(
      doc,
      (document, confirmation, ctx) =>
        execute(document, 'import_material_library', { library: { ...file, materials }, replace: true, confirmation }, ctx),
      'MAT_HUMAN_GATE',
    );
  });
});
