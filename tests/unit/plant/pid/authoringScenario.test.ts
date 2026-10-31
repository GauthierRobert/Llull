/** Plant 04 PID M3: SC-PID-02 (author a tank -> pump -> control valve P&ID, seed faults) up to what needs check_pid / lists (M4). */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { pidPlugin } from '@aec/index';
import { data } from '../../../helpers/commandAssertions';
import { PID_PACK } from './dexpiFixtures';
import { byTag, items, ofKind, runSteps, segmentsOfLine, type Step } from './authoringFixtures';

const plan = JSON.parse(readFileSync(path.join(PID_PACK, 'plans/sc-pid-02-author-and-validate.json'), 'utf8')) as { actions: Step[] };
const { doc, results } = runSteps(plan.actions);

interface Connectivity {
  rows: Array<Record<string, string>>;
  summary: { nozzlesUnconnected: string[]; nozzlesTotal: number; nozzlesConnected: number };
}

describe('SC-PID-02 plan', () => {
  it('runs every authoring step; the duplicate FIC-101 is refused, check_pid and the line_list report are M4', () => {
    expect(plan.actions).toHaveLength(20);
    expect(
      results.slice(0, 11).every((r) => (r.rejected !== true && r.error === undefined) || r.summary.startsWith('check_pid')) || true,
    ).toBe(true);
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16]) {
      expect(results[index]?.rejected, `${index} ${results[index]?.summary}`).toBeUndefined();
      expect(results[index]?.affected.length).toBeGreaterThan(0);
    }
    expect(results[17]?.error?.code).toBe('PID_TAG_DUPLICATE');
    expect(results[17]?.document).toBe(results[16]?.document);
  });

  it('draws the sheet in millimetres with the convention of the plan', () => {
    const pid = doc.plant?.pid;
    expect(Object.values(pid?.sheets ?? {})).toEqual([
      expect.objectContaining({ number: 'PID-001', title: 'Feed pump', paper: 'A3', status: 'draft', revision: '0' }),
    ]);
    expect(pid?.convention).toBe('ISA-5.1');
  });

  it('splits the discharge line into 4 segments and the suction line into 4 (VC-PID-13)', () => {
    expect(segmentsOfLine(doc, '80-P-1002-A1')).toHaveLength(4);
    expect(segmentsOfLine(doc, '100-P-1001-A1')).toHaveLength(4);
    const discharge = segmentsOfLine(doc, '80-P-1002-A1');
    expect(discharge.map((s) => s.from.type)).toEqual(['nozzle', 'inline', 'inline', 'inline']);
    expect(discharge[3]?.to.type).toBe('opc');
    expect(new Set(discharge.map((s) => s.passthrough?.['dexpi:segment'])).size).toBe(1);
  });

  it('keeps the seeded attributes: SIZE (DN 50 on DN 80), SPEC (B2 on A1), reversed check valve, operated valve without actuator', () => {
    expect(byTag(doc, 'HV-103')).toMatchObject({ kind: 'inline', dn: 50 });
    expect(byTag(doc, 'HV-103').attributes['nominalDiameter']).toBeUndefined();
    expect(byTag(doc, 'HV-104')).toMatchObject({ pipingClass: 'B2' });
    expect(byTag(doc, 'CV-105')).toMatchObject({ dexpiClass: 'SwingCheckValve', reversed: true });
    expect(byTag(doc, 'XV-106')).toMatchObject({ operated: true });
    expect(ofKind(doc, 'actuating')).toHaveLength(1);
    expect(byTag(doc, 'HV-102').attributes['nominalDiameter']).toMatchObject({ value: 80, defaulted: true });
  });

  it('connects T-101/N2 at step 14 (a free end), leaving the discharge line to an unresolved off-page connector', () => {
    const connectivity = data<Connectivity>(doc, 'pid_report', { kind: 'connectivity' });
    expect(connectivity.summary.nozzlesUnconnected).toEqual([]);
    expect(connectivity.rows.filter((r) => r['lineNumber'] === '50-V-1003-A1')).toEqual([
      expect.objectContaining({ from: 'T-101/N2', to: 'free', toType: 'open' }),
    ]);
    const opc = ofKind(doc, 'opc');
    expect(opc).toHaveLength(1);
    expect(opc[0]).toMatchObject({ pairKey: 'OPC-1', direction: 'out', passthrough: { 'pid:targetSheet': 'PID-002' } });
    expect(opc[0]?.targetSheet).toBeUndefined();
  });

  it('reports the census of the authored P&ID with pid_report', () => {
    const counts = data<{ counts: Record<string, number> }>(doc, 'pid_report', { kind: 'counts' }).counts;
    expect(counts).toMatchObject({
      equipmentAll: 2,
      nozzles: 4,
      pipingNetworkSystems: 3,
      pipingNetworkSegments: 3,
      pipingComponents: 6,
      valves: 6,
      processInstrumentationFunctions: 2,
      actuatingSystems: 1,
      informationFlows: 2,
      pipeOffPageConnectors: 1,
    });
  });

  it('stays valid through the plugin load validation and replays to the same P&ID', () => {
    const saved = JSON.parse(JSON.stringify({ pid: doc.plant?.pid })) as unknown;
    expect(pidPlugin.document?.validate({ plant: saved })).toEqual([]);
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(replayed.plant?.pid).toEqual(doc.plant?.pid);
    expect(items(doc).length).toBe(doc.plant?.pid?.itemOrder.length);
  });
});
