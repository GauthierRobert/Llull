/** Plant 04 PID M2: pid_report counts / connectivity (VC-PID-05), purity, replay and the SC-PID-01 plan. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { pidPlugin } from '@aec/index';
import { COUNT_KEYS } from '@aec/plant/pid/lists/counts';
import { data, expectRefusal } from '../../../helpers/commandAssertions';
import { C01, PID_PACK, census, countsOf, dexpiText, importFile } from './dexpiFixtures';

interface Connectivity {
  columns: string[];
  rows: Array<Record<string, string>>;
  csv: string;
  summary: {
    processConnections: number;
    informationConnections: number;
    nozzlesTotal: number;
    nozzlesConnected: number;
    nozzlesUnconnected: string[];
    endpointTypes: Record<string, number>;
  };
}

const c01 = importFile(C01);
const connectivity = data<Connectivity>(c01, 'pid_report', { kind: 'connectivity' });

describe('pid_report kind=connectivity on C01 (VC-PID-05)', () => {
  it('has 23 piping + 6 information-flow connections, 17 of 19 nozzles connected, T4750 N3 and N8 unconnected', () => {
    expect(connectivity.summary).toMatchObject({
      processConnections: 23,
      informationConnections: 6,
      nozzlesTotal: census.C01connectivity.nozzlesTotal,
      nozzlesConnected: census.C01connectivity.nozzlesReferencedByConnection,
      nozzlesUnconnected: ['T4750/N3', 'T4750/N8'],
    });
    expect(connectivity.rows).toHaveLength(census.C01connectivity.connections);
  });

  it('has the endpoint-type histogram of the census, entry for entry', () => {
    expect(connectivity.summary.endpointTypes).toEqual(census.C01connectivity.endpointTypes);
  });

  it('names ends by tag, OPC pair key and free, and carries the line number', () => {
    expect(connectivity.columns).toEqual(['from', 'fromType', 'to', 'toType', 'via', 'lineNumber']);
    const first = connectivity.rows[0];
    expect(first).toMatchObject({
      from: 'OPC:FlowInPipeOffPageConnector-1',
      fromType: 'PipeOffPageConnector:FlowInPipeOffPageConnector',
      via: 'segment',
      lineNumber: '47121',
    });
    expect(first?.to).toMatch(/^[A-Z]\d{4}\/N\d+$/);
    expect(connectivity.rows.filter((r) => r['via'] === 'information_flow')).toHaveLength(6);
    expect(connectivity.rows.some((r) => r['from'] === 'free' && r['fromType'] === 'open')).toBe(true);
    expect(connectivity.csv.split('\n')[0]).toBe('from,fromType,to,toType,via,lineNumber');
    expect(connectivity.csv.split('\n')).toHaveLength(30 + 1);
  });

  it('is deterministic: two imports give identical reports', () => {
    expect(data(importFile(C01), 'pid_report', { kind: 'connectivity' })).toEqual(connectivity);
  });
});

describe('pid_report kind=counts', () => {
  it('lists every census key in the census order, with a CSV', () => {
    const result = data<{ columns: string[]; rows: Array<{ key: string; value: number }>; csv: string; counts: Record<string, number> }>(
      c01,
      'pid_report',
      { kind: 'counts' },
    );
    expect(result.columns).toEqual(['key', 'value']);
    expect(result.rows.map((r) => r.key)).toEqual([...COUNT_KEYS]);
    expect(result.counts).toEqual(census.proteus13[0]?.counts);
    expect(result.csv.split('\n').slice(0, 3)).toEqual(['key,value', 'equipmentTopLevel,5', 'equipmentAll,16']);
  });

  it('answers zeros on a document with no P&ID', () => {
    const counts = countsOf(createEmptyDocument());
    expect(Object.keys(counts)).toEqual([...COUNT_KEYS]);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    const result = data<Connectivity>(createEmptyDocument(), 'pid_report', { kind: 'connectivity' });
    expect(result.rows).toEqual([]);
    expect(result.summary).toMatchObject({ nozzlesTotal: 0, nozzlesUnconnected: [] });
  });

  it('sums over imports and filters by sheet number or id', () => {
    const both = importFile('C02V03-VER.EX02.xml', c01);
    const second = census.proteus13[1]?.counts ?? {};
    const first = census.proteus13[0]?.counts ?? {};
    const total = countsOf(both);
    for (const key of COUNT_KEYS) expect(total[key], key).toBe((first[key] ?? 0) + (second[key] ?? 0));
    expect(data<{ counts: unknown }>(both, 'pid_report', { kind: 'counts', sheet: 'PID-002' }).counts).toEqual(second);
    const sheetId = both.plant?.pid?.sheetOrder[0] ?? '';
    expect(data<{ counts: unknown }>(both, 'pid_report', { kind: 'counts', sheet: sheetId }).counts).toEqual(first);
    const part = data<Connectivity>(both, 'pid_report', { kind: 'connectivity', sheet: 'PID-002' });
    expect(part.summary.processConnections).toBe(9);
    expect(part.summary.informationConnections).toBe(4);
  });

  it('refuses an unknown sheet with PID_SHEET_NOT_FOUND', () => {
    expectRefusal(c01, 'pid_report', { kind: 'counts', sheet: 'PID-009' }, 'PID_SHEET_NOT_FOUND', 'sheet');
    expect(execute(c01, 'pid_report', { kind: 'line_list', sheet: 'PID-009' }).rejected).toBe(true);
  });
});

describe('purity, persistence and replay', () => {
  it('is pure: the input document is not changed and the output is a new document', () => {
    const before = JSON.stringify(c01);
    const text = dexpiText('C02V03-VER.EX02.xml');
    const result = execute(c01, 'import_dexpi', { text });
    expect(JSON.stringify(c01)).toBe(before);
    expect(result.document).not.toBe(c01);
    const report = execute(c01, 'pid_report', { kind: 'counts' });
    expect(report.document).toBe(c01);
    expect(report.affected).toEqual([]);
    expect(JSON.stringify(c01)).toBe(before);
  });

  it('creates ids step-scoped and deterministic, and replay of the history re-mints the same P&ID', () => {
    const doc = importFile('C02V03-VER.EX02.xml', c01);
    const again = importFile('C02V03-VER.EX02.xml', importFile(C01));
    expect(again.plant?.pid).toEqual(doc.plant?.pid);
    const ids = doc.plant?.pid?.itemOrder ?? [];
    expect(ids.filter((id) => id.startsWith('pid-1.'))).toHaveLength(127);
    expect(ids.filter((id) => id.startsWith('pid-2.')).length).toBeGreaterThan(50);
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(replayed.plant?.pid).toEqual(doc.plant?.pid);
  });

  it('survives a save / load round trip through the plugin validation, all 11 files', () => {
    for (const entry of census.proteus13) {
      const pid = importFile(entry.file).plant?.pid;
      expect(pidPlugin.document?.validate({ plant: JSON.parse(JSON.stringify({ pid })) as unknown }), entry.file).toEqual([]);
    }
  });

  it('validates the import record fields it adds (sheetId, census)', () => {
    const validate = (patch: Record<string, unknown>): string[] => {
      const pid = JSON.parse(JSON.stringify(c01.plant?.pid)) as { imports: Array<Record<string, unknown>> };
      Object.assign(pid.imports[0] ?? {}, patch);
      return pidPlugin.document?.validate({ plant: { pid } }) ?? [];
    };
    expect(validate({ sheetId: 'pid-9.9' })).toEqual(['plant.pid.imports[0].sheetId must name a sheet']);
    expect(validate({ census: { connections: -1 } })).toEqual(['plant.pid.imports[0].census must map names to non-negative integers']);
    expect(validate({ census: 3 })).toEqual(['plant.pid.imports[0].census must map names to non-negative integers']);
    expect(validate({ census: { constructor: 1 } })).toEqual(['plant.pid.imports[0].census must map names to non-negative integers']);
  });
});

describe('SC-PID-01 plan (import, then the counts of the reference P&ID)', () => {
  interface Plan {
    actions: Array<{ command: string; params: Record<string, unknown> }>;
    expected: Array<{ step: number; path: string; value: unknown; abs?: number }>;
  }
  const plan = JSON.parse(readFileSync(path.join(PID_PACK, 'plans/sc-pid-01-import-dexpi-reference.json'), 'utf8')) as Plan;

  it('runs its built steps and meets every expected row they answer', () => {
    let doc: CadDocument = createEmptyDocument();
    const outcomes = plan.actions.map((action) => {
      const file = typeof action.params['text'] === 'string' ? /^@file:(.+)$/.exec(action.params['text'])?.[1] : undefined;
      const params =
        file === undefined
          ? action.params
          : { ...action.params, text: readFileSync(path.join(PID_PACK, file.replace(/^validation\//, '')), 'utf8') };
      const result = execute(doc, action.command, params);
      doc = result.document;
      return result.rejected === true ? null : { data: result.data };
    });
    // Steps 2..6 (the lists and check_pid, M4) are asserted in checkScenario.test.ts.
    expect(outcomes.every((outcome) => outcome !== null && outcome !== undefined)).toBe(true);
    const pick = (root: unknown, expression: string): unknown =>
      expression.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], root);
    const rows = plan.expected.filter((row) => row.step < 2);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const row of rows) expect(pick(outcomes[row.step], row.path), row.path).toEqual(row.value);
  });
});
