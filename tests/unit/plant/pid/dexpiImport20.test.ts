/** Plant 04 PID M6: import_dexpi on DEXPI 2.0 XML. `reference_pid.xml` is census-equal to the DEXPI 1.3 file C01 it encodes (VC-PID-02), refusals, findings, hostile ids. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { sha256Hex } from '@lib/sha256';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { C01, PID_PACK, countsOf, dexpiText, importFile } from './dexpiFixtures';
import { fingerprint } from './dexpiFingerprint';

const REFERENCE = readFileSync(path.join(PID_PACK, 'data/dexpi20/reference_pid.xml'), 'utf8');
const expected = JSON.parse(readFileSync(path.join(PID_PACK, 'data/dexpi_census.json'), 'utf8')) as {
  dexpi20: { sha256: string; counts: Record<string, number> };
};
const empty = createEmptyDocument();
const reference = apply(empty, 'import_dexpi', { text: REFERENCE });
const c01 = importFile(C01);

interface Imported {
  source: { dexpiVersion: string; schemaVersion: string; sha256: string };
  warnings: Array<{ code: string; severity: string; paths: string[]; message: string }>;
  counts: Record<string, number>;
}
const importOf = (text: string, params: Record<string, unknown> = {}): Imported => {
  const result = execute(empty, 'import_dexpi', { text, ...params });
  expect(result.rejected, result.summary).toBeUndefined();
  return result.data as Imported;
};
const rows = (doc: CadDocument, kind: string): Array<Record<string, string>> =>
  data<{ rows: Array<Record<string, string>> }>(doc, 'pid_report', { kind }).rows;

/** The 2.0 reference names its objects `Class1`, the 1.3 file `Class-1`; its nozzles are `ProcessNozzle`. */
const plain = (value: unknown): string =>
  String(value)
    .replace(/-(\d)/g, '$1')
    .replace(/Nozzle:\w*Nozzle/g, 'Nozzle:Nozzle');

const PLANT_IMPORT = '<Import prefix="Plant" source="https://data.dexpi.org/models/2.0.1/Plant.xml"/>';
const CORE_IMPORT = '<Import prefix="Core" source="https://data.dexpi.org/models/2.0.1/Core.xml"/>';
const MODEL = (body: string, imports = CORE_IMPORT + PLANT_IMPORT): string =>
  `<Model name="m" uri="urn:m">${imports}<Object type="Core/EngineeringModel"><Components property="ConceptualModel"><Object id="P1" type="Plant/PlantModel">${body}</Object></Components></Object></Model>`;
const components = (property: string, objects: string): string => `<Components property="${property}">${objects}</Components>`;
const tank = (id: string, extra = ''): string => `<Object id="${id}" type="Plant/ProcessEquipment.Tank">${extra}</Object>`;

