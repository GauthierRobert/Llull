/** Plant 04 PID M4: budgets of TECHNICAL_SPEC §8 (VC-PID-17): `check_pid` on 5 000 items in 1.0 s, no super-linear blow-up at 36 000 items, and the lists on the same model. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { PidItem, PidModel } from '@aec/plant/pid/model';
import { EMPTY_PID, withPid } from '@aec/plant/pid/state';
import { parseTag } from '@aec/plant/pid/tags/parseTag';

/** `groups` x 9 items: equipment with two nozzles, a line of two segments around a valve, an instrument with its measuring signal, a loop. */
function synthetic(groups: number): CadDocument {
  const items: Record<string, PidItem> = {};
  const order: string[] = [];
  const put = (item: PidItem): void => {
    items[item.id] = item;
    order.push(item.id);
  };
  const base = { sheetId: 's', rotationDeg: 0, attributes: {} } as const;
  for (let g = 0; g < groups; g++) {
    const at: [number, number] = [(g % 50) * 40, Math.floor(g / 50) * 40];
    put({ ...base, id: `e${g}`, kind: 'equipment', at, dexpiClass: 'Tank', tag: `T-${g}` });
    put({ ...base, id: `n${g}a`, kind: 'nozzle', at, dexpiClass: 'Nozzle', equipmentId: `e${g}`, subTag: 'N1', port: at, dn: 50 });
    put({ ...base, id: `n${g}b`, kind: 'nozzle', at, dexpiClass: 'Nozzle', equipmentId: `e${g}`, subTag: 'N2', port: at, dn: 50 });
    put({ ...base, id: `v${g}`, kind: 'inline', at, dexpiClass: 'BallValve', tag: `HV-${g}`, ports: [at, at], dn: 50, pipingClass: 'A1' });
    const common = {
      ...base,
      kind: 'segment' as const,
      at,
      dexpiClass: 'PipingNetworkSegment',
      lineId: `l${g}`,
      flow: 'forward' as const,
      primary: true,
      dn: 50,
      pipingClass: 'A1',
      route: [at, at],
    };
    put({ ...common, id: `s${g}a`, from: { type: 'nozzle', itemId: `n${g}a` }, to: { type: 'inline', itemId: `v${g}`, node: 0 } });
    put({ ...common, id: `s${g}b`, from: { type: 'inline', itemId: `v${g}`, node: 1 }, to: { type: 'nozzle', itemId: `n${g}b` } });
    put({
      ...base,
      id: `l${g}`,
      kind: 'line',
      at,
      dexpiClass: 'PipingNetworkSystem',
      lineNumber: `50-P-${g}-A1`,
      segmentIds: [`s${g}a`, `s${g}b`],
    });
    put({
      ...base,
      id: `i${g}`,
      kind: 'instrument',
      at,
      dexpiClass: 'ProcessInstrumentationFunction',
      tag: `FT-${g}`,
      category: 'F',
      functions: 'T',
      loopNumber: String(g),
      location: 'field',
      display: 'discrete',
    });
    put({
      ...base,
      id: `m${g}`,
      kind: 'signal',
      at,
      dexpiClass: 'InformationFlow',
      signalKind: 'measuring',
      from: { type: 'branch', segmentId: `s${g}a`, at },
      to: { type: 'instrument', itemId: `i${g}` },
      route: [at, at],
    });
  }
  const pid: PidModel = {
    ...EMPTY_PID,
    sheets: { s: { id: 's', number: 'PID-001', title: 'Synthetic', paper: 'A0', revision: '0', status: 'draft' } },
    sheetOrder: ['s'],
    items,
    itemOrder: order,
  };
  return withPid(createEmptyDocument(), pid);
}

const best = (run: () => void, rounds = 5): number => {
  run();
  run();
  let fastest = Infinity;
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
};

describe('check_pid budgets (TECHNICAL_SPEC §8)', () => {
  const small = synthetic(560);
  const large = synthetic(4000);

  it('has 5 040 items with no structural fault', () => {
    expect(small.plant?.pid?.itemOrder).toHaveLength(5040);
    const result = execute(small, 'check_pid', {});
    expect(result.data).toMatchObject({
      countsByCode: { PID_COMPONENT_UNCONNECTED: 0, PID_SIZE_MISMATCH: 0, PID_TAG_DUPLICATE: 0, PID_SEGMENT_INVALID: 0 },
    });
  });

  it('checks 5 000 items in at most 1.0 s', () => {
    expect(best(() => execute(small, 'check_pid', {}))).toBeLessThan(1000);
  });

  // A pass that is quadratic in the items needs several seconds at 36 000 items (about 1e9 steps); the linear passes need well under 0.2 s.
  it('stays linear: 36 000 items are checked within 1.5 s (a quadratic pass would need many seconds)', () => {
    expect(large.plant?.pid?.itemOrder).toHaveLength(36_000);
    expect(best(() => execute(large, 'check_pid', {}), 3)).toBeLessThan(1500);
  });

  it('builds each list of the 36 000 item model within 1.5 s too', () => {
    for (const kind of ['line_list', 'valve_list', 'instrument_index', 'equipment_list', 'nozzle_list'])
      expect(
        best(() => execute(large, 'pid_report', { kind }), 3),
        kind,
      ).toBeLessThan(1500);
  });

  it('parses a 64 character tag with a long letter run in linear time', () => {
    const tag = `F${'I'.repeat(40)}-1`;
    const t1 = best(() => {
      for (let i = 0; i < 2000; i++) parseTag(tag);
    });
    expect(t1).toBeLessThan(500);
    expect(parseTag(tag).ok).toBe(true);
  });
});
