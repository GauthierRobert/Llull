/** Plant 05 ISO M2: spools (VC-ISO-06), limits and autoBreak, spool_list / split_spools refusals. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { loadedL101, refNumbers, withoutWeld } from './isoM2Fixtures';

interface Spool {
  name: string;
  lineId: string;
  componentIds: string[];
  lengthMm: number;
  boxMm: number[];
  weightKg: number;
  weightComplete: boolean;
  pieces: number;
  violations: Array<{ code: string }>;
}
interface SpoolData {
  spools: Spool[];
  count?: number;
  insertedWelds?: Array<{ weldId: string; at: number[] }>;
  breakAt?: string[];
}

const expected = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../../docs/plant/05-isometrics-fabrication/validation/data/iso-01-L101-dn100.expected.json'),
    'utf8',
  ),
) as { spools: Array<{ spool: string; components: string[] }> };

describe('VC-ISO-06: spools of the fixture', () => {
  const doc = loadedL101();

  it('split_spools at field welds and flanged joints gives the two reference spools (the WELD record is in none)', () => {
    const result = data<SpoolData>(doc, 'split_spools', { lineId: 'L-101', breakAt: ['field_welds', 'flanged_joints'] });
    expect(result.spools.map((spool) => spool.name)).toEqual(expected.spools.map((spool) => spool.spool));
    expect(result.spools.map((spool) => refNumbers(spool.componentIds))).toEqual(expected.spools.map((spool) => spool.components));
    expect(result.spools.map((spool) => spool.pieces)).toEqual([1, 6]);
  });

  it('spool_list reads the stored breaks; without the field-weld break the line is one spool', () => {
    const stored = apply(doc, 'split_spools', { lineId: 'L-101', breakAt: ['flanged_joints'] });
    expect(stored.plant?.fabrication?.spoolBreaks).toEqual({ 'L-101': ['flanged_joints'] });
    expect(data<SpoolData>(stored, 'spool_list', { lineId: 'L-101' }).count).toBe(1);
    expect(data<SpoolData>(doc, 'spool_list', { lineId: 'L-101' }).count).toBe(2);
    expect(data<SpoolData>(doc, 'spool_list', {}).spools).toHaveLength(2);
  });

  it('without the WELD record there is one spool holding every component', () => {
    const plain = loadedL101(withoutWeld());
    const spools = data<SpoolData>(plain, 'spool_list', { lineId: 'L-101' }).spools;
    expect(spools).toHaveLength(1);
    expect(spools[0]?.componentIds).toHaveLength(14);
  });

  it('metrics: longest path, sorted envelope, pieces; weight is incomplete without WEIGHT attributes', () => {
    const [first, second] = data<SpoolData>(doc, 'spool_list', { lineId: 'L-101' }).spools;
    expect(first).toMatchObject({ lengthMm: 2500, pieces: 1, weightKg: 0, weightComplete: false });
    expect(first?.boxMm).toEqual([2500 + 114.3, 114.3, 114.3].map((v) => Math.round(v * 10) / 10));
    expect(second?.pieces).toBe(6);
    expect(second?.lengthMm).toBeGreaterThan(10000);
    expect(second?.boxMm[0]).toBeGreaterThan(second?.boxMm[1] ?? 0);
  });

  it('the spool prefix replaces the line number in the names', () => {
    const named = apply(doc, 'set_fabrication_rules', { source: 's', spoolPrefix: 'SPL' });
    expect(data<SpoolData>(named, 'spool_list', { lineId: 'L-101' }).spools.map((spool) => spool.name)).toEqual(['SPL-SP01', 'SPL-SP02']);
  });

  it('a field weld added with add_field_weld splits a spool (it is a site weld); a shop weld changed to site too', () => {
    const welded = apply(doc, 'add_field_weld', { lineId: 'L-101', at: [6000, 4000, 1000] });
    expect(data<SpoolData>(welded, 'spool_list', { lineId: 'L-101' }).count).toBe(3);
  });
});

describe('limits', () => {
  const doc = loadedL101();

  it('a limit that is exceeded refuses split_spools with its code, and lists the spools over it in spool_list', () => {
    const tight = apply(doc, 'set_fabrication_rules', {
      source: 'truck',
      maxSpoolLengthMm: 6000,
      maxSpoolWidthMm: 3000,
      maxSpoolHeightMm: 3000,
    });
    const refused = expectRefusal(tight, 'split_spools', { lineId: 'L-101' }, 'ISO_SPOOL_TOO_LARGE', 'lineId');
    expect(refused.error?.ids).toEqual(['L-101-SP02']);
    const listed = data<SpoolData>(tight, 'spool_list', { lineId: 'L-101' }).spools;
    expect(listed.map((spool) => spool.violations.length)).toEqual([0, 1]);
  });

  it('weight and piece limits give ISO_SPOOL_TOO_HEAVY and ISO_SPOOL_TOO_LARGE', () => {
    const pieces = apply(doc, 'set_fabrication_rules', { source: 's', maxSpoolPieces: 3 });
    expectRefusal(pieces, 'split_spools', { lineId: 'L-101' }, 'ISO_SPOOL_TOO_LARGE');
    const weighted = loadedL101(
      readFileSync(
        path.resolve(__dirname, '../../../../docs/plant/05-isometrics-fabrication/validation/data/iso-01-L101-dn100.pcf'),
        'utf8',
      )
        .replace(/\r\n/g, '\n')
        .replaceAll('    ITEM-CODE PIPE-100-S40\n', '    ITEM-CODE PIPE-100-S40\n    WEIGHT 100.0\n'),
    );
    const heavy = apply(weighted, 'set_fabrication_rules', { source: 's', maxSpoolWeightKg: 300 });
    const refused = expectRefusal(heavy, 'split_spools', { lineId: 'L-101' }, 'ISO_SPOOL_TOO_HEAVY');
    expect(refused.error?.ids).toEqual(['L-101-SP02']);
    expect(data<SpoolData>(weighted, 'spool_list', { lineId: 'L-101' }).spools[1]).toMatchObject({ weightKg: 600, weightComplete: false });
  });

  it('autoBreak inserts deterministic site welds until every spool fits, and reports them', () => {
    const tight = apply(doc, 'set_fabrication_rules', { source: 'truck', maxSpoolPieces: 3, minCutPieceMm: 100 });
    const result = ok(tight, 'split_spools', { lineId: 'L-101', autoBreak: true });
    const inserted = (result.data as SpoolData).insertedWelds ?? [];
    expect(inserted.length).toBeGreaterThanOrEqual(1);
    expect((result.data as SpoolData).spools.every((spool) => spool.pieces <= 3 && spool.violations.length === 0)).toBe(true);
    expect(result.affected).toEqual(['L-101', ...inserted.map((weld) => weld.weldId)]);
    expect(Object.keys(result.document.plant?.fabrication?.fieldWelds ?? {})).toEqual(inserted.map((weld) => weld.weldId));
    // deterministic: same positions on a second run of the same document
    const again = ok(tight, 'split_spools', { lineId: 'L-101', autoBreak: true });
    expect((again.data as SpoolData).insertedWelds?.map((weld) => weld.at)).toEqual(inserted.map((weld) => weld.at));
    // and the stored welds are real: spool_list sees the same spools
    expect(data<SpoolData>(result.document, 'spool_list', { lineId: 'L-101' }).count).toBe((result.data as SpoolData).spools.length);
  });

  it('autoBreak that cannot fit (a limit smaller than any pipe piece allows) refuses and leaves the document alone', () => {
    const impossible = apply(doc, 'set_fabrication_rules', {
      source: 's',
      maxSpoolLengthMm: 50,
      maxSpoolWidthMm: 50,
      maxSpoolHeightMm: 50,
    });
    expectRefusal(impossible, 'split_spools', { lineId: 'L-101', autoBreak: true }, 'ISO_SPOOL_TOO_LARGE');
  });

  it('an unlimited document splits nothing with autoBreak', () => {
    const result = ok(doc, 'split_spools', { lineId: 'L-101', autoBreak: true });
    expect((result.data as SpoolData).insertedWelds).toEqual([]);
  });
});

describe('refusals and purity', () => {
  const doc = loadedL101();

  it('unknown line, empty document, autoBreak without field_welds', () => {
    expectRefusal(doc, 'split_spools', { lineId: 'NOPE' }, 'ISO_LINE_NOT_FOUND');
    expectRefusal(doc, 'spool_list', { lineId: 'NOPE' }, 'ISO_LINE_NOT_FOUND');
    expectRefusal(createEmptyDocument(), 'spool_list', {}, 'ISO_NO_PIPING');
    expectRefusal(doc, 'split_spools', { lineId: 'L-101', autoBreak: true, breakAt: ['flanged_joints'] }, 'ISO_PARAM_INVALID', 'breakAt');
  });

  it('is pure: split_spools does not change its input; spool_list returns the same document', () => {
    const before = JSON.stringify(doc);
    execute(doc, 'split_spools', { lineId: 'L-101' });
    expect(JSON.stringify(doc)).toBe(before);
    expect(execute(doc, 'spool_list', {}).document).toBe(doc);
  });
});
