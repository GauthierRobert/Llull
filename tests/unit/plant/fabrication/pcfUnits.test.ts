/**
 * Plant 05 ISO M1 review fixes: declared units survive a round trip (inch files, inch bolt units on a metric file), an inch bore is the nominal NPS,
 * verbatim content blocks a unit change, unknown records after MATERIALS keep their place, WEIGHT keeps its header unit.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { readPcf } from '@aec/plant/fabrication/pcf/pcfRead';
import { boreFromMm, boreToMm } from '@aec/plant/fabrication/pcf/pcfUnits';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { fixturePcf } from './fabricationFixtures';

const INCH_FILE = [
  'ISOGEN-FILES ISOGEN.FLS',
  'UNITS-BORE INCH',
  'UNITS-CO-ORDS INCH',
  'UNITS-WEIGHT LBS',
  'UNITS-BOLT-DIA INCH',
  'UNITS-BOLT-LENGTH INCH',
  'PIPELINE-REFERENCE IN-1',
  'PIPE',
  '    COMPONENT-IDENTIFIER 1',
  '    END-POINT 0.0000 0.0000 10.0000 4 BW',
  '    END-POINT 100.0000 0.0000 10.0000 4 BW',
  '    WEIGHT 27.5',
  'REDUCER-CONCENTRIC',
  '    COMPONENT-IDENTIFIER 2',
  '    END-POINT 100.0000 0.0000 10.0000 4 BW',
  '    END-POINT 106.0000 0.0000 10.0000 0.75 BW',
  '    BOLT-DIA 0.625',
  '',
].join('\n');

const METRIC_INCH_BOLTS = [
  'ISOGEN-FILES ISOGEN.FLS',
  'UNITS-BORE MM',
  'UNITS-CO-ORDS MM',
  'UNITS-BOLT-DIA INCH',
  'UNITS-BOLT-LENGTH INCH',
  'PIPELINE-REFERENCE MB-1',
  'BOLT',
  '    COMPONENT-IDENTIFIER 1',
  '    BOLT-DIA 0.625',
  '    BOLT-LENGTH 3.5',
  '',
].join('\n');

const doc = createEmptyDocument();
const exported = (stored: typeof doc, params: Record<string, unknown> = {}): string =>
  data<{ files: Array<{ content: string; units: unknown }> }>(stored, 'export_pcf', params).files[0]?.content ?? '';

describe('declared units are stored and written back', () => {
  it('an INCH file exports byte-equal by default, with the bore as the nominal size', () => {
    const read = readPcf(INCH_FILE);
    expect(read.ok && read.file.units).toEqual({ bore: 'INCH', coords: 'INCH', boltDia: 'INCH', boltLength: 'INCH' });
    expect(read.ok && read.file.components[0]?.ends[0]).toEqual({ xyz: [0, 0, 254], boreMm: 100, endType: 'BW' });
    expect(read.ok && read.file.components[1]?.ends[1]?.boreMm).toBe(20);
    expect(exported(apply(doc, 'import_pcf', { text: INCH_FILE }))).toBe(INCH_FILE);
  });

  it('a metric file with inch bolt units keeps them and its verbatim bolt attributes', () => {
    expect(exported(apply(doc, 'import_pcf', { text: METRIC_INCH_BOLTS }))).toBe(METRIC_INCH_BOLTS);
  });

  it('changing a declared unit under verbatim content is refused (ISO_PCF_UNITS_VERBATIM); without verbatim content it converts', () => {
    const inch = apply(doc, 'import_pcf', { text: INCH_FILE });
    expectRefusal(inch, 'export_pcf', { units: 'mm' }, 'ISO_PCF_UNITS_VERBATIM', 'units');
    const metric = apply(doc, 'import_pcf', { text: METRIC_INCH_BOLTS });
    expectRefusal(metric, 'export_pcf', { units: 'mm' }, 'ISO_PCF_UNITS_VERBATIM');
    const plain = apply(doc, 'import_pcf', { text: fixturePcf() });
    expect(exported(plain, { units: 'inch' })).toContain('UNITS-CO-ORDS INCH');
    expect(exported(plain, { units: 'mm' })).toBe(fixturePcf());
  });

  it('an unknown record converts nothing: it blocks a unit change as well', () => {
    const odd = apply(doc, 'import_pcf', { text: fixturePcf().replace('MATERIALS', 'NOTE-REC\n    TEXT 5\nMATERIALS') });
    expectRefusal(odd, 'export_pcf', { units: 'inch' }, 'ISO_PCF_UNITS_VERBATIM');
  });

  it('WEIGHT keeps the file unit (LBS here): the raw number is stored and written back', () => {
    const read = readPcf(INCH_FILE);
    expect(read.ok && read.file.components[0]?.weight).toBe(27.5);
    expect(read.ok && read.file.header['UNITS-WEIGHT']).toBe('LBS');
  });
});

describe('inch bore = nominal pipe size', () => {
  it('maps NPS <-> DN both ways, and flags a value that is no nominal size', () => {
    expect(boreToMm(4, 'INCH')).toEqual({ mm: 100, mapped: true });
    expect(boreToMm(2.5, 'INCH')).toEqual({ mm: 65, mapped: true });
    expect(boreToMm(100, 'MM')).toEqual({ mm: 100, mapped: true });
    expect(boreToMm(3.937, 'INCH').mapped).toBe(false);
    expect(boreFromMm(100, 'INCH')).toBe(4);
    expect(boreFromMm(20, 'INCH')).toBe(0.75);
    expect(boreFromMm(123, 'INCH')).toBeCloseTo(4.8425, 4);
    expect(boreFromMm(100.456, 'MM')).toBe(100.46);
  });

  it('an unmapped inch bore is converted by value and warned about', () => {
    const result = data<{ warnings: Array<{ code: string; paths: string[] }> }>(doc, 'import_pcf', {
      text: INCH_FILE.replace('0.75 BW', '0.8 BW'),
      preview: true,
    });
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'ISO_PCF_BORE_UNMAPPED', paths: ['line 16'] })]);
  });
});

describe('unknown records after MATERIALS', () => {
  it('stay after the block, byte-equal', () => {
    const text = `${fixturePcf()}TRAILER-REC\n    NOTE kept after the materials\n`;
    const read = readPcf(text);
    expect(read.ok && read.file.unknownRecords).toEqual([
      expect.objectContaining({ type: 'TRAILER-REC', afterMaterials: true, after: 15 }),
    ]);
    expect(exported(apply(doc, 'import_pcf', { text }))).toBe(text);
  });
});
