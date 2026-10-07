import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';

describe('export_elevation_sheet level datums', () => {
  it('labels a level named after its elevation once, and others by name + datum', () => {
    let doc = createEmptyDocument();
    for (const name of ['Ground floor', '+6.00']) {
      doc = execute(doc, 'add_level', { name, height: 6000 }).document;
    }
    doc = execute(doc, 'add_steel_member', {
      role: 'column',
      profile: 'HEB300',
      levelId: 'level-1',
      start: [0, 0, 0],
      end: [0, 0, 12000],
    }).document;
    const { svg } = execute(doc, 'export_elevation_sheet', { direction: 'south' }).data as {
      svg: string;
    };
    expect(svg).toContain('>Ground floor +0.000<');
    expect(svg).toContain('>+6.000<');
    expect(svg).not.toContain('+6.00 +6.000');
  });
});
