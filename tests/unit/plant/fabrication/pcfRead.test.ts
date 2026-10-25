/**
 * Plant 05 ISO M1: the PCF lexer / reader (VC-ISO-01, VC-ISO-02) and `import_pcf`: counts and lengths of the authored fixture, unit scaling, syntax
 * refusals with their `line N` path, unknown records kept, preview vs stored, line id handling.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { MAX_PCF_CHARS, lexPcf } from '@aec/plant/fabrication/pcf/pcfLexer';
import { readPcf } from '@aec/plant/fabrication/pcf/pcfRead';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { fixturePcf, withLine } from './fabricationFixtures';

interface Imported {
  lineId: string;
  units: { bore: string; coords: string };
  componentCount: number;
  countsByType: Record<string, number>;
  totalPipeLengthMm: number;
  pipeLengthsMm: number[];
  bom: Array<{ itemCode: string; description?: string; count: number; lengthMm?: number }>;
  withoutItemCode: number;
  unknownRecords: Array<{ type: string; line: number }>;
  warnings: Array<{ code: string; severity: string }>;
  stored: boolean;
}

const doc = createEmptyDocument();
const preview = (text: string): Imported => data<Imported>(doc, 'import_pcf', { text, preview: true });

describe('import_pcf preview: the authored fixture (VC-ISO-01)', () => {
  it('15 components, 13045 mm of pipe in 7 pieces, the header units and the pipeline reference', () => {
    const result = preview(fixturePcf());
    expect(result.lineId).toBe('L-101');
    expect(result.units).toMatchObject({ bore: 'MM', coords: 'MM' });
    expect(result.componentCount).toBe(15);
    expect(result.countsByType).toEqual({ FLANGE: 3, PIPE: 7, WELD: 1, ELBOW: 3, TEE: 1 });
    expect(result.pipeLengthsMm).toEqual([2424, 2348, 3696, 1696, 1848, 714, 319]);
    expect(result.totalPipeLengthMm).toBeCloseTo(13045, 6);
    expect(result.stored).toBe(false);
    expect(result.unknownRecords).toEqual([]);
  });

  it('the BOM joins ITEM-CODE to the MATERIALS description; pipe rows carry their length; the WELD has no item code', () => {
    const result = preview(fixturePcf());
    expect(result.withoutItemCode).toBe(1);
    const pipe = result.bom.find((row) => row.itemCode === 'PIPE-100-S40');
    expect(pipe).toMatchObject({ count: 7 });
    expect(pipe?.lengthMm).toBeCloseTo(13045, 6);
    expect(pipe?.description).toContain('PIPE, SMLS, DN100');
    expect(result.bom.find((row) => row.itemCode === 'FLWN-100-150')?.count).toBe(3);
    expect(result.bom.find((row) => row.itemCode === 'ELL90LR-100-S40')?.count).toBe(3);
    expect(result.bom.find((row) => row.itemCode === 'TEE-100-S40')?.count).toBe(1);
  });

  it('does not change the document, and is pure', () => {
    const result = execute(doc, 'import_pcf', { text: fixturePcf(), preview: true });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expectPure(doc, () => execute(doc, 'import_pcf', { text: fixturePcf(), preview: true }));
  });

  it('reads the components: ids, flow order, points, SKEY, weld kind and category', () => {
    const read = readPcf(fixturePcf());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const [flange, pipe, weld, , elbow, , , , , , tee] = read.file.components;
    expect(flange).toMatchObject({ id: 'pcf:L-101:1', type: 'FLANGE', skey: 'FLWN', itemCode: 'FLWN-100-150' });
    expect(flange?.ends).toEqual([
      { xyz: [0, 0, 3000], boreMm: 100, endType: 'FL' },
      { xyz: [76, 0, 3000], boreMm: 100, endType: 'BW' },
    ]);
    expect(pipe?.skey).toBeUndefined();
    expect(weld).toMatchObject({ type: 'WELD', skey: 'WS', weldKind: 'site', category: 'erection' });
    expect(elbow).toMatchObject({ type: 'ELBOW', centre: [5000, 0, 3000], skey: 'ELBW' });
    expect(tee).toMatchObject({ type: 'TEE', centre: [7105, 4000, 1000], branch: { xyz: [7105, 4000, 1105], boreMm: 100, endType: 'BW' } });
    expect(read.file.attributes).toEqual({ 'PIPING-SPEC': 'A1A', 'PROJECT-IDENTIFIER': 'LLULL-ISO-VAL', AREA: 'U100', REVISION: '0' });
    expect(read.file.materials).toHaveLength(4);
  });

  it('accepts CRLF line ends and a byte order mark', () => {
    const crlf = String.fromCharCode(0xfeff) + fixturePcf().replace(/\n/g, '\r\n');
    expect(preview(crlf).totalPipeLengthMm).toBeCloseTo(13045, 6);
  });
});

describe('units (AF-04)', () => {
  const inchFile = [
    'ISOGEN-FILES ISOGEN.FLS',
    'UNITS-BORE INCH',
    'UNITS-CO-ORDS INCH',
    'PIPELINE-REFERENCE IN-1',
    'PIPE',
    '    COMPONENT-IDENTIFIER 1',
    '    END-POINT 0 0 10 4 BW',
    '    END-POINT 100 0 10 4 BW',
    '',
  ].join('\n');

  it('inch coordinates and bores are scaled to mm, the declared units are reported', () => {
    const read = readPcf(inchFile);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.units).toMatchObject({ bore: 'INCH', coords: 'INCH' });
    expect(read.file.components[0]?.ends).toEqual([
      { xyz: [0, 0, 254], boreMm: 100, endType: 'BW' },
      { xyz: [2540, 0, 254], boreMm: 100, endType: 'BW' },
    ]);
    expect(preview(inchFile).totalPipeLengthMm).toBeCloseTo(2540, 6);
  });

  it('a bad unit word is a record error naming its line', () => {
    expectRefusal(
      doc,
      'import_pcf',
      { text: inchFile.replace('UNITS-BORE INCH', 'UNITS-BORE FURLONG') },
      'ISO_PCF_RECORD_INVALID',
      'line 2',
    );
  });
});

describe('syntax refusals (VC-ISO-02): stable code, line path, document unchanged', () => {
  const base = fixturePcf();

  it('TAB on line 14', () => {
    const result = expectRefusal(
      doc,
      'import_pcf',
      { text: withLine(base, 14, '\t    END-POINT 0.0 0.0 3000.0 100 FL') },
      'ISO_PCF_TAB',
      'line 14',
    );
    expect(result.error?.paths).toEqual(['line 14']);
  });

  it('a 1025-character line', () => {
    expectRefusal(doc, 'import_pcf', { text: withLine(base, 11, `    REVISION ${'x'.repeat(1012)}`) }, 'ISO_PCF_LINE_TOO_LONG', 'line 11');
    expect(readPcf(withLine(base, 11, `    REVISION ${'x'.repeat(1011)}`)).ok).toBe(true);
  });

  it('first line is not ISOGEN-FILES', () => {
    expectRefusal(doc, 'import_pcf', { text: withLine(base, 1, 'PIPELINE-REFERENCE L-101') }, 'ISO_PCF_HEADER', 'line 1');
    expectRefusal(doc, 'import_pcf', { text: '' }, 'ISO_PCF_HEADER', 'line 1');
    expectRefusal(doc, 'import_pcf', { text: `\n\n${withLine(base, 1, '    ISOGEN-FILES x')}` }, 'ISO_PCF_HEADER', 'line 3');
  });

  it('END-POINT with two numbers (line 15)', () => {
    expectRefusal(doc, 'import_pcf', { text: withLine(base, 15, '    END-POINT 76.0 0.0') }, 'ISO_PCF_RECORD_INVALID', 'line 15');
  });

  it('UNITS-CO-ORDS missing (and UNITS-BORE missing)', () => {
    expectRefusal(doc, 'import_pcf', { text: withLine(base, 3, null) }, 'ISO_PCF_UNITS_MISSING', 'UNITS-CO-ORDS');
    expectRefusal(doc, 'import_pcf', { text: withLine(base, 2, null) }, 'ISO_PCF_UNITS_MISSING', 'UNITS-BORE');
  });

  it('input size caps', () => {
    expect(lexPcf(`ISOGEN-FILES x\n${'a'.repeat(MAX_PCF_CHARS)}`)).toMatchObject({ ok: false, code: 'ISO_PCF_TOO_LARGE' });
    expect(lexPcf(`ISOGEN-FILES x${'\n'.repeat(200_001)}`)).toMatchObject({ ok: false, code: 'ISO_PCF_TOO_LARGE' });
  });

  it.each([
    ['a non-numeric coordinate', (t: string) => withLine(t, 14, '    END-POINT 0.0 abc 3000.0 100 FL')],
    ['a point with a stray token', (t: string) => withLine(t, 14, '    END-POINT 0.0 0.0 3000.0 100 FL extra')],
    ['a CENTRE-POINT with two numbers', (t: string) => withLine(t, 38, '    CENTRE-POINT 5000.0 0.0')],
    ['a PIPE with one END-POINT', (t: string) => withLine(t, 21, null)],
    ['a third END-POINT', (t: string) => withLine(t, 15, '    END-POINT 76.0 0.0 3000.0 100 BW\n    END-POINT 1 2 3 100 BW')],
    ['a duplicated attribute', (t: string) => withLine(t, 16, '    SKEY FLWN\n    SKEY FLWN')],
    ['a second PIPELINE-REFERENCE', (t: string) => `${t}PIPELINE-REFERENCE L-102\n`],
    ['an attribute outside a record', (t: string) => t.replace('UNITS-BORE MM', '    STRAY x\nUNITS-BORE MM')],
    ['a record before PIPELINE-REFERENCE', (t: string) => t.replace('UNITS-BORE MM', 'FLANGE\nUNITS-BORE MM')],
    [
      'a duplicated component id',
      (t: string) =>
        t
          .replace('    COMPONENT-IDENTIFIER 1', '    UNIQUE-COMPONENT-IDENTIFIER a')
          .replace('    COMPONENT-IDENTIFIER 2', '    UNIQUE-COMPONENT-IDENTIFIER a'),
    ],
    ['an empty PIPELINE-REFERENCE', (t: string) => withLine(t, 7, 'PIPELINE-REFERENCE')],
    ['an empty ITEM-CODE in MATERIALS', (t: string) => t.replace('\nITEM-CODE PIPE-100-S40', '\nITEM-CODE')],
    ['a duplicated MATERIALS item', (t: string) => t.replace('\nITEM-CODE TEE-100-S40', '\nITEM-CODE PIPE-100-S40')],
    ['MATERIALS with an attribute', (t: string) => t.replace('\nMATERIALS\n', '\nMATERIALS\n    NOTE x\n')],
    ['a non-numeric WEIGHT', (t: string) => withLine(t, 17, '    WEIGHT heavy')],
  ] as const)('%s -> ISO_PCF_RECORD_INVALID', (_name, mutate) => {
    const result = execute(doc, 'import_pcf', { text: mutate(base) });
    expect(result.rejected, result.summary).toBe(true);
    expect(result.error?.code).toBe('ISO_PCF_RECORD_INVALID');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.error?.paths[0]).toMatch(/^line \d+$/);
  });

  it('a file without PIPELINE-REFERENCE', () => {
    expectRefusal(doc, 'import_pcf', { text: base.split('\n').slice(0, 6).join('\n') }, 'ISO_PCF_RECORD_INVALID');
  });
});

describe('unknown records and attributes are kept, not dropped', () => {
  it('the unknown record is listed with its line and warned; unknown component attributes stay in extra', () => {
    const result = preview(withLine(fixturePcf(), 12, 'MESSAGE-SQUARE\n    TEXT hello  world\nFLANGE'));
    expect(result.unknownRecords).toEqual([{ type: 'MESSAGE-SQUARE', line: 12 }]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['ISO_PCF_UNKNOWN_RECORD']);
    const withAttribute = readPcf(withLine(fixturePcf(), 16, '    SKEY FLWN\n    COMPONENT-ATTRIBUTE1 12.5\n    SPECIAL-FLAG'));
    expect(withAttribute.ok && withAttribute.file.components[0]?.extra).toEqual({ 'COMPONENT-ATTRIBUTE1': '12.5', 'SPECIAL-FLAG': '' });
  });
});

describe('import_pcf: stored line, ids', () => {
  it('stores the line under its PIPELINE-REFERENCE, affected = [lineId], a second import of it is refused', () => {
    const result = execute(doc, 'import_pcf', { text: fixturePcf() });
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toEqual(['L-101']);
    expect(result.document.plant?.fabrication?.pcfLines['L-101']?.components).toHaveLength(15);
    expect((result.data as Imported).stored).toBe(true);
    expectPure(doc, () => execute(doc, 'import_pcf', { text: fixturePcf() }));
    expectRefusal(result.document, 'import_pcf', { text: fixturePcf() }, 'ISO_PCF_LINE_EXISTS', 'PIPELINE-REFERENCE');
  });

  it('lineIdOverride stores a second copy; preview of an id in use warns instead of refusing', () => {
    const first = apply(doc, 'import_pcf', { text: fixturePcf() });
    const second = apply(first, 'import_pcf', { text: fixturePcf(), lineIdOverride: 'L-101-B' });
    expect(Object.keys(second.plant?.fabrication?.pcfLines ?? {})).toEqual(['L-101', 'L-101-B']);
    expectRefusal(first, 'import_pcf', { text: fixturePcf(), lineIdOverride: 'L-101' }, 'ISO_PCF_LINE_EXISTS', 'lineIdOverride');
    const again = data<Imported>(first, 'import_pcf', { text: fixturePcf(), preview: true });
    expect(again.warnings.map((warning) => warning.code)).toContain('ISO_PCF_LINE_EXISTS');
  });

  it('a refusal changes nothing: same document object, nothing affected', () => {
    expectRefusal(doc, 'import_pcf', { text: 'not a pcf' }, 'ISO_PCF_HEADER');
  });
});

describe('delete_pcf_line', () => {
  const stored = apply(doc, 'import_pcf', { text: fixturePcf() });

  it('removes the imported line and frees its id', () => {
    const result = execute(stored, 'delete_pcf_line', { lineId: 'L-101' });
    expect(result.affected).toEqual(['L-101']);
    expect(result.document.plant?.fabrication?.pcfLines).toEqual({});
    expectPure(stored, () => execute(stored, 'delete_pcf_line', { lineId: 'L-101' }));
    expect(apply(result.document, 'import_pcf', { text: fixturePcf() }).plant?.fabrication?.pcfLines['L-101']).toBeDefined();
  });

  it('an unknown line is refused', () => {
    expectRefusal(stored, 'delete_pcf_line', { lineId: 'L-999' }, 'ISO_LINE_NOT_FOUND', 'lineId');
  });
});
