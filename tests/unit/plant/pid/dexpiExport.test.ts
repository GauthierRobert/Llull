/** Plant 04 PID M5: export_dexpi. Round trip over the 11 pack files (census, connectivity, lists), fixed point, determinism, escaping, refusals, budget. */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { readXml } from '@lib/xmlRead';
import type { PidItem } from '@aec/plant/pid/model';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { C01, PID_PACK, countsOf, dexpiText, importFile } from './dexpiFixtures';

const FILES = readdirSync(path.join(PID_PACK, 'data/dexpi13')).filter((name) => name.endsWith('.xml'));

interface Exported {
  text: string;
  version: string;
  sha256: string;
  sheets: string[];
  counts: Record<string, number>;
  warnings: Array<{ code: string; severity: string }>;
}
const exportOf = (doc: CadDocument, params: Record<string, unknown> = {}): Exported =>
  data<Exported>(doc, 'export_dexpi', { version: '1.3', ...params });

interface Row {
  from: string;
  fromType: string;
  to: string;
  toType: string;
  via: string;
  lineNumber: string;
}
const rowsOf = (doc: CadDocument): Row[] => data<{ rows: Row[] }>(doc, 'pid_report', { kind: 'connectivity' }).rows;
const listOf = (doc: CadDocument, kind: string): unknown[] => data<{ rows: unknown[] }>(doc, 'pid_report', { kind }).rows;

