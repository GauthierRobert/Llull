/** Plant 04 PID M4: the five P&ID lists of `pid_report` on the census of the 11 DEXPI files (VC-PID-12), CSV headers, order, filters, refusals, purity, replay. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { C01, census, importFile } from './dexpiFixtures';
import { feedPumpControlled } from './authoringFixtures';

interface Report {
  kind: string;
  columns: string[];
  rows: Array<Record<string, string | number | boolean>>;
  csv: string;
}

const report = (doc: Parameters<typeof data>[0], kind: string, extra: Record<string, unknown> = {}): Report =>
  data<Report>(doc, 'pid_report', { kind, ...extra });

const HEADERS: Record<string, string> = {
  line_list: 'lineNumber,sheet,dn,pipingClass,fluidCode,from,to,segments,insulation,inlineTags',
  valve_list: 'tag,class,lineNumber,dn,pipingClass,actuated,failAction,sheet',
  instrument_index: 'tag,category,functions,loop,location,display,measuredLine,controls,sheet',
  equipment_list: 'tag,class,nozzles,designPressure,designTemperature,sheet',
  nozzle_list: 'equipmentTag,subTag,dn,connectedLine,access',
};

const c01 = importFile(C01);
const c01Census = census.proteus13.find((file) => file.file === C01)!;

describe('lists on C01 (VC-PID-12)', () => {
  it('has the fixed CSV header of every list, even when empty', () => {
    const empty = execute(createEmptyDocument(), 'pid_report', { kind: 'line_list' });
    expect((empty.data as Report).rows).toEqual([]);
    for (const [kind, header] of Object.entries(HEADERS)) {
      const full = report(c01, kind);
      expect(full.columns.join(','), kind).toBe(header);
      expect(full.csv.split('\n')[0], kind).toBe(header);
      expect(report(createEmptyDocument(), kind).csv.trim(), kind).toBe(header);
    }
  });

  it('line list: 11 rows, one per line number of the census with DN, class and fluid', () => {
    const { rows } = report(c01, 'line_list');
    expect(rows).toHaveLength(11);
    expect(rows.map((r) => r['lineNumber'])).toEqual(c01Census.lines.map((l) => l.lineNumber));
    for (const line of c01Census.lines) {
      const row = rows.find((r) => r['lineNumber'] === line.lineNumber);
      expect(row, line.lineNumber).toMatchObject({
        dn: Number(/\d+/.exec(line.nominalDiameter)?.[0]),
        pipingClass: line.pipingClass,
        fluidCode: line.fluidCode,
        sheet: 'PID-001',
      });
    }
    expect(rows.find((r) => r['lineNumber'] === '47121')).toMatchObject({ from: 'OPC:FlowInPipeOffPageConnector-1', to: 'P4711/N1' });
    expect(rows.find((r) => r['lineNumber'] === '47123')).toMatchObject({ from: 'H1007/N2', to: 'T4750/N1', segments: 2 });
    expect(rows.find((r) => r['lineNumber'] === '47130')).toMatchObject({ from: 'free', to: 'H1007/N3' });
  });

  it('valve list: 11 rows by class as in the census, the three actuated valves with their fail action', () => {
    const { rows } = report(c01, 'valve_list');
    expect(rows).toHaveLength(11);
    const byClass: Record<string, number> = {};
    for (const row of rows) byClass[String(row['class'])] = (byClass[String(row['class'])] ?? 0) + 1;
    const wanted = Object.fromEntries(Object.entries(c01Census.pipingComponentsByClass).filter(([cls]) => cls.includes('Valve')));
    expect(byClass).toEqual(wanted);
    expect(byClass).toEqual({ BallValve: 5, GlobeValve: 3, ButterflyValve: 1, SwingCheckValve: 1, SpringLoadedGlobeSafetyValve: 1 });
    expect(rows.filter((r) => r['actuated'] === true).map((r) => [r['tag'], r['failAction']])).toEqual([
      ['GlobeValve-1', 'FC'],
      ['GlobeValve-2', 'FC'],
      ['GlobeValve-3', 'FO'],
    ]);
  });

  it('instrument index: the 4 instruments sorted by tag, with loop, location, what they control', () => {
    const { rows } = report(c01, 'instrument_index');
    expect(rows.map((r) => r['tag'])).toEqual(['HS 4750.01', 'PI 4712.01', 'PICSA 4712.02', 'TICSA 4750.03']);
    expect(rows.map((r) => r['tag']).sort()).toEqual(
      c01Census.instrumentFunctions.map((i) => `${i.category}${i.functions} ${i.number}`).sort(),
    );
    expect(rows.map((r) => r['loop'])).toEqual(['4750.01', '4712.01', '4712.02', '4750.03']);
    expect(rows[3]).toMatchObject({
      category: 'T',
      functions: 'ICSA',
      location: 'central',
      display: 'discrete',
      measuredLine: 'T4750/N7',
      controls: 'GlobeValve-3',
    });
  });

  it('equipment list: the 5 top-level equipment with their nozzle counts and design values from the chambers', () => {
    const { rows } = report(c01, 'equipment_list');
    expect(rows.map((r) => r['tag'])).toEqual(['H1007', 'H1008', 'P4711', 'P4712', 'T4750']);
    for (const equipment of c01Census.equipment)
      expect(
        rows.find((r) => r['tag'] === equipment.tagName),
        equipment.id,
      ).toMatchObject({ class: equipment.class, nozzles: equipment.nozzles });
    expect(rows.every((r) => r['sheet'] === 'PID-001')).toBe(true);
    expect(rows.map((r) => r['designPressure']).some((p) => /\d/.test(String(p)))).toBe(true);
  });

  it('nozzle list: 19 nozzles sorted by equipment tag then natural sub tag; N3 and the manhole N8 have no line', () => {
    const { rows } = report(c01, 'nozzle_list');
    expect(rows).toHaveLength(19);
    expect(rows.map((r) => `${r['equipmentTag']}/${r['subTag']}`).slice(0, 5)).toEqual([
      'H1007/N1',
      'H1007/N2',
      'H1007/N3',
      'H1007/N4',
      'H1008/N1',
    ]);
    expect(rows.filter((r) => r['connectedLine'] === '').map((r) => `${r['equipmentTag']}/${r['subTag']}`)).toEqual([
      'T4750/N3',
      'T4750/N7',
      'T4750/N8',
    ]);
    expect(rows.find((r) => r['subTag'] === 'N8')).toMatchObject({ dn: 800, access: true });
    expect(rows.find((r) => r['equipmentTag'] === 'H1007' && r['subTag'] === 'N1')).toMatchObject({
      dn: 80,
      connectedLine: '47122',
      access: false,
    });
  });

  it('agrees with the census for the other ten files: rows = lines, valves, instruments, top-level equipment, nozzles', () => {
    for (const file of census.proteus13) {
      const doc = importFile(file.file);
      expect(report(doc, 'line_list').rows, file.file).toHaveLength(file.counts['pipingNetworkSystems'] ?? -1);
      expect(report(doc, 'valve_list').rows, file.file).toHaveLength(file.counts['valves'] ?? -1);
      expect(report(doc, 'instrument_index').rows, file.file).toHaveLength(file.counts['processInstrumentationFunctions'] ?? -1);
      expect(report(doc, 'equipment_list').rows, file.file).toHaveLength(file.counts['equipmentTopLevel'] ?? -1);
      expect(report(doc, 'nozzle_list').rows, file.file).toHaveLength(file.counts['nozzles'] ?? -1);
    }
  });
});

describe('CSV, filters and refusals', () => {
  it('writes RFC 4180 rows: one line per row, booleans as true / false, quoting where needed', () => {
    const { csv, rows } = report(c01, 'valve_list');
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(rows.length + 1);
    expect(lines[1]).toBe('BallValve-1,BallValve,47124,50,73HG12,false,,PID-001');
    const quoted = apply(feedPumpControlled(), 'update_pid_item', { item: '80-P-1002-A1', set: { fluidCode: 'P,"Q"' } });
    expect(report(quoted, 'line_list').csv).toContain('"P,""Q"""');
  });

  it('filters rows by column text, case-insensitive, all must match, and says so in the summary', () => {
    const some = execute(c01, 'pid_report', { kind: 'line_list', filter: { dn: '50', pipingClass: '75hb' } });
    expect((some.data as Report).rows.length).toBe(
      c01Census.lines.filter((l) => l.nominalDiameter.includes('50') && l.pipingClass.startsWith('75HB')).length,
    );
    expect(some.summary).toContain('(filtered)');
    expect(report(c01, 'valve_list', { filter: { class: 'ball' } }).rows).toHaveLength(5);
    expect(report(c01, 'counts', { filter: { key: 'nozzles' } }).rows).toEqual([{ key: 'nozzles', value: 19 }]);
    expect(report(c01, 'connectivity', { filter: { via: 'information_flow' } }).rows).toHaveLength(6);
  });

  it('limits a list to one sheet', () => {
    const two = importFile(C01, importFile('C02V03-VER.EX02.xml'));
    expect(report(two, 'equipment_list').rows.length).toBeGreaterThan(5);
    expect(report(two, 'equipment_list', { sheet: 'PID-001' }).rows.length).toBe(
      report(importFile('C02V03-VER.EX02.xml'), 'equipment_list').rows.length,
    );
    expect(report(two, 'equipment_list', { sheet: 'PID-002' }).rows).toHaveLength(5);
  });

  it('refuses an unknown sheet and an unknown filter column (code, path, document unchanged)', () => {
    expectRefusal(c01, 'pid_report', { kind: 'line_list', sheet: 'PID-009' }, 'PID_SHEET_NOT_FOUND', 'sheet');
    for (const kind of ['counts', 'connectivity', 'line_list', 'valve_list', 'instrument_index', 'equipment_list', 'nozzle_list'])
      expectRefusal(c01, 'pid_report', { kind, filter: { nope: 'x' } }, 'PID_PARAM_INVALID', 'filter');
    expect(execute(c01, 'pid_report', { kind: 'tag_list' }).rejected).toBe(true);
  });
});

describe('authored P&ID lists', () => {
  const doc = feedPumpControlled();

  it('lists the feed pump: valves with the actuated control valve, the instrument index with its measured line and controlled valve', () => {
    expect(
      report(doc, 'valve_list').rows.map((r) => [r['tag'], r['lineNumber'], r['dn'], r['pipingClass'], r['actuated'], r['failAction']]),
    ).toEqual([
      ['FV-101', '80-P-1002-A1', 80, 'A1', true, 'FC'],
      ['HV-102', '80-P-1002-A1', 80, 'A1', false, ''],
    ]);
    expect(report(doc, 'instrument_index').rows.map((r) => [r['tag'], r['loop'], r['measuredLine'], r['controls']])).toEqual([
      ['FIC-101', 'F-101', '', 'FV-101'],
      ['FT-101', 'F-101', 'tee:80-P-1002-A1', ''],
    ]);
    expect(report(doc, 'nozzle_list').rows.map((r) => `${r['equipmentTag']}/${r['subTag']}:${r['connectedLine']}`)).toEqual([
      'P-101/N1:100-P-1001-A1',
      'P-101/N2:80-P-1002-A1',
      'T-101/N1:100-P-1001-A1',
      'T-101/N2:',
    ]);
    expect(report(doc, 'equipment_list').rows.map((r) => [r['tag'], r['class'], r['nozzles']])).toEqual([
      ['P-101', 'CentrifugalPump', 2],
      ['T-101', 'Tank', 2],
    ]);
    expect(report(doc, 'line_list').rows.find((r) => r['lineNumber'] === '80-P-1002-A1')).toMatchObject({
      segments: 3,
      inlineTags: 'HV-102 FV-101',
      from: 'P-101/N2',
      to: 'OPC:OPC-1',
    });
  });

  it('orders tags naturally (P-2 before P-10) and breaks ties by id', () => {
    let next = apply(doc, 'add_pid_equipment', { sheet: 'PID-001', class: 'CentrifugalPump', tag: 'P-10', at: [400, 50] });
    next = apply(next, 'add_pid_equipment', { sheet: 'PID-001', class: 'CentrifugalPump', tag: 'P-2', at: [400, 100] });
    expect(report(next, 'equipment_list').rows.map((r) => r['tag'])).toEqual(['P-2', 'P-10', 'P-101', 'T-101']);
  });

  it('is read-only and pure, and the lists survive save / replay', () => {
    const before = JSON.stringify(doc);
    for (const kind of Object.keys(HEADERS)) {
      const result = execute(doc, 'pid_report', { kind });
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(report(execute(doc, 'replay_history', {}).document, kind)).toEqual(report(doc, kind));
    }
    expect(JSON.stringify(doc)).toBe(before);
  });
});
