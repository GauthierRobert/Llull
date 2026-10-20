/** SC-D4: IGES import through import_step_exact format "iges" (export_iges / import_iges are covered by exchange/igesCommands.test.ts). */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { CENSUS, fakeExactKernel, importedSolid } from '../helpers/fakeExactKernel';

afterEach(() => setGeometryKernel(null));

describe('import_step_exact format "iges"', () => {
  it('reads the file through the IGES importer and keeps the original as a model/iges blob', () => {
    const fake = fakeExactKernel({ imported: { solids: [importedSolid()], census: CENSUS, skipped: [] } });
    setGeometryKernel(fake.kernel);
    const imported = execute(createEmptyDocument(), 'import_step_exact', { text: 'IGES FILE', format: 'iges', keepOriginal: true });
    expect(fake.imports.at(-1)).toMatchObject({ format: 'iges', text: 'IGES FILE' });
    expect(imported.affected).toHaveLength(1);
    expect(Object.values(imported.document.blobs ?? {}).map((blob) => blob.mediaType)).toContain('model/iges');
  });

  it('defaults to STEP', () => {
    const fake = fakeExactKernel({ imported: { solids: [importedSolid()], census: CENSUS, skipped: [] } });
    setGeometryKernel(fake.kernel);
    execute(createEmptyDocument(), 'import_step_exact', { text: 'ISO-10303-21;' });
    expect(fake.imports.at(-1)?.format).toBe('step');
  });
});
