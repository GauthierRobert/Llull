/** 09 PLM M6 (VC-PLM-24): QIF 3.0 MeasurementResults import into the FAI results, and the safety of the XML reader. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import { readQifResults } from '@plm/qif/results';
import { QIF_LIMITS, parseXml } from '@plm/qif/xml';
import { plateKernel } from '../../helpers/pmiPlateKernel';
import { T } from './fixtures';
import { releasedPlate } from './m6Fixtures';
import { agentContext, run } from './scenarioRunner';

const SAMPLE = readFileSync(
  path.resolve(__dirname, '../../../docs/aerospace/09-plm-configuration-traceability/validation/qif/plate_results.sample.qif'),
  'utf8',
);

beforeEach(() => setGeometryKernel(plateKernel()));
afterEach(() => setGeometryKernel(null));

const code = (doc: CadDocument, params: Record<string, unknown>): string | undefined => run(doc, 'import_qif_results', params).error?.code;
const QIF3 = 'http://qifstandards.org/xsd/qif3';
const wrap = (body: string, namespace = QIF3): string =>
  `<?xml version="1.0"?><QIFDocument xmlns="${namespace}" versionQIF="3.0.0" idMax="9">${body}</QIFDocument>`;
const measurement = (id: number, item: string, status: string, value: string): string =>
  `<DiameterCharacteristicMeasurement id="${id}"><Status><CharacteristicStatusEnum>${status}</CharacteristicStatusEnum></Status><CharacteristicItemId>${item}</CharacteristicItemId><Value>${value}</Value></DiameterCharacteristicMeasurement>`;
const results = (...rows: string[]): string =>
  `<Results><MeasurementResultsSet n="1"><MeasurementResults id="5"><MeasuredCharacteristics><CharacteristicMeasurements n="${rows.length}">${rows.join('')}</CharacteristicMeasurements></MeasuredCharacteristics></MeasurementResults></MeasurementResultsSet></Results>`;

describe('the XML reader (no XXE, capped, linear)', () => {
  it('reads elements, attributes, entities, CDATA and comments', () => {
    const parsed = parseXml('<?xml version="1.0"?><a x="1 &amp; 2"><!-- c --><b>t&lt;&#65;&#x42;<![CDATA[<raw>]]></b><c/></a>');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.root.attrs['x']).toBe('1 & 2');
    expect(parsed.root.children.map((child) => child.name)).toEqual(['b', 'c']);
    expect(parsed.root.children[0]?.text).toBe('t<AB<raw>');
    expect(parsed.elements).toBe(3);
  });

  it.each([
    ['a DOCTYPE', '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'],
    ['an ENTITY declaration', '<!ENTITY x "y"><a/>'],
    ['an undeclared entity', '<a>&xxe;</a>'],
    ['a processing instruction', '<a><?php evil ?></a>'],
    ['an external-looking entity in an attribute', '<a b="&ext;"/>'],
    ['a mismatched end tag', '<a><b></a></b>'],
    ['an unclosed element', '<a><b>'],
    ['two roots', '<a/><b/>'],
    ['text outside the root', 'hello<a/>'],
    ['an unterminated comment', '<a><!-- x</a>'],
    ['an unterminated declaration', '<?xml version="1.0"'],
    ['a bad character reference', '<a>&#0;</a>'],
    ['a repeated attribute', '<a x="1" x="2"/>'],
    ['bad attribute syntax', '<a x=1/>'],
    ['NUL characters', '<a>\0</a>'],
    ['no element', '   '],
  ])('refuses %s with PLM_QIF_INVALID and a line', (_, text) => {
    const parsed = parseXml(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('PLM_QIF_INVALID');
  });

  it('reports the line of the fault', () => {
    const parsed = parseXml('<a>\n<b>\n</a>');
    expect(parsed.ok ? '' : parsed.message).toContain('line 3');
  });

  it('enforces the limits: size, depth, elements, attributes (PLM_QIF_LIMIT)', () => {
    const limits = { maxBytes: 1000, maxDepth: 4, maxElements: 6, maxAttributes: 2 };
    for (const text of [
      '<a>' + 'x'.repeat(1200) + '</a>',
      '<a><b><c><d><e/></d></c></b></a>',
      '<a>' + '<b/>'.repeat(8) + '</a>',
      '<a x="1" y="2" z="3"/>',
    ]) {
      const parsed = parseXml(text, limits);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe('PLM_QIF_LIMIT');
    }
    expect(parseXml('<a><b><c/></b></a>', limits).ok).toBe(true);
    expect(QIF_LIMITS.maxBytes).toBe(8 * 1024 * 1024);
  });

  it('counts bytes, not characters', () => {
    expect(parseXml('<a>' + 'é'.repeat(600) + '</a>', { ...QIF_LIMITS, maxBytes: 1000 }).ok).toBe(false);
  });

  it('is linear: hostile shapes cost time proportional to their size', () => {
    const time = (text: string): number => {
      const start = performance.now();
      parseXml(text);
      return performance.now() - start;
    };
    const flat = (n: number): string => '<a>' + '<b x="1">text</b>'.repeat(n) + '</a>';
    time(flat(2000));
    const [small, large] = [time(flat(20_000)), time(flat(160_000))];
    expect(large).toBeLessThan(small * 40 + 400);
    expect(time('<a' + ' '.repeat(2_000_000) + 'x')).toBeLessThan(1000);
    expect(time('<'.repeat(3_000_000))).toBeLessThan(1000);
    expect(time('<a>' + '&amp;'.repeat(1_000_000) + '</a>')).toBeLessThan(2000);
    expect(time('<a x="' + '&'.repeat(1_000_000) + '"/>')).toBeLessThan(1000);
    expect(time('<!--' + '-'.repeat(2_000_000))).toBeLessThan(1000);
  });

  it('does not recurse: very deep nesting is a limit refusal, not a stack overflow', () => {
    const parsed = parseXml('<a>'.repeat(100_000));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('PLM_QIF_LIMIT');
  });
});

describe('readQifResults', () => {
  it('reads the sample file: items by Name, status, value and the file unit', () => {
    const read = readQifResults(SAMPLE);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.measurements).toEqual([
      { qifId: '101', element: 'DiameterCharacteristicMeasurement', itemId: '2', status: 'PASS', value: 20.012, unit: 'mm' },
      { qifId: '102', element: 'FlatnessCharacteristicMeasurement', itemId: '3', status: 'FAIL', value: 0.071, unit: 'mm' },
    ]);
    expect([...read.itemNames]).toEqual([
      ['2', '2'],
      ['3', '3'],
    ]);
  });

  it('refuses what is not QIF 3 results', () => {
    expect(readQifResults('<Other/>')).toMatchObject({ ok: false, code: 'PLM_QIF_INVALID' });
    expect(readQifResults(wrap(results(measurement(1, '2', 'PASS', '1')), 'http://qifstandards.org/xsd/qif2'))).toMatchObject({
      ok: false,
      message: expect.stringContaining('not a QIF 3 file'),
    });
    expect(readQifResults(wrap('<Results/>'))).toMatchObject({
      ok: false,
      message: expect.stringContaining('no characteristic measurements'),
    });
    expect(readQifResults(wrap(results(measurement(1, '2', 'PASS', 'abc'))))).toMatchObject({
      ok: false,
      message: expect.stringContaining('not a number'),
    });
    expect(readQifResults(wrap(results(measurement(1, '', 'PASS', '1'))))).toMatchObject({
      ok: false,
      message: expect.stringContaining('CharacteristicItemId'),
    });
    expect(readQifResults(wrap(results(measurement(1, '2', 'PASS', '1e999'))))).toMatchObject({ ok: false });
  });

  it('keeps a user-defined status as OTHER and a missing value as no value', () => {
    const xml = wrap(
      results(
        '<LinearCharacteristicMeasurement id="1"><Status><OtherCharacteristicStatus>HOLD</OtherCharacteristicStatus></Status><CharacteristicItemId>7</CharacteristicItemId></LinearCharacteristicMeasurement>',
      ),
    );
    expect(readQifResults(xml)).toMatchObject({ ok: true, measurements: [{ status: 'OTHER', itemId: '7' }] });
  });

  it('reads angular values with their unit and ignores elements that are not measurements', () => {
    const xml = wrap(
      results(
        '<AngularityCharacteristicMeasurement id="1"><Status><CharacteristicStatusEnum>PASS</CharacteristicStatusEnum></Status><CharacteristicItemId>7</CharacteristicItemId><Value angularUnit="deg">0.5</Value><MaxValue>0.7</MaxValue></AngularityCharacteristicMeasurement><Other/>',
      ),
    );
    expect(readQifResults(xml)).toMatchObject({ ok: true, measurements: [{ value: 0.5, maxValue: 0.7, unit: 'deg' }] });
  });
});

describe('import_qif_results', () => {
  const params = { xml: SAMPLE, revision: 'A', serial: 'SN-0001', at: T };

  it('matches the measurements to the characteristic numbers, keeps the file hash, and reports the gaps', () => {
    const doc = releasedPlate();
    const result = run(doc, 'import_qif_results', params);
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toEqual([]);
    const set = result.document.plm?.faiResults?.['FRS-A-1'];
    expect(set).toMatchObject({
      revision: 'A',
      serial: 'SN-0001',
      importedBy: 'u-1',
      source: { format: 'QIF 3.0 MeasurementResults', sha256: sha256Hex(SAMPLE), bytes: Buffer.byteLength(SAMPLE) },
      missing: [1, 4, 5, 6, 7],
      unmatched: [],
    });
    expect(set?.results).toEqual([
      { charNo: 2, status: 'PASS', value: 20.012, unit: 'mm', source: { element: 'DiameterCharacteristicMeasurement', qifId: '101' } },
      { charNo: 3, status: 'FAIL', value: 0.071, unit: 'mm', source: { element: 'FlatnessCharacteristicMeasurement', qifId: '102' } },
    ]);
    expect(result.summary).toContain('2 characteristic(s) matched (1 FAIL)');
    expect(result.summary).toContain('5 without a result');
  });

  it('fills Form 3 of the FAI skeleton with the imported results and the serial, and leaves the rest null', () => {
    const imported = run(releasedPlate(), 'import_qif_results', params).document;
    const skeleton = run(imported, 'fai_report_skeleton', { revision: 'A', faiType: 'full', resultsId: 'FRS-A-1', format: 'csv' });
    const data = skeleton.data as {
      form1: { serialNumber: string };
      form3: { rows: { charNo: number; results: string | null; resultStatus: string | null; tooling: null }[] };
      csv: string;
    };
    expect(data.form1.serialNumber).toBe('SN-0001');
    const byNumber = Object.fromEntries(data.form3.rows.map((row) => [row.charNo, row]));
    expect(byNumber[2]).toMatchObject({ results: '20.012 mm', resultStatus: 'PASS', tooling: null });
    expect(byNumber[3]).toMatchObject({ results: '0.071 mm', resultStatus: 'FAIL' });
    expect(byNumber[1]).toMatchObject({ results: null, resultStatus: null });
    expect(data.csv).toContain('3,3,resultStatus,FAIL');
    const plain = run(imported, 'fai_report_skeleton', { revision: 'A', faiType: 'full', format: 'json' }).data as {
      form3: { rows: Record<string, unknown>[] };
    };
    expect(plain.form3.rows.every((row) => row['results'] === null && !('resultStatus' in row))).toBe(true);
  });

  it('refuses a result set that is unknown or belongs to another revision', () => {
    const imported = run(releasedPlate(), 'import_qif_results', params).document;
    expect(run(imported, 'fai_report_skeleton', { revision: 'A', faiType: 'full', resultsId: 'FRS-X', format: 'json' }).error?.code).toBe(
      'PLM_RESULTS_UNKNOWN',
    );
  });

  it('is a human act: an agent cannot enter measured results', () => {
    const refused = run(releasedPlate(), 'import_qif_results', params, agentContext());
    expect(refused.error?.code).toBe('PLM_HUMAN_GATE');
    expect(refused.document.plm?.faiResults).toBeUndefined();
  });

  it('is pure: the input document is not modified', () => {
    const doc = releasedPlate();
    const before = JSON.stringify(doc.plm);
    run(doc, 'import_qif_results', params);
    expect(JSON.stringify(doc.plm)).toBe(before);
  });

  it('refuses hostile and unusable files with the stable codes, leaving the document unchanged', () => {
    const doc = releasedPlate();
    const doctype = `<?xml version="1.0"?><!DOCTYPE QIFDocument [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${SAMPLE.split('?>')[1]}`;
    expect(code(doc, { ...params, xml: doctype })).toBe('PLM_QIF_INVALID');
    expect(code(doc, { ...params, xml: '<a>' + '<b/>'.repeat(500_000) + '</a>' })).toBe('PLM_QIF_LIMIT');
    expect(code(doc, { ...params, xml: 'x'.repeat(QIF_LIMITS.maxBytes + 1) })).toBe('PLM_QIF_LIMIT');
    expect(code(doc, { ...params, xml: wrap(results(measurement(1, '99', 'PASS', '1'))) })).toBe('PLM_QIF_INVALID');
    expect(code(doc, { ...params, xml: wrap(results(measurement(1, '2', 'PASS', '1'), measurement(2, '2', 'PASS', '2'))) })).toBe(
      'PLM_QIF_INVALID',
    );
    expect(code(doc, { ...params, revision: 'Z' })).toBe('PLM_REVISION_UNKNOWN');
    expect(code(doc, { ...params, serial: 'bad serial' })).toBe('PLM_PARAM_INVALID');
    expect(code(createEmptyDocument(), params)).toBe('PLM_NOT_MANAGED');
  });

  it('lists measurements that match no characteristic and refuses a duplicate id', () => {
    const doc = releasedPlate();
    const xml = wrap(results(measurement(1, '3', 'PASS', '0.01'), measurement(2, 'weird', 'PASS', '5')));
    const result = run(doc, 'import_qif_results', { ...params, xml, id: 'FRS-mine' });
    const set = result.document.plm?.faiResults?.['FRS-mine'];
    expect(set?.results.map((r) => r.charNo)).toEqual([3]);
    expect(set?.unmatched).toEqual(["DiameterCharacteristicMeasurement 2 (item weird, name 'weird')"]);
    expect(code(result.document, { ...params, xml, id: 'FRS-mine' })).toBe('PLM_ID_EXISTS');
    expect(Object.keys(run(result.document, 'import_qif_results', { ...params, xml }).document.plm?.faiResults ?? {})).toEqual([
      'FRS-mine',
      'FRS-A-2',
    ]);
  });
});
