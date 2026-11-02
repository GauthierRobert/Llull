/** Plant 04 PID M6: export_dexpi version 2.0. 1.3 -> model -> 2.0 -> model over the 11 pack files (census, lists, geometry), byte determinism, schema check (VC-PID-06, VC-PID-07). */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { readXml } from '@lib/xmlRead';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { C01, PID_PACK, countsOf, dexpiText, importFile } from './dexpiFixtures';
import { fingerprint } from './dexpiFingerprint';

const FILES = readdirSync(path.join(PID_PACK, 'data/dexpi13')).filter((name) => name.endsWith('.xml'));
const REFERENCE = readFileSync(path.join(PID_PACK, 'data/dexpi20/reference_pid.xml'), 'utf8');
const XSD = path.join(PID_PACK, 'data/dexpi20/DEXPI_XML_Schema.xsd');

interface Exported {
  text: string;
  version: string;
  sha256: string;
  sheets: string[];
  counts: Record<string, number>;
  warnings: Array<{ code: string; severity: string; message: string }>;
  schema?: { valid: boolean; count: number; violations: unknown[] };
}
const exportOf = (doc: CadDocument, version: '1.3' | '2.0' = '2.0', params: Record<string, unknown> = {}): Exported =>
  data<Exported>(doc, 'export_dexpi', { version, ...params });
const reimport = (text: string): CadDocument => apply(createEmptyDocument(), 'import_dexpi', { text });
const listOf = (doc: CadDocument, kind: string): unknown[] => data<{ rows: unknown[] }>(doc, 'pid_report', { kind }).rows;
const LISTS = ['connectivity', 'line_list', 'valve_list', 'instrument_index', 'equipment_list', 'nozzle_list'];

describe('export_dexpi version 2.0: round trip of the 11 DEXPI 1.3 pack files', () => {
  it.each(FILES)(
    '%s: valid against the schema rules, same census / lists / geometry after re-import as the 1.3 round trip, second export byte-identical',
    (file) => {
      const original = importFile(file);
      const first = exportOf(original);
      expect(first.schema).toEqual({ valid: true, count: 0, violations: [] });
      const again = reimport(first.text);
      const viaOneThree = reimport(exportOf(original, '1.3').text);
      const before = countsOf(original);
      const after = countsOf(again);
      for (const key of Object.keys(before)) {
        if (key === 'shapeCatalogueEntries') expect(after[key], key).toBe(1);
        else expect(after[key], `${file} ${key}`).toBe(before[key]);
      }
      expect(first.counts).toEqual(after);
      for (const kind of LISTS) expect(listOf(again, kind), `${file} ${kind}`).toEqual(listOf(original, kind));
      expect(fingerprint(again, { geometry: true })).toEqual(fingerprint(viaOneThree, { geometry: true }));
      const second = exportOf(again);
      expect(second.text).toBe(first.text);
      expect(second.sha256).toBe(first.sha256);
    },
  );

  it('C01 keeps its positions, ports, routes and attributes with units through 2.0 (to 1e-6 mm)', () => {
    const original = importFile(C01);
    const lines = fingerprint(reimport(exportOf(original).text), { geometry: true });
    expect(lines.length).toBe(127);
    expect(
      lines.some((line) => line.includes('"kind":"segment"') && line.includes('"route":[[') && line.includes('"flow":"forward"')),
    ).toBe(true);
    expect(lines.some((line) => line.includes('"kind":"equipment"') && line.includes('UpperLimitDesignPressure":"'))).toBe(true);
    const bar = Object.values(reimport(exportOf(original).text).plant?.pid?.items ?? {}).flatMap((item) =>
      Object.values(item.attributes).filter((value) => value.kind === 'quantity' && value.unit === 'Bar'),
    );
    expect(bar.length).toBeGreaterThan(5);
  });

  it('a 2.0 file converts to 1.3 and back: reference_pid.xml -> 2.0 export -> same model; -> 1.3 export -> same census', () => {
    const reference = reimport(REFERENCE);
    const as20 = exportOf(reference);
    expect(as20.schema?.valid).toBe(true);
    const again = reimport(as20.text);
    // The first export adds the typed fields (nozzle size as an attribute); from there on the model is a fixed point.
    const next = reimport(exportOf(again).text);
    expect(fingerprint(next, { geometry: true })).toEqual(fingerprint(again, { geometry: true }));
    expect(exportOf(again).text).toBe(as20.text);
    const as13 = reimport(exportOf(reference, '1.3').text);
    const counts = countsOf(as13);
    for (const [key, value] of Object.entries(countsOf(reference)))
      if (key !== 'shapeCatalogueEntries') expect(counts[key], key).toBe(value);
  });
});

