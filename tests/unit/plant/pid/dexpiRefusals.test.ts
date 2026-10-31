/** Plant 04 PID M2: import_dexpi refuses hostile or unsupported input with stable codes and leaves the document untouched (VC-PID-15, TR-PID-11). */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectRefusal } from '../../../helpers/commandAssertions';
import { C01, dexpiText, importFile } from './dexpiFixtures';

const empty = createEmptyDocument();

const PARSE_CASES: Array<[string, string, string]> = [
  ['XML_EMPTY', '   ', ''],
  ['XML_SYNTAX', '<PlantModel a=b/>', ''],
  ['XML_DTD_FORBIDDEN', '<!DOCTYPE PlantModel [<!ENTITY x "y">]><PlantModel/>', ''],
  ['XML_ENTITY_UNDEFINED', '<PlantModel>&xxe;</PlantModel>', ''],
  ['XML_CHAR_INVALID', '<PlantModel>\u0001</PlantModel>', ''],
  ['XML_MISMATCHED_TAG', '<PlantModel></Other>', ''],
  ['XML_UNCLOSED', '<PlantModel><PlantInformation>', ''],
  ['XML_DUPLICATE_ATTRIBUTE', '<PlantModel a="1" a="2"/>', ''],
  ['XML_NAMESPACE_UNBOUND', '<p:PlantModel/>', ''],
  ['XML_TRAILING_CONTENT', '<PlantModel/><PlantModel/>', ''],
  ['XML_TOO_DEEP', '<a>'.repeat(300), 'too large or too complex'],
  ['XML_TOO_MANY_ATTRIBUTES', `<PlantModel ${Array.from({ length: 1100 }, (_, i) => `a${i}="1"`).join(' ')}/>`, 'too large or too complex'],
  ['XML_TOO_LARGE', `<PlantModel>${' '.repeat(50_000_001)}</PlantModel>`, 'too large or too complex'],
];

describe('import_dexpi: DEXPI_PARSE_ERROR (every XML_* class)', () => {
  it.each(PARSE_CASES)('%s is DEXPI_PARSE_ERROR with line and column, document unchanged', (xmlCode, text, wording) => {
    const result = expectRefusal(empty, 'import_dexpi', { text }, 'DEXPI_PARSE_ERROR');
    expect(result.error?.paths[0]).toMatch(/^line \d+, column \d+$/);
    expect(result.error?.detail).toEqual({ xmlCode });
    expect(result.summary).toContain(xmlCode);
    if (wording !== '') expect(result.summary).toContain(wording);
    else expect(result.summary).toContain('not well-formed XML');
  });

  it('names the position of the fault in a truncated real file and in a mutated one', () => {
    const text = dexpiText(C01);
    const cut = expectRefusal(empty, 'import_dexpi', { text: text.slice(0, 200_000) }, 'DEXPI_PARSE_ERROR');
    expect(cut.error?.paths[0]).toMatch(/^line \d+, column \d+$/);
    const bad = text.replace('<PlantInformation ', '<PlantInformation &oops; ');
    const mutated = expectRefusal(empty, 'import_dexpi', { text: bad }, 'DEXPI_PARSE_ERROR');
    expect(mutated.error?.paths).toEqual(['line 3, column 21']);
  });

  it('refuses an entity bomb and an external entity without expanding them', () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><PlantModel>&lol2;</PlantModel>';
    expectRefusal(empty, 'import_dexpi', { text: bomb }, 'DEXPI_PARSE_ERROR');
    const xxe = '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><PlantModel>&x;</PlantModel>';
    const result = expectRefusal(empty, 'import_dexpi', { text: xxe }, 'DEXPI_PARSE_ERROR');
    expect(result.error?.detail).toEqual({ xmlCode: 'XML_DTD_FORBIDDEN' });
  });

  it('leaves a document that already holds a P&ID untouched', () => {
    const doc = importFile(C01);
    const result = expectRefusal(doc, 'import_dexpi', { text: '<PlantModel' }, 'DEXPI_PARSE_ERROR');
    expect(result.document.plant?.pid).toBe(doc.plant?.pid);
  });
});

describe('import_dexpi: DEXPI_VERSION_UNSUPPORTED and sheet numbers', () => {
  const model = (information: string): string => `<PlantModel>${information}</PlantModel>`;

  it.each([
    ['another root', '<Foo/>', 'is not a DEXPI Proteus <PlantModel>'],
    ['a DEXPI 2.0 <Model> root', '<Model/>', 'DEXPI 2.0 XML is not read yet'],
    ['no PlantInformation', model(''), 'no SchemaVersion'],
    ['no SchemaVersion', model('<PlantInformation Units="mm"/>'), 'no SchemaVersion'],
    ['Proteus 4.2 (DEXPI 1.4)', model('<PlantInformation SchemaVersion="4.2.0"/>'), 'SchemaVersion 4.2.0 is not read'],
  ])('%s', (_name, text, reason) => {
    const result = expectRefusal(empty, 'import_dexpi', { text }, 'DEXPI_VERSION_UNSUPPORTED');
    expect(result.summary).toContain(reason);
    expect(result.error?.paths[0]).toMatch(/^line \d+, column \d+$/);
  });

  it('says so when version 1.3 was asked for a 4.2 file', () => {
    const result = expectRefusal(
      empty,
      'import_dexpi',
      { text: model('<PlantInformation SchemaVersion="4.2.0"/>'), version: '1.3' },
      'DEXPI_VERSION_UNSUPPORTED',
    );
    expect(result.summary).toContain('version 1.3 was requested');
  });

  it('refuses a sheet number in use (PID_SHEET_DUPLICATE) and numbers the next import PID-002', () => {
    const first = importFile(C01);
    expectRefusal(first, 'import_dexpi', { text: dexpiText(C01), sheet: 'PID-001' }, 'PID_SHEET_DUPLICATE', 'sheet');
    const second = execute(first, 'import_dexpi', { text: dexpiText('P02V01-VER.EX01.xml') });
    expect(second.rejected).toBeUndefined();
    const pid = second.document.plant?.pid;
    expect(pid?.sheetOrder.map((id) => pid.sheets[id]?.number)).toEqual(['PID-001', 'PID-002']);
    const named = execute(second.document, 'import_dexpi', { text: dexpiText('P02V01-VER.EX01.xml'), sheet: 'SHEET-X' });
    expect(named.document.plant?.pid?.sheetOrder).toHaveLength(3);
  });

  it('rejects params that are not valid (no text)', () => {
    const result = execute(empty, 'import_dexpi', {});
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(empty);
  });
});