describe('import_dexpi: DEXPI 2.0 reference_pid.xml (VC-PID-02)', () => {
  it('is the file the pack says it is', () => expect(sha256Hex(REFERENCE)).toBe(expected.dexpi20.sha256));

  it('has the 14 census counts of the 2.0 encoding, exactly', () => {
    const counts = countsOf(reference);
    expect(Object.keys(expected.dexpi20.counts)).toHaveLength(14);
    for (const [key, value] of Object.entries(expected.dexpi20.counts)) expect(counts[key], key).toBe(value);
  });

  it('is census-equal to the DEXPI 1.3 file C01 on all 17 keys (29 connections = 23 segments + 6 flows, 24 shapes)', () => {
    expect(countsOf(reference)).toEqual(countsOf(c01));
    expect(countsOf(reference)['connections']).toBe(29);
  });

  it('reports the 2.0 source, the Plant model version, no schema violation and only the presentation finding', () => {
    const result = importOf(REFERENCE);
    expect(result.source).toMatchObject({ dexpiVersion: '2.0', schemaVersion: '2.0.1', sha256: sha256Hex(REFERENCE) });
    expect(result.warnings.map((w) => `${w.code}/${w.severity}`)).toEqual(['DEXPI_GRAPHICS_DROPPED/info']);
    const record = reference.plant?.pid?.imports?.[0];
    expect(record).toMatchObject({ format: 'dexpi-xml', version: '2.0', sha256: sha256Hex(REFERENCE) });
    expect(record?.census).toMatchObject({ shapeCatalogueEntries: 24, connections: 29, danglingConnections: 0 });
  });

  it('gives the same connectivity and the same five lists as C01, row for row (ids differ in spelling only)', () => {
    for (const kind of ['connectivity', 'line_list', 'valve_list', 'instrument_index', 'equipment_list', 'nozzle_list']) {
      const before = rows(c01, kind);
      expect(before.length, kind).toBeGreaterThan(0);
      expect(
        rows(reference, kind).map((row) => plain(JSON.stringify(row))),
        kind,
      ).toEqual(before.map((row) => plain(JSON.stringify(row))));
    }
  });

  it('reads tags, line numbers, DN, classes, fluid codes and quantities like C01 (VC-PID-04); only the port of a blind flange differs (one node in 2.0, two in 1.3)', () => {
    const keep = (line: string): boolean => !/"class":"(Plant)?MetaData"/.test(line);
    const lines = (doc: CadDocument): string[] =>
      fingerprint(doc, { geometry: false })
        .filter(keep)
        .map((line) => plain(line).replace(/\["inline","(\w+)",\d+\]/g, '["inline","$1"]'))
        .sort();
    expect(lines(reference)).toEqual(lines(c01));
    expect(rows(reference, 'line_list').map((row) => row['lineNumber'])).toEqual(expect.arrayContaining(['47121', '47141']));
    expect(
      rows(reference, 'equipment_list')
        .map((row) => row['tag'])
        .sort(),
    ).toEqual(['H1007', 'H1008', 'P4711', 'P4712', 'T4750']);
  });

  it('puts every placed item where the DEXPI 1.3 file puts it (a 2.0 diagram is Y down: the sheet is flipped)', () => {
    const at = (doc: CadDocument): Map<string, string> => {
      const found = new Map<string, string>();
      for (const item of Object.values(doc.plant?.pid?.items ?? {}))
        if (['equipment', 'opc', 'instrument', 'actuating'].includes(item.kind))
          found.set(plain(item.sourceId ?? item.tag), `${item.at.map((v) => Math.round(v * 1000) / 1000)}|${item.rotationDeg}`);
      return found;
    };
    const before = at(c01);
    expect(before.size).toBeGreaterThan(10);
    expect(at(reference)).toEqual(before);
    const port = (doc: CadDocument, id: string): unknown =>
      Object.values(doc.plant?.pid?.items ?? {}).flatMap((item) => (item.kind === 'nozzle' && item.sourceId === id ? [item.port] : []))[0];
    expect(port(reference, 'Nozzle1')).toEqual(port(c01, 'Nozzle-1'));
    expect(reference.plant?.pid?.sheets[reference.plant.pid.sheetOrder[0] ?? '']?.paper).toBe('A3');
  });

  it('keeps the actuating systems on their valves with fail action and controller, and the loop members', () => {
    const items = Object.values(reference.plant?.pid?.items ?? {});
    const systems = items.flatMap((item) => (item.kind === 'actuating' ? [item] : []));
    expect(systems.map((s) => [s.tag, s.failAction])).toEqual([
      ['PV4712.02', 'FC'],
      ['HV4750.01', 'FC'],
      ['TV4750.03', 'FO'],
    ]);
    expect(systems.every((s) => s.controllerId !== undefined)).toBe(true);
    expect(items.flatMap((item) => (item.kind === 'instrument' ? [item.loopId !== undefined] : []))).toEqual([true, true, true, true]);
  });

  it('is pure: the empty document is untouched', () => {
    expect(empty.plant?.pid).toBeUndefined();
    expect(importOf(REFERENCE).counts).toEqual(countsOf(reference));
  });
});