describe('export_dexpi version 2.0: the file and the command', () => {
  const original = importFile(C01);
  const out = exportOf(original);

  it('is a DEXPI 2.0 Model: imports, one plant model, diagram, LF line ends, two-space indent, no tabs', () => {
    expect(out.version).toBe('2.0');
    expect(
      out.text.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Model name="LlullPid" uri="urn:llull:pid">\n  <Import prefix="Core" source="https://data.dexpi.org/models/2.0.1/Core.xml"/>',
      ),
    ).toBe(true);
    expect(out.text).toContain('<Import prefix="Plant" source="https://data.dexpi.org/models/2.0.1/Plant.xml"/>');
    expect(out.text).toContain('<Object id="PlantModel1" type="Plant/PlantModel">');
    expect(out.text).toContain('<Components property="Diagram">');
    expect(out.text).not.toMatch(/\r|\t/);
    expect(out.text.endsWith('</Model>\n')).toBe(true);
  });

  it('is read-only, deterministic and reports its own findings', () => {
    const before = JSON.stringify(original);
    const result = execute(original, 'export_dexpi', { version: '2.0' });
    expect(JSON.stringify(original)).toBe(before);
    expect(result.document).toBe(original);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(/^export_dexpi: DEXPI 2\.0 of PID-001: 16 equipment, 19 nozzles, 11 lines/);
    expect(exportOf(original).sha256).toBe(out.sha256);
    expect(out.warnings.find((w) => w.code === 'DEXPI_GRAPHICS_DROPPED')?.message).toContain('class URIs');
    expect(exportOf(original, '1.3').schema).toBeUndefined();
  });

  it('writes ids the XSD accepts: characters outside A-Z a-z 0-9 _ are _xHHHH_, the id round-trips as the source id', () => {
    expect(out.text).toContain('id="PipingNetworkSegment_x002D_1"');
    const sources = Object.values(reimport(out.text).plant?.pid?.items ?? {}).flatMap((item) =>
      item.sourceId === undefined ? [] : [item.sourceId],
    );
    expect(sources).toContain('PipingNetworkSegment-1');
    expect(sources.some((id) => id.includes('_x'))).toBe(false);
  });

  it('exports chosen sheets by number, merges several into one Model and says so', () => {
    const two = importFile('P01V01-VER.EX01.xml', importFile('P04V01-VER.EX01.xml'));
    const all = exportOf(two);
    expect(all.sheets).toEqual(['PID-001', 'PID-002']);
    expect(all.warnings.some((w) => w.message.includes('merged into one Model'))).toBe(true);
    expect(exportOf(two, '2.0', { sheets: ['PID-002'] }).sheets).toEqual(['PID-002']);
    expect(all.schema?.valid).toBe(true);
  });

  it('refuses without a P&ID, for an unknown sheet and for a version it does not write', () => {
    expectRefusal(createEmptyDocument(), 'export_dexpi', { version: '2.0' }, 'PID_SHEET_NOT_FOUND');
    expectRefusal(original, 'export_dexpi', { version: '2.0', sheets: ['PID-9'] }, 'PID_SHEET_NOT_FOUND', 'sheets');
    expect(execute(original, 'export_dexpi', { version: '1.4' }).rejected).toBe(true);
  });

  it('carries text from untrusted files through escaping and the name encoding (tags, a prototype-key id)', () => {
    const source = dexpiText('P01V01-VER.EX01.xml')
      .replace('Value="P4712"', 'Value="A&amp;B &lt;&quot;x&quot;&gt; \'y\' &#9; tab ]]&gt; &amp;lt;"')
      .replace('<Nozzle ID="Nozzle-1"', '<Nozzle ID="constructor"');
    const doc = apply(createEmptyDocument(), 'import_dexpi', { text: source });
    const text = exportOf(doc).text;
    expect(readXml(text).ok).toBe(true);
    expect(exportOf(doc).schema?.valid).toBe(true);
    const tags = Object.values(reimport(text).plant?.pid?.items ?? {}).map((item) => item.tag);
    expect(tags).toContain(`A&B <"x"> 'y' \t tab ]]> &lt;`);
    expect(Object.values(reimport(text).plant?.pid?.items ?? {}).some((item) => item.sourceId === 'constructor')).toBe(true);
  });

  it('writes a sub-equipment class named like an Object.prototype member as plain data', () => {
    const source = `<PlantModel><PlantInformation SchemaVersion="4.1.1" Units="mm"/><Equipment ID="E1" ComponentClass="Tank"><Equipment ID="E2" ComponentClass="constructor"><GenericAttributes Set="DexpiAttributes"><GenericAttribute Name="DesignPressure" Format="double" Value="3" Units="constructor"/></GenericAttributes></Equipment></Equipment></PlantModel>`;
    const doc = apply(createEmptyDocument(), 'import_dexpi', { text: source });
    const written = exportOf(doc);
    expect(written.schema?.valid).toBe(true);
    expect(written.text).not.toContain('function');
    expect(written.text).toContain('<Components property="SubEquipment">');
    const found = Object.values(reimport(written.text).plant?.pid?.items ?? {}).find((item) => item.sourceId === 'E2');
    expect(found?.passthrough?.['dexpi:ComponentClass']).toBe('constructor');
  });
});

