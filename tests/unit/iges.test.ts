/** SC-D4: IGES export (export_iges) and import (import_step_exact format "iges") through the kernel's exact exchange ports. */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type GeometryKernel, type ShapeHandle } from '@core/geometry/kernel';
import { CENSUS, fakeExactKernel, importedSolid } from '../helpers/fakeExactKernel';
import { expectPure } from '../helpers/expectNoOp';

afterEach(() => setGeometryKernel(null));

function igesKernel(write: (shapes: readonly ShapeHandle[]) => string | null): { written: number[] } {
  const written: number[] = [];
  const { kernel } = fakeExactKernel();
  setGeometryKernel({
    ...kernel,
    exportIges: (shapes) => {
      written.push(shapes.length);
      return write(shapes);
    },
  } as GeometryKernel);
  return { written };
}

describe('export_iges', () => {
  it('writes every 3D solid of the document as one IGES text with a suggested file name', () => {
    const { written } = igesKernel(() => 'IGES TEXT');
    const a = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const b = execute(a.document, 'add_cylinder', { radius: 1, height: 2 });
    const exported = execute(b.document, 'export_iges', {});
    expect(written).toEqual([2]);
    expect(exported.data).toMatchObject({ format: 'iges', text: 'IGES TEXT', fileName: 'model.igs', solidCount: 2 });
    expect(exported.document).toBe(b.document);
  });

  it('refuses without an IGES writer, without solids, and when the kernel refuses the solids', () => {
    const { kernel } = fakeExactKernel();
    setGeometryKernel(kernel);
    const box = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    expect(execute(box.document, 'export_iges', {}).summary).toMatch(/cannot write IGES/);
    igesKernel(() => null);
    expect(execute(createEmptyDocument(), 'export_iges', {}).summary).toMatch(/no 3D solids/);
    expect(execute(box.document, 'export_iges', {}).summary).toMatch(/refused/);
  });

  it('is pure', () => {
    igesKernel(() => 'IGES');
    const box = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    expectPure(box.document, () => execute(box.document, 'export_iges', {}));
  });
});

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