describe('export_dexpi: round trip of the 11 DEXPI 1.3 pack files', () => {
  it('has the 11 files', () => expect(FILES).toHaveLength(11));

  it.each(FILES)(
    '%s: export -> import gives the same census (17 keys, shape catalogue aside), connectivity, lists; second export is byte-identical',
    (file) => {
      const original = importFile(file);
      const first = exportOf(original);
      const again = apply(createEmptyDocument(), 'import_dexpi', { text: first.text });
      const second = exportOf(again);
      const before = countsOf(original);
      const after = countsOf(again);
      for (const key of Object.keys(before)) {
        if (key === 'shapeCatalogueEntries') expect(after[key], key).toBe(0);
        else expect(after[key], `${file} ${key}`).toBe(before[key]);
      }
      expect(first.counts).toEqual(after);
      expect(rowsOf(again)).toEqual(rowsOf(original));
      for (const kind of ['line_list', 'valve_list', 'instrument_index', 'equipment_list', 'nozzle_list'])
        expect(listOf(again, kind), `${file} ${kind}`).toEqual(listOf(original, kind));
      expect(second.text).toBe(first.text);
      expect(second.sha256).toBe(first.sha256);
    },
  );

  it('the output is well-formed, has no DOCTYPE, and reads with @lib/xmlRead', () => {
    const { text } = exportOf(importFile(C01));
    const read = readXml(text);
    expect(read.ok).toBe(true);
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<PlantModel>')).toBe(true);
    expect(text).not.toContain('<!DOCTYPE');
    expect(text).not.toContain('\r');
  });

  it('C01 export stays inside the 0.5 s budget (generous bound for a loaded machine)', () => {
    const doc = importFile(C01);
    const start = performance.now();
    exportOf(doc);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('keeps the passthrough attributes of a set other than DexpiAttributes and the typed attributes', () => {
    const doc = importFile(C01);
    const again = apply(createEmptyDocument(), 'import_dexpi', { text: exportOf(doc).text });
    const items = (d: CadDocument): PidItem[] => Object.values(d.plant?.pid?.items ?? {});
    const withPass = (d: CadDocument): number =>
      items(d)
        .filter((item) => Object.keys(item.passthrough ?? {}).some((key) => !key.startsWith('dexpi:')))
        .map((item) => Object.keys(item.passthrough ?? {}).filter((key) => !key.startsWith('dexpi:')).length)
        .reduce((a, b) => a + b, 0);
    expect(withPass(again)).toBe(withPass(doc));
    // Nozzle sizes the source kept on the connection nodes come back as a nozzle attribute (the model has no node attributes): not counted.
    const attrs = (d: CadDocument): number =>
      items(d).reduce(
        (sum, item) =>
          sum +
          Object.keys(item.attributes).filter((name) => !name.startsWith('NominalDiameterNumerical') || item.kind !== 'nozzle').length,
        0,
      );
    expect(attrs(again)).toBe(attrs(doc));
  });
});

describe('export_dexpi: command contract', () => {
  it('is read-only, pure and deterministic', () => {
    const doc = importFile(C01);
    const before = JSON.stringify(doc);
    const a = execute(doc, 'export_dexpi', { version: '1.3' });
    const b = execute(doc, 'export_dexpi', { version: '1.3' });
    expect(JSON.stringify(doc)).toBe(before);
    expect(a.document).toBe(doc);
    expect(a.affected).toEqual([]);
    expect((a.data as Exported).text).toBe((b.data as Exported).text);
    expect(a.summary).toMatch(/^export_dexpi: DEXPI 1\.3 of PID-001/);
  });

  it('refuses a document without a P&ID, an unknown sheet, and a version it does not write', () => {
    expectRefusal(createEmptyDocument(), 'export_dexpi', { version: '1.3' }, 'PID_SHEET_NOT_FOUND');
    expectRefusal(importFile(C01), 'export_dexpi', { version: '1.3', sheets: ['PID-9'] }, 'PID_SHEET_NOT_FOUND', 'sheets');
    const result = execute(importFile(C01), 'export_dexpi', { version: '2.0' });
    expect(result.rejected).toBe(true);
    expect(result.summary).toMatch(/invalid params/);
  });

  it('exports chosen sheets by number or id; two imports merge into one file when all are exported', () => {
    const two = importFile('P01V01-VER.EX01.xml', importFile('P04V01-VER.EX01.xml'));
    const all = exportOf(two);
    expect(all.sheets).toEqual(['PID-001', 'PID-002']);
    expect(all.warnings.some((w) => w.code === 'DEXPI_GRAPHICS_DROPPED' && w.severity === 'info')).toBe(true);
    const one = exportOf(two, { sheets: ['PID-002'] });
    expect(one.sheets).toEqual(['PID-002']);
    const id = Object.keys(two.plant?.pid?.sheets ?? {})[0] ?? '';
    expect(exportOf(two, { sheets: [id] }).sheets).toEqual(['PID-001']);
    expect(all.counts['nozzles']).toBe(one.counts['nozzles']! + exportOf(two, { sheets: ['PID-001'] }).counts['nozzles']!);
  });
});

describe('export_dexpi: text from untrusted imports is escaped and survives', () => {
  const hostile = `A&B <"x"> 'y' \t tab ]]> &lt;`;
  it('escapes tags, names and attribute values; the text comes back unchanged', () => {
    const source = dexpiText('P01V01-VER.EX01.xml')
      .replace('Value="P4712"', 'Value="A&amp;B &lt;&quot;x&quot;&gt; \'y\' &#9; tab ]]&gt; &amp;lt;"')
      .replace('Value="48122"', 'Value="&lt;/PlantModel&gt;&#10;&amp;"');
    const doc = apply(createEmptyDocument(), 'import_dexpi', { text: source });
    expect(Object.values(doc.plant?.pid?.items ?? {}).some((item) => item.tag === hostile)).toBe(true);
    const { text } = exportOf(doc);
    expect(text).not.toContain('</PlantModel>\n&');
    expect(readXml(text).ok).toBe(true);
    const again = apply(createEmptyDocument(), 'import_dexpi', { text });
    expect(Object.values(again.plant?.pid?.items ?? {}).some((item) => item.tag === hostile)).toBe(true);
    const lines = Object.values(again.plant?.pid?.items ?? {}).flatMap((item) => (item.kind === 'line' ? [item.lineNumber] : []));
    expect(lines).toEqual(['</PlantModel>\n&']);
  });

  it('drops characters XML 1.0 cannot carry instead of writing an unreadable file', () => {
    let doc = createEmptyDocument();
    doc = apply(doc, 'create_pid_sheet', { number: 'PID-001', title: 'bad \u0001 title' });
    doc = apply(doc, 'add_pid_equipment', { sheet: 'PID-001', class: 'Tank', tag: 'T-1\u0002', at: [50, 50] });
    const { text } = exportOf(doc);
    expect(readXml(text).ok).toBe(true);
    expect(text).toContain('T-1"');
  });
});
