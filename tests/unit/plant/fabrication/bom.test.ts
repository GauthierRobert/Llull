/** Plant 05 ISO M2: the piping BOM and bolting (VC-ISO-08, VC-ISO-09): rows = MATERIALS totals = cut-list centreline sum, spools add up to the line. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { fixturePcf } from './fabricationFixtures';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { loadedL101 } from './isoM2Fixtures';

interface Row {
  itemCode: string;
  type: string;
  description?: string;
  quantity: number;
  unit: string;
  unverified?: true;
}
interface BomData {
  rows: Row[];
  bolting?: {
    joints: number;
    gaskets: number;
    studBolts: number;
    diameter: string | null;
    groups: Array<{ dn: number; pressureClass: number; boltsPerSet: number; boltDiameterIn: string; sets: number }>;
    unresolved: string[];
  };
  withoutItemCode: string[];
  warnings: Array<{ code: string }>;
  provenance: { catalogue: string; sources: string[] };
}

const bom = (doc: ReturnType<typeof loadedL101>, params: Record<string, unknown>): BomData => data<BomData>(doc, 'piping_bom', params);

describe('VC-ISO-08: line BOM', () => {
  const doc = loadedL101();
  const result = bom(doc, { scope: 'line', lineId: 'L-101' });

  it('13.045 m pipe, 3 weld-neck flanges, 3 elbows, 1 tee, in first-use order, with the MATERIALS descriptions', () => {
    expect(result.rows.map((row) => [row.itemCode, row.quantity, row.unit])).toEqual([
      ['FLWN-100-150', 3, 'ea'],
      ['PIPE-100-S40', 13.045, 'm'],
      ['ELL90LR-100-S40', 3, 'ea'],
      ['TEE-100-S40', 1, 'ea'],
    ]);
    expect(result.rows[1]?.description).toContain('PIPE, SMLS, DN100');
    expect(result.provenance.sources).toEqual(['pcf']);
    expect(result.provenance.catalogue).toContain('ASME B16.5');
  });

  it('equals the import preview BOM and the cut-list centreline sum', () => {
    const preview = data<{ bom: Array<{ itemCode: string; count: number; lengthMm?: number }> }>(createEmptyDocument(), 'import_pcf', {
      text: fixturePcf(),
      preview: true,
    });
    const pipe = preview.bom.find((row) => row.itemCode === 'PIPE-100-S40');
    expect(result.rows[1]?.quantity).toBeCloseTo((pipe?.lengthMm ?? 0) / 1000, 9);
    const cut = data<{ centrelineTotalMm: number }>(doc, 'cut_list', { lineId: 'L-101', weldGapMm: 3 });
    expect(result.rows[1]?.quantity).toBeCloseTo(cut.centrelineTotalMm / 1000, 9);
  });

  it('the spool BOMs add up to the line BOM; the document BOM of one line equals the line BOM', () => {
    const sum = new Map<string, number>();
    for (const spool of ['L-101-SP01', 'L-101-SP02'])
      for (const row of bom(doc, { scope: 'spool', lineId: 'L-101', spoolId: spool }).rows)
        sum.set(row.itemCode, (sum.get(row.itemCode) ?? 0) + row.quantity);
    for (const row of result.rows) expect(sum.get(row.itemCode)).toBeCloseTo(row.quantity, 9);
    expect(bom(doc, { scope: 'document' }).rows).toEqual(result.rows);
  });

  it('a component without an item code is left out and warned (ISO_ITEM_CODE_MISSING)', () => {
    const stripped = loadedL101(fixturePcf().replace('    ITEM-CODE TEE-100-S40\n', ''));
    const partial = bom(stripped, { scope: 'line', lineId: 'L-101' });
    expect(partial.rows.map((row) => row.itemCode)).not.toContain('TEE-100-S40');
    expect(partial.withoutItemCode).toHaveLength(1);
    expect(partial.warnings.map((warning) => warning.code)).toEqual(['ISO_ITEM_CODE_MISSING']);
  });

  it('the unverified flag of a catalogue row is inherited by the row', () => {
    const doc2 = loadedL101();
    const stored = doc2.plant?.fabrication?.pcfLines['L-101'];
    expect(stored).toBeDefined();
    const flagged = {
      ...doc2,
      plant: {
        ...doc2.plant,
        fabrication: {
          version: 1 as const,
          pcfLines: {
            'L-101': {
              ...(stored as NonNullable<typeof stored>),
              components: (stored as NonNullable<typeof stored>).components.map((component) =>
                component.type === 'TEE' ? { ...component, unverified: true as const } : component,
              ),
            },
          },
        },
      },
    };
    const rows = bom(flagged, { scope: 'line', lineId: 'L-101' }).rows;
    expect(rows.find((row) => row.itemCode === 'TEE-100-S40')?.unverified).toBe(true);
    expect(rows.find((row) => row.itemCode === 'PIPE-100-S40')?.unverified).toBeUndefined();
  });
});

describe('VC-ISO-09: bolting', () => {
  const doc = loadedL101();

  it('3 flanged ends, mating flanges assumed in scope: 3 gaskets, 24 studs 5/8 in (8 per class 150 NPS 4 joint)', () => {
    const result = bom(doc, { scope: 'line', lineId: 'L-101', includeBolting: true, matingFlanges: 'assume_in_scope' });
    expect(result.bolting).toMatchObject({ joints: 3, gaskets: 3, studBolts: 24, diameter: '5/8', unresolved: [] });
    expect(result.bolting?.groups).toEqual([
      { dn: 100, pressureClass: 150, boltsPerSet: 8, boltDiameterIn: '5/8', sets: 3, unverified: false },
    ]);
  });

  it('this side only (the default) counts no joint: the flanges have no mate in the line', () => {
    expect(bom(doc, { scope: 'line', lineId: 'L-101', includeBolting: true }).bolting).toMatchObject({
      joints: 0,
      gaskets: 0,
      studBolts: 0,
      diameter: null,
    });
    expect(bom(doc, { scope: 'line', lineId: 'L-101' }).bolting).toBeUndefined();
  });

  it('a spool carries the bolting of its own flanges: the two spools sum to the line', () => {
    const joints = ['L-101-SP01', 'L-101-SP02'].map(
      (spool) =>
        bom(doc, { scope: 'spool', lineId: 'L-101', spoolId: spool, includeBolting: true, matingFlanges: 'assume_in_scope' }).bolting
          ?.joints,
    );
    expect(joints).toEqual([1, 2]);
  });

  it('a flange whose class is not in the item code is reported unresolved (counted as a joint, no studs)', () => {
    const unnamed = loadedL101(fixturePcf().replaceAll('FLWN-100-150', 'FLWN-100'));
    const result = bom(unnamed, { scope: 'line', lineId: 'L-101', includeBolting: true, matingFlanges: 'assume_in_scope' });
    expect(result.bolting).toMatchObject({ joints: 3, gaskets: 3, studBolts: 0 });
    expect(result.bolting?.unresolved).toHaveLength(3);
    expect(result.warnings.map((warning) => warning.code)).toContain('ISO_BOLTING_UNRESOLVED');
  });

  it('class 300 reads its own row (8 x 3/4)', () => {
    const class300 = loadedL101(fixturePcf().replaceAll('FLWN-100-150', 'FLWN-100-300'));
    const result = bom(class300, { scope: 'line', lineId: 'L-101', includeBolting: true, matingFlanges: 'assume_in_scope' });
    expect(result.bolting).toMatchObject({ studBolts: 24, diameter: '3/4' });
    expect(result.bolting?.groups[0]).toMatchObject({ pressureClass: 300, unverified: false });
  });
});

describe('refusals and purity', () => {
  const doc = loadedL101();

  it('scope without its line or spool, unknown line, unknown spool, empty document', () => {
    expectRefusal(doc, 'piping_bom', { scope: 'line' }, 'ISO_PARAM_INVALID');
    expectRefusal(doc, 'piping_bom', { scope: 'spool', lineId: 'L-101' }, 'ISO_PARAM_INVALID');
    expectRefusal(doc, 'piping_bom', { scope: 'line', lineId: 'NOPE' }, 'ISO_LINE_NOT_FOUND');
    expectRefusal(doc, 'piping_bom', { scope: 'spool', lineId: 'L-101', spoolId: 'X' }, 'ISO_SPOOL_NOT_FOUND', 'spoolId');
    expectRefusal(createEmptyDocument(), 'piping_bom', { scope: 'document' }, 'ISO_NO_PIPING');
  });

  it('is a query; two lines add up in the document scope', () => {
    expect(execute(doc, 'piping_bom', { scope: 'line', lineId: 'L-101' }).document).toBe(doc);
    const two = apply(doc, 'import_pcf', { text: fixturePcf(), lineIdOverride: 'L-102' });
    const rows = bom(two, { scope: 'document' }).rows;
    expect(rows.find((row) => row.itemCode === 'PIPE-100-S40')?.quantity).toBeCloseTo(26.09, 9);
    expect(rows.find((row) => row.itemCode === 'TEE-100-S40')?.quantity).toBe(2);
  });
});