describe('import_dexpi: the root and the version param decide the reader', () => {
  it('auto reads both versions; the version param refuses a file of the other one', () => {
    const one = dexpiText(C01);
    expect(importOf(one).source.dexpiVersion).toBe('1.3');
    expect(importOf(REFERENCE, { version: '2.0' }).source.dexpiVersion).toBe('2.0');
    expect(expectRefusal(empty, 'import_dexpi', { text: REFERENCE, version: '1.3' }, 'DEXPI_VERSION_UNSUPPORTED').summary).toContain(
      'version 1.3 was requested',
    );
    expect(expectRefusal(empty, 'import_dexpi', { text: one, version: '2.0' }, 'DEXPI_VERSION_UNSUPPORTED').summary).toContain(
      'version 2.0 was requested',
    );
  });

  it.each([
    ['no Plant import', MODEL('', CORE_IMPORT), 'imports no Plant model of a known version'],
    ['an import without a version', MODEL('', '<Import prefix="Plant" source="Plant.xml"/>'), 'imports no Plant model of a known version'],
    [
      'Plant 1.4',
      MODEL('', '<Import prefix="Plant" source="https://data.dexpi.org/models/1.4.0/Plant.xml"/>'),
      'version 1.4.0 is not read',
    ],
    ['Plant 3.0', MODEL('', '<Import prefix="Plant" source="https://data.dexpi.org/models/3.0/Plant.xml"/>'), 'version 3.0 is not read'],
    [
      'no engineering model',
      '<Model name="m" uri="u"><Import prefix="Plant" source="x/2.0.0/Plant.xml"/></Model>',
      'no Core/EngineeringModel',
    ],
    [
      'no plant model',
      '<Model name="m" uri="u"><Import prefix="Plant" source="x/2.0.0/Plant.xml"/><Object type="Core/EngineeringModel"/></Model>',
      'no Core/EngineeringModel with a Plant/PlantModel',
    ],
  ])('refuses %s (DEXPI_VERSION_UNSUPPORTED, position in paths, document unchanged)', (_name, text, reason) => {
    const result = expectRefusal(empty, 'import_dexpi', { text }, 'DEXPI_VERSION_UNSUPPORTED');
    expect(result.summary).toContain(reason);
    expect(result.error?.paths[0]).toMatch(/^line \d+, column \d+$/);
    expect(result.document).toBe(empty);
  });

  it.each([
    ['not well-formed', '<Model name="m" uri="u">', 'XML_UNCLOSED'],
    ['a DOCTYPE', '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><Model name="m" uri="u">&x;</Model>', 'XML_DTD_FORBIDDEN'],
    ['a billion-laughs entity', '<!DOCTYPE d [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><Model>&b;</Model>', 'XML_DTD_FORBIDDEN'],
    ['too deep', '<Model>' + '<Object>'.repeat(300) + '</Object>'.repeat(300) + '</Model>', 'XML_TOO_DEEP'],
  ])('refuses %s with DEXPI_PARSE_ERROR', (_name, text, xmlCode) => {
    const result = expectRefusal(empty, 'import_dexpi', { text }, 'DEXPI_PARSE_ERROR');
    expect(result.error?.detail).toEqual({ xmlCode });
  });
});

