/** ISO-M6 (VC-ISO-22): weld_list format=csv is the weld map, row for row equal to the JSON list. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { loadedL101 } from './isoM2Fixtures';

interface Listed {
  welds: Array<{
    number: string;
    kind: string;
    field: boolean;
    numbered: boolean;
    spool: string | null;
    boreMm: number;
    endType: string;
    at: number[];
    componentIds: string[];
  }>;
  files?: Array<{ name: string; format: string; content: string; sha256: string }>;
}

const doc = apply(loadedL101(), 'number_welds', { lineId: 'L-101' });

describe('VC-ISO-22: weld map CSV', () => {
  it('has the header and 13 rows equal to the JSON list, in the same order', () => {
    const listed = data<Listed>(doc, 'weld_list', { lineId: 'L-101', format: 'csv' });
    const file = listed.files?.[0];
    expect(file).toMatchObject({ name: 'L-101_weld_map.csv', format: 'csv' });
    expect(file?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const lines = (file?.content ?? '').trimEnd().split('\n');
    expect(lines[0]).toBe('WELD,KIND,FIELD,NUMBERED,SPOOL,BORE_MM,END_TYPE,X_MM,Y_MM,Z_MM,COMPONENTS');
    expect(lines).toHaveLength(14);
    expect(listed.welds).toHaveLength(13);
    listed.welds.forEach((weld, index) => {
      expect(lines[index + 1]).toBe(
        [
          weld.number,
          weld.kind,
          weld.field,
          weld.numbered,
          weld.spool ?? '',
          weld.boreMm,
          weld.endType,
          ...weld.at,
          weld.componentIds.join(' '),
        ].join(','),
      );
    });
  });

  it('is deterministic, follows spoolId, and json (default) carries no file', () => {
    const again = data<Listed>(doc, 'weld_list', { lineId: 'L-101', format: 'csv' });
    expect(again.files?.[0]?.content).toBe(data<Listed>(doc, 'weld_list', { lineId: 'L-101', format: 'csv' }).files?.[0]?.content);
    const spool = data<Listed>(doc, 'weld_list', { lineId: 'L-101', format: 'csv', spoolId: 'L-101-SP01' });
    expect((spool.files?.[0]?.content ?? '').trimEnd().split('\n')).toHaveLength(spool.welds.length + 1);
    expect(data<Listed>(doc, 'weld_list', { lineId: 'L-101' }).files).toBeUndefined();
    expect(data<Listed>(doc, 'weld_list', { lineId: 'L-101', format: 'json' }).files).toBeUndefined();
  });

  it('is pure and refuses an unknown format, line or spool', () => {
    const before = JSON.stringify(doc);
    expect(execute(doc, 'weld_list', { lineId: 'L-101', format: 'csv' }).document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(execute(doc, 'weld_list', { lineId: 'L-101', format: 'xml' }).rejected).toBe(true);
    expectRefusal(doc, 'weld_list', { lineId: 'NOPE', format: 'csv' }, 'ISO_LINE_NOT_FOUND');
  });
});
