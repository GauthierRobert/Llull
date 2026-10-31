/** Plant 04 PID M5: author -> export_dexpi -> import_dexpi on the SC-PID-02 sheet, and what the round trip does not keep. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import { PID_PACK, countsOf } from './dexpiFixtures';
import { byTag, ofKind, runSteps, type Step } from './authoringFixtures';

const plan = JSON.parse(readFileSync(path.join(PID_PACK, 'plans/sc-pid-02-author-and-validate.json'), 'utf8')) as { actions: Step[] };
const authored = runSteps(plan.actions).doc;

const exported = (doc: CadDocument): { text: string; warnings: Array<{ code: string }> } => data(doc, 'export_dexpi', { version: '1.3' });
const reimport = (doc: CadDocument): CadDocument => apply(createEmptyDocument(), 'import_dexpi', { text: exported(doc).text });
const rows = (doc: CadDocument, kind: string): Array<Record<string, unknown>> =>
  data<{ rows: Array<Record<string, unknown>> }>(doc, 'pid_report', { kind }).rows;

describe('SC-PID-02 sheet: author -> export -> import', () => {
  const again = reimport(authored);

  it('keeps the census and every list that names tags, lines, sizes and classes', () => {
    const before = countsOf(authored);
    const after = countsOf(again);
    for (const key of Object.keys(before)) if (key !== 'connections') expect(after[key], key).toBe(before[key]);
    expect(after['connections']).toBe(before['pipingNetworkSegments']! + before['informationFlows']!);
    for (const kind of ['valve_list', 'instrument_index', 'equipment_list', 'nozzle_list'])
      expect(rows(again, kind), kind).toEqual(rows(authored, kind));
    const strip = (list: Array<Record<string, unknown>>): unknown[] => list.map(({ segments: _s, ...rest }) => rest);
    expect(strip(rows(again, 'line_list'))).toEqual(strip(rows(authored, 'line_list')));
  });

  it('keeps the connectivity of every tagged end (items without a tag are labelled by file id and differ)', () => {
    const tagged = (doc: CadDocument): unknown[] =>
      rows(doc, 'connectivity').filter((row) => !String(row['from']).startsWith('pid-') && !String(row['to']).startsWith('pid-'));
    expect(tagged(authored).length).toBeGreaterThanOrEqual(5);
    const normal = (list: unknown[]): unknown[] =>
      list.map((row) => ({
        ...(row as object),
        from: String((row as { from: string }).from).replace(/^branch:.*/, 'branch'),
        to: String((row as { to: string }).to).replace(/^branch:.*/, 'branch'),
      }));
    // Row order is the model order: an import lists segments before information flows, authoring interleaves them in creation order.
    const sorted = (list: unknown[]): string[] =>
      normal(list)
        .map((row) => JSON.stringify(row))
        .sort();
    expect(sorted(tagged(again))).toEqual(sorted(tagged(authored)));
  });

  it('keeps the typed fields: sizes, classes, reversed / operated flags, display, fail action, controller, location', () => {
    expect(byTag(again, 'HV-103')).toMatchObject({ dn: 50, dexpiClass: 'GlobeValve' });
    expect(byTag(again, 'HV-104')).toMatchObject({ pipingClass: 'B2' });
    expect(byTag(again, 'CV-105')).toMatchObject({ reversed: true });
    expect(byTag(again, 'XV-106')).toMatchObject({ operated: true });
    expect(byTag(again, 'FIC-101')).toMatchObject({
      display: 'shared',
      location: 'central',
      category: 'F',
      functions: 'IC',
      loopNumber: '101',
    });
    expect(byTag(again, 'FT-101')).toMatchObject({ location: 'field' });
    expect(ofKind(again, 'actuating')[0]).toMatchObject({ actuator: 'diaphragm', failAction: 'FC' });
    const system = ofKind(again, 'actuating')[0];
    expect(system?.kind === 'actuating' ? again.plant?.pid?.items[system.controllerId ?? '']?.tag : undefined).toBe('FIC-101');
    expect(ofKind(again, 'signal').map((s) => (s.kind === 'signal' ? s.signalKind : ''))).toEqual(['measuring', 'electric']);
  });

  it('is a fixed point: a second export of the re-import is byte-identical', () => {
    expect(exported(again).text).toBe(exported(authored).text);
  });

  it('does not keep: the off-page target sheet (kept as a number), the defaulted flags and ids of untagged items', () => {
    const opc = ofKind(again, 'opc')[0];
    expect(opc?.kind === 'opc' ? opc.targetSheet : 'x').toBeUndefined();
    expect(opc?.passthrough?.['pid:targetSheet']).toBe('PID-002');
    expect(byTag(again, 'HV-102').attributes['nominalDiameter']).toBeUndefined();
  });
});
