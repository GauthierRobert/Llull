import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { T, inWork } from './fixtures';
import { loadSample, run } from './scenarioRunner';

const svgOf = (doc: CadDocument): string => {
  const sheetId = doc.drawings?.order[0] ?? '';
  return (run(doc, 'export_sheet_svg', { sheetId }).data as { svg: string }).svg;
};

describe('title block projection (VC-PLM-03, 20)', () => {
  it('prints the managed part number, the revision with its state, and the export notice, without touching the sheet', () => {
    const drawn = run(loadSample(), 'create_sheet', { name: 'S1', views: ['front'], partNumber: 'OTHER', revision: 'Z' }).document;
    expect(svgOf(drawn)).toContain('OTHER');
    const managed = run(drawn, 'set_item_identity', {
      partNumber: 'LL-2001',
      name: 'n',
      itemType: 'part',
      policy: { humanSignatureRequired: false },
    }).document;
    const marked = run(managed, 'set_item_marking', {
      regime: 'EAR',
      classification: 'ECCN 9A610',
      statement: 'EXPORT CONTROLLED - EAR',
      decidedBy: 'u-3',
    }).document;
    const svg = svgOf(marked);
    expect(svg).toContain('LL-2001');
    expect(svg).not.toContain('OTHER');
    expect(svg).toContain('A (IN WORK)');
    expect(svg).toContain('id="export-marking"');
    expect(svg).toContain('EXPORT CONTROLLED - EAR');
    expect(marked.drawings?.sheets[marked.drawings.order[0] ?? '']?.titleBlock.partNumber).toBe('OTHER');
  });

  it('prints the plain label once released and no notice for a marking without statement', () => {
    const drawn = run(inWork(), 'create_sheet', { name: 'S1', views: ['front'] }).document;
    const review = run(drawn, 'submit_for_review', { at: T, by: 'u-1' }).document;
    const released = run(review, 'release_item', {
      approvals: [
        { role: 'design-authority', userId: 'u-1' },
        { role: 'checker', userId: 'u-2' },
      ],
      at: T,
      by: 'u-1',
    }).document;
    const svg = svgOf(released);
    expect(svg).toContain('A · —');
    expect(svg).not.toContain('IN WORK');
    expect(svg).not.toContain('export-marking');
  });
});
