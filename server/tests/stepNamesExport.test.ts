/**
 * export_step keeps non-ASCII part names (QUALITY_GATES defect 15): CadQuery's STEP writer double-encodes them (`Ø20 Welle` -> `Ã20 Welle`), so
 * the script sent to the bridge carries ASCII placeholders and the returned STEP gets ISO 10303-21 encoded names back.
 * The writer is faked here (it reproduces the defect on a raw non-ASCII name); the real CadQuery round trip is skipped without CadQuery.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { exportStepFile, type CadExchangePort } from '@protocol/exchangeTools';
import { createPythonExchangePort } from '../src/pythonExchange';
import { BRIDGE_SCRIPT, CADQUERY_PYTHON, probePython } from './exchangeTestSupport';

function documentWith(names: readonly string[]): CadDocument {
  let doc = createEmptyDocument();
  for (const name of names) {
    const added = execute(doc, 'add_box', { size: [10, 10, 10] });
    doc = execute(added.document, 'set_entity_name', { id: added.affected[0] ?? '', name }).document;
  }
  return doc;
}

/** Part 21 text as CadQuery writes it: a PRODUCT and an assembly usage (NAUO) per solid name (`name=` or `label(...)`); a raw non-ASCII name comes out double-encoded. */
function cadqueryStyleStep(source: string): string {
  const names = [...source.slice(source.lastIndexOf('MODEL')).matchAll(/(?:\bname=|\blabel\(\w+, )("(?:[^"\\\n]|\\.)*")/g)].map(
    (match) => JSON.parse(match[1] ?? '""') as string,
  );
  const writerEncoded = (name: string): string => Buffer.from(name, 'utf8').toString('latin1').replace(/'/g, "''");
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('CadQuery Assembly'),'2;1');",
    "FILE_NAME('model.step','2026-01-01T00:00:00',(''),(''),'','CadQuery','');",
    'ENDSEC;',
    'DATA;',
    ...names.flatMap((name, index) => [
      `#${100 + index} = PRODUCT('${writerEncoded(name)}','${writerEncoded(name)}','',(#7));`,
      `#${200 + index} = NEXT_ASSEMBLY_USAGE_OCCURRENCE('${writerEncoded(name)}_${index + 1}','${writerEncoded(name)}','',#3,#${100 + index},$);`,
    ]),
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n');
}

function fakePort(seen: string[]): CadExchangePort {
  return {
    runProgram: ({ source }) => {
      seen.push(source);
      return Promise.resolve({
        trace: null,
        traced: false,
        log: '',
        stepBase64: Buffer.from(cadqueryStyleStep(source), 'latin1').toString('base64'),
      });
    },
    importStep: () => Promise.resolve({ bodies: [] }),
  };
}

async function exported(names: readonly string[]): Promise<{ step: string; sources: string[] }> {
  const sources: string[] = [];
  const doc = documentWith(names);
  const file = await exportStepFile(() => doc, fakePort(sources), { save: false });
  if ('error' in file) throw new Error(file.error);
  return { step: Buffer.from(file.stepBase64, 'base64').toString('latin1'), sources };
}

describe('export_step with non-ASCII names', () => {
  it('sends ASCII names to the CadQuery script and writes PRODUCT and NAUO names as ISO 10303-21 strings', async () => {
    const { step, sources } = await exported(['Ø20 Welle', 'plain']);
    expect(sources[0]).not.toContain('Ø');
    expect(sources[0]).toContain('label(box_1, "llull_name_000001")');
    expect(step).toContain("#100 = PRODUCT('\\X2\\00D8\\X0\\20 Welle','\\X2\\00D8\\X0\\20 Welle','',(#7));");
    expect(step).toContain("#200 = NEXT_ASSEMBLY_USAGE_OCCURRENCE('\\X2\\00D8\\X0\\20 Welle_1','\\X2\\00D8\\X0\\20 Welle','',#3,#100,$);");
    expect(step).toContain("#101 = PRODUCT('plain','plain','',(#7));");
    expect(step).not.toContain('Ã');
  });

  it('encodes CJK, emoji, apostrophes and backslashes', async () => {
    const { step } = await exported(['部品', 'cup 😀', "O'Brien", 'a\\b']);
    expect(step).toContain("#100 = PRODUCT('\\X2\\90E854C1\\X0\\'");
    expect(step).toContain("#101 = PRODUCT('cup \\X4\\0001F600\\X0\\'");
    expect(step).toContain("#102 = PRODUCT('O''Brien'");
    expect(step).toContain("#103 = PRODUCT('a\\\\b'");
  });

  it('leaves a document of ASCII names untouched', async () => {
    const { step, sources } = await exported(['Base plate']);
    expect(sources[0]).toContain('label(box_1, "Base plate")');
    expect(step).toContain("#100 = PRODUCT('Base plate','Base plate','',(#7));");
  });
});

const hasCadQuery = probePython(CADQUERY_PYTHON).cadquery !== null;

// NOT EXECUTED on the machine that wrote it (no Python with CadQuery); it runs wherever LLULL_TEST_CADQUERY_PYTHON / LLULL_PYTHON has CadQuery.
describe.skipIf(!hasCadQuery)('non-ASCII names through the real CadQuery STEP writer', () => {
  const port = createPythonExchangePort({
    python: CADQUERY_PYTHON,
    build123dPython: CADQUERY_PYTHON,
    timeoutMs: 120_000,
    bridgeScript: BRIDGE_SCRIPT,
    exchangeDir: null,
  });

  it('writes Ø20 Welle as \\X2\\00D8\\X0\\20 Welle and reads it back as the same name', async () => {
    const doc = documentWith(['Ø20 Welle']);
    const file = await exportStepFile(() => doc, port, { save: false });
    if ('error' in file) throw new Error(file.error);
    const text = Buffer.from(file.stepBase64, 'base64').toString('latin1');
    expect(text).toContain('\\X2\\00D8\\X0\\20 Welle');
    expect(text).not.toContain('Ã');
    const imported = await port.importStep(file.stepBase64);
    const result = execute(createEmptyDocument(), 'import_mesh', { bodies: imported.bodies });
    expect(Object.values(result.document.entities).map((entity) => entity.name)).toContain('Ø20 Welle');
  }, 120_000);
});