describe('import_dexpi: 2.0 findings and hostile content', () => {
  it('imports a minimal plant and reports a schema violation without refusing', () => {
    const result = importOf(MODEL(components('TaggedPlantItems', tank('T1') + tank('T1'))));
    const violation = result.warnings.find((w) => w.code === 'DEXPI_SCHEMA_VIOLATION');
    expect(violation).toMatchObject({ message: 'id "T1" is used twice', severity: 'warning' });
    expect(violation?.paths[0]).toMatch(/^line \d+, column \d+$/);
    expect(result.counts['equipmentAll']).toBe(2);
  });

  it('lists at most 20 violations and counts the rest', () => {
    const many = Array.from({ length: 50 }, (_, k) => tank(`T${k}`, '<Bogus/>')).join('');
    const violations = importOf(MODEL(components('TaggedPlantItems', many))).warnings.filter((w) => w.code === 'DEXPI_SCHEMA_VIOLATION');
    expect(violations).toHaveLength(21);
    expect(violations[20]?.message).toBe('30 more schema violation(s) not listed');
  });

  it('warns about a plant model property it does not read, an unmapped class (Custom, class kept) and a pipe end that names nothing', () => {
    const segment = `<Object id="S1" type="Plant/Piping.PipingNetworkSegment">${components('Connections', '<Object id="Q1" type="Plant/Piping.Pipe"/>')}<References objects="#nowhere" property="SourceItem"/><References objects="#W1" property="TargetItem"/></Object>`;
    const text = MODEL(
      components('Mystery', '<Object type="Plant/X.Y"/>') +
        components('TaggedPlantItems', '<Object id="W1" type="Plant/ProcessEquipment.Warp"/>') +
        components(
          'PipingNetworkSystems',
          `<Object id="L1" type="Plant/Piping.PipingNetworkSystem">${components('Segments', segment)}</Object>`,
        ),
    );
    const result = importOf(text);
    expect(result.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['DEXPI_UNMAPPED_CLASS', 'DEXPI_DANGLING_REFERENCE']));
    expect(result.warnings.find((w) => w.message.includes('"Mystery"'))).toBeDefined();
    expect(result.warnings.find((w) => w.message.includes('"Warp"'))?.paths[0]).toMatch(/^line \d+/);
    const items = Object.values(apply(empty, 'import_dexpi', { text }).plant?.pid?.items ?? {});
    expect(items.find((item) => item.sourceId === 'W1')).toMatchObject({
      dexpiClass: 'Custom',
      passthrough: { 'dexpi:ComponentClass': 'Warp' },
    });
  });

  it('reads quantities with their unit, enumerations with their value, text, and an unknown unit as unverified text', () => {
    const quantity = (property: string, unit: string, value: string): string =>
      `<Data property="${property}"><AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity"><Data property="Unit"><DataReference data="Core/PhysicalQuantities.PressureGaugeUnit.${unit}"/></Data><Data property="Value"><Double>${value}</Double></Data></AggregatedDataValue></Data>`;
    const text = MODEL(
      components(
        'TaggedPlantItems',
        tank(
          'T1',
          quantity('UpperLimitDesignPressure', 'Bar', '16.5') +
            quantity('LowerLimitDesignPressure', 'Furlong', '3') +
            '<Data property="Location"><DataReference data="Plant/Enumerations.LocationClassification.Field"/></Data><Data property="TagName"><String>T-1</String></Data>',
        ),
      ),
    );
    expect(importOf(text).warnings.some((w) => w.code === 'DEXPI_ATTRIBUTE_UNIT')).toBe(true);
    const found = Object.values(apply(empty, 'import_dexpi', { text }).plant?.pid?.items ?? {}).find((item) => item.kind === 'equipment');
    expect(found?.attributes).toMatchObject({
      UpperLimitDesignPressure: { kind: 'quantity', value: 16.5, unit: 'Bar' },
      LowerLimitDesignPressure: { kind: 'text', value: '3 Furlong', unverified: true },
      LocationSpecialization: { kind: 'enum', value: 'Field' },
      TagNameAssignmentClass: { kind: 'text', value: 'T-1' },
    });
    expect(found?.tag).toBe('T-1');
  });

  it('takes ids and property names like constructor and __proto__ as plain data (no prototype pollution, no throw)', () => {
    const hostile = ['constructor', '__proto__', 'toString']
      .map((id) =>
        tank(
          id,
          `<Data property="constructor"><Double>1</Double></Data><Data property="__proto__"><String>x</String></Data><Data property="toString"><AggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity"><Data property="Unit"><DataReference data="Core/PhysicalQuantities.PressureGaugeUnit.Bar"/></Data><Data property="Value"><Double>2</Double></Data></AggregatedDataValue></Data><References objects="#${id}" property="constructor"/>`,
        ),
      )
      .join('');
    const segment =
      '<Object id="hasOwnProperty" type="Plant/Piping.PipingNetworkSegment"><References objects="#constructor" property="SourceItem"/></Object>';
    const text = MODEL(
      components('TaggedPlantItems', hostile) +
        components(
          'PipingNetworkSystems',
          `<Object id="valueOf" type="Plant/Piping.PipingNetworkSystem">${components('Segments', segment)}</Object>`,
        ),
    );
    const items = Object.values(apply(empty, 'import_dexpi', { text }).plant?.pid?.items ?? {});
    expect(items.filter((item) => item.kind === 'equipment').map((item) => item.sourceId)).toEqual([
      'constructor',
      '__proto__',
      'toString',
    ]);
    expect(items.find((item) => item.kind === 'segment')?.from).toMatchObject({ type: 'free' });
    expect(Object.keys(Object.prototype)).toEqual([]);
    const equipment = items.find((item) => item.kind === 'equipment');
    expect(Object.keys(equipment?.attributes ?? {}).sort()).toEqual([
      '__proto__AssignmentClass',
      'attr:toString',
      'constructorAssignmentClass',
    ]);
  });

  it('keeps a 2 MB value as one attribute', () => {
    const big = tank('T1', `<Data property="Note"><String>${'x'.repeat(2_000_000)}</String></Data>`);
    const result = execute(empty, 'import_dexpi', { text: MODEL(components('TaggedPlantItems', big)) });
    expect(result.rejected).toBeUndefined();
    const note = Object.values(result.document.plant?.pid?.items ?? {})[0]?.attributes['NoteAssignmentClass'];
    expect(note?.kind === 'text' ? note.value.length : 0).toBe(2_000_000);
  });
});

