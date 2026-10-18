import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { barDocument } from './deckFixtures';

interface Items {
  items: { code: string; severity: string; ids: string[]; message: string; remediation: string }[];
}

const withDensity = (doc: CadDocument, density: number): CadDocument => ({
  ...doc,
  materials: Object.fromEntries(Object.entries(doc.materials).map(([id, material]) => [id, { ...material, density }])),
});

const codes = (doc: CadDocument, analysisId: string): Items['items'] =>
  (execute(doc, 'check_analysis', { analysisId }).data as Items).items.filter((item) => item.code === 'FEA_DENSITY_IMPLAUSIBLE');

describe('check_analysis FEA_DENSITY_IMPLAUSIBLE', () => {
  it('warns when a part material density is 1000x off (kg/m^3 typed as g per document unit^3)', () => {
    const bar = barDocument();
    const [item] = codes(withDensity(bar.doc, 7.85), bar.analysisId);
    expect(item?.severity).toBe('warning');
    expect(item?.ids).toContain(bar.boxId);
    expect(item?.message).toMatch(/implausible/);
    expect(item?.remediation).toContain('densityUnit');
  });

  it('stays quiet for steel at 0.00785 g/mm^3 in a mm document', () => {
    const bar = barDocument();
    expect(codes(bar.doc, bar.analysisId)).toEqual([]);
  });
});
