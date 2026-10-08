import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('export_obj units label', () => {
  const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
  const objText = (units?: string): string =>
    (execute(doc, 'export_obj', units === undefined ? {} : { units }).data as { text: string })
      .text;

  it('embeds the label in the header comment', () => {
    expect(objText('cm').split('\n')[0]).toBe('# llull OBJ export — units: cm');
  });

  it('cannot inject extra OBJ records through a multi-line label', () => {
    const lines = objText('mm\nv 9 9 9\r\nf 1 2 3').split('\n');
    expect(lines[0]).toBe('# llull OBJ export — units: mm v 9 9 9 f 1 2 3');
    expect(lines).not.toContain('v 9 9 9');
    expect(lines[1]).toBe('o llull_export');
  });

  it('falls back to the document units for a blank label', () => {
    expect(objText('  \n ').split('\n')[0]).toBe(`# llull OBJ export — units: ${doc.units}`);
  });
});