describe('import_dexpi: a 2.0 border that fits no standard sheet', () => {
  const border = (width: number, height: number): string =>
    `<Components property="Diagram"><Object type="Core/Diagram.Diagram"><Components property="Groups"><Object type="Core/Diagram.Border"><Components property="Elements"><Object type="Core/Diagram.PolyLine"><Data property="Points">` +
    [
      [0, 0],
      [width, height],
    ]
      .map(
        ([x, y]) =>
          `<AggregatedDataValue type="Core/Diagram.Point"><Data property="X"><Double>${x}</Double></Data><Data property="Y"><Double>${y}</Double></Data></AggregatedDataValue>`,
      )
      .join('') +
    `</Data></Object></Components></Object></Components></Object></Components>`;
  const withBorder = (width: number, height: number): string =>
    MODEL(components('TaggedPlantItems', tank('T1'))).replace(
      '</Object></Components></Object></Model>',
      `</Object></Components>${border(width, height)}</Object></Model>`,
    );

  it('warns (DEXPI_SHEET_SIZE) and takes A1, the sheet the mapper picks, as the frame', () => {
    const text = withBorder(2000, 1500);
    expect(importOf(text).warnings.find((w) => w.code === 'DEXPI_SHEET_SIZE')?.message).toContain('fits no sheet');
    const pid = apply(empty, 'import_dexpi', { text }).plant?.pid;
    expect(pid?.sheets[pid.sheetOrder[0] ?? '']?.paper).toBe('A1');
  });

  it('does not warn for a border that fits (A4) or for no border at all', () => {
    expect(importOf(withBorder(297, 210)).warnings.some((w) => w.code === 'DEXPI_SHEET_SIZE')).toBe(false);
    const pid = apply(empty, 'import_dexpi', { text: withBorder(297, 210) }).plant?.pid;
    expect(pid?.sheets[pid.sheetOrder[0] ?? '']?.paper).toBe('A4');
    expect(importOf(MODEL(components('TaggedPlantItems', tank('T1')))).warnings.some((w) => w.code === 'DEXPI_SHEET_SIZE')).toBe(false);
  });
});