describe('export_dexpi version 2.0: authored sheet (SC-PID-02)', () => {
  const plan = JSON.parse(readFileSync(path.join(PID_PACK, 'plans/sc-pid-02-author-and-validate.json'), 'utf8')) as {
    actions: Array<{ command: string; params: Record<string, unknown> }>;
  };

  it('authors, exports 2.0 and keeps the census, the lists and a byte-identical second export', async () => {
    const { runSteps } = await import('./authoringFixtures');
    const authored = runSteps(plan.actions as never).doc;
    const first = exportOf(authored);
    expect(first.schema?.valid).toBe(true);
    const again = reimport(first.text);
    const strip = (rows: unknown[]): unknown[] => rows.map((row) => ({ ...(row as object), segments: undefined }));
    for (const kind of ['valve_list', 'instrument_index', 'equipment_list', 'nozzle_list'])
      expect(listOf(again, kind), kind).toEqual(listOf(authored, kind));
    expect(strip(listOf(again, 'line_list'))).toEqual(strip(listOf(authored, 'line_list')));
    expect(exportOf(again).text).toBe(first.text);
  });
});

const xmllint = spawnSync('xmllint', ['--version']);
describe.skipIf(xmllint.error !== undefined)('DEXPI_XML_Schema.xsd with xmllint (installed here)', () => {
  it('validates the reference file and every 2.0 export of the pack', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'dexpi20-'));
    try {
      const check = (name: string, text: string): string => {
        const file = path.join(folder, name);
        writeFileSync(file, text);
        const result = spawnSync('xmllint', ['--noout', '--schema', XSD, file], { encoding: 'utf8' });
        return `${result.status}:${result.stderr}`;
      };
      expect(check('reference.xml', REFERENCE)).toMatch(/^0:/);
      for (const file of FILES) expect(check(file, exportOf(importFile(file)).text), file).toMatch(/^0:/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
