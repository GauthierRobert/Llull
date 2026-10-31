/** Plant 04 PID M3: update_pid_item, renumber_pid_lines, and the contract of every authoring command (pure, valid after each step, replay). */

import { describe, expect, it } from 'vitest';
import { pidPlugin } from '@aec/index';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { FEED_PUMP, FEED_PUMP_CONTROL, byTag, feedPump, feedPumpControlled, ofKind, runSteps, segmentsOfLine } from './authoringFixtures';

const SUCTION = '100-P-1001-A1';
const DISCHARGE = '80-P-1002-A1';

const orthogonal = (route: ReadonlyArray<readonly [number, number]>): boolean =>
  route.every(
    (p, i) => i === 0 || Math.abs(p[0] - (route[i - 1]?.[0] ?? NaN)) < 1e-9 || Math.abs(p[1] - (route[i - 1]?.[1] ?? NaN)) < 1e-9,
  );

describe('update_pid_item', () => {
  it('moves equipment: nozzle ports follow and the attached line re-routes its end leg orthogonally', () => {
    const result = ok(feedPump(), 'update_pid_item', { item: 'T-101', set: { at: [70, 150] } });
    const doc = result.document;
    expect(byTag(doc, 'T-101')).toMatchObject({ at: [70, 150] });
    expect(
      ofKind(doc, 'nozzle')
        .filter((n) => n.port[0] === 70)
        .map((n) => n.port),
    ).toEqual([
      [70, 125],
      [70, 175],
    ]);
    const route = segmentsOfLine(doc, SUCTION)[0]?.route ?? [];
    expect(route[0]).toEqual([70, 125]);
    expect(route.at(-1)).toEqual([140, 80]);
    expect(orthogonal(route)).toBe(true);
    expect(result.affected).toHaveLength(3);
  });

  it('rotates equipment about its centre and moves sub-equipment with its parent', () => {
    const doc = apply(feedPump(), 'update_pid_item', { item: 'T-101', set: { rotationDeg: 90 } });
    const n1 = ofKind(doc, 'nozzle').find((n) => n.subTag === 'N1' && n.dn === 100 && n.port[1] === 150);
    expect(n1?.port[0]).toBeCloseTo(85, 9);
    expect(byTag(doc, 'T-101')).toMatchObject({ rotationDeg: 90 });
    const parent = feedPump();
    const child = {
      ...ofKind(parent, 'equipment')[0],
      id: 'pid-child',
      tag: 'SUB-1',
      parentId: ofKind(parent, 'equipment')[0]?.id,
      at: [60, 160] as [number, number],
    };
    const withChild: CadDocument = {
      ...parent,
      plant: {
        ...parent.plant,
        pid: {
          ...(parent.plant?.pid as NonNullable<NonNullable<CadDocument['plant']>['pid']>),
          items: { ...parent.plant?.pid?.items, 'pid-child': child as never },
          itemOrder: [...(parent.plant?.pid?.itemOrder ?? []), 'pid-child'],
        },
      },
    };
    const moved = apply(withChild, 'update_pid_item', { item: 'T-101', set: { at: [70, 150] } });
    expect(moved.plant?.pid?.items['pid-child']).toMatchObject({ at: [70, 160] });
  });

  it('moves an instrument and re-routes its signal; moves an off-page connector with its segment end', () => {
    let doc = apply(feedPumpControlled(), 'update_pid_item', { item: 'FIC-101', set: { at: [230, 190] } });
    const electric = ofKind(doc, 'signal').find((s) => s.signalKind === 'electric');
    expect(electric?.route.at(-1)).toEqual([230, 190]);
    doc = apply(doc, 'update_pid_item', { item: ofKind(doc, 'opc')[0]?.id ?? '', set: { at: [300, 150] } });
    const last = segmentsOfLine(doc, DISCHARGE).at(-1)?.route ?? [];
    expect(last.at(-1)).toEqual([300, 150]);
    expect(orthogonal(last)).toBe(true);
  });

  it('retags (instrument tags are re-split), changes attributes, dn, class and line fields; a line dn / class reaches the segments that carried the old value', () => {
    let doc = apply(feedPumpControlled(), 'update_pid_item', {
      item: 'FT-101',
      set: { tag: 'PT-102', attributes: { Range: { value: 10, unit: 'bar' } } },
    });
    expect(byTag(doc, 'PT-102')).toMatchObject({ category: 'P', functions: 'T', loopNumber: '102' });
    expect(byTag(doc, 'PT-102').attributes['Range']).toMatchObject({ kind: 'quantity', value: 10 });
    const result = ok(doc, 'update_pid_item', {
      item: DISCHARGE,
      set: { dn: 100, pipingClass: 'B1', fluidCode: 'W', lineNumber: '100-W-1' },
    });
    doc = result.document;
    expect(ofKind(doc, 'line').find((l) => l.lineNumber === '100-W-1')).toMatchObject({ dn: 100, pipingClass: 'B1', fluidCode: 'W' });
    expect(segmentsOfLine(doc, '100-W-1').map((s) => [s.dn, s.pipingClass])).toEqual(Array(3).fill([100, 'B1']));
    expect(result.affected).toHaveLength(4);
    doc = apply(doc, 'update_pid_item', { item: 'HV-102', set: { dn: 65, pipingClass: 'C3', tag: 'HV-202' } });
    expect(byTag(doc, 'HV-202')).toMatchObject({ dn: 65, pipingClass: 'C3' });
    const nozzle = ofKind(doc, 'nozzle')[0];
    expect(byTag(apply(doc, 'update_pid_item', { item: nozzle?.id ?? '', set: { dn: 40 } }), 'T-101')).toBeDefined();
    const seg = ofKind(doc, 'segment')[0];
    expect(ofKind(apply(doc, 'update_pid_item', { item: seg?.id ?? '', set: { dn: 40, pipingClass: 'Z' } }), 'segment')[0]).toMatchObject({
      dn: 40,
      pipingClass: 'Z',
    });
  });

  it('refuses a missing item, an empty set, a field that does not apply, and a used tag or line number', () => {
    const doc = feedPumpControlled();
    expectRefusal(doc, 'update_pid_item', { item: 'X-404', set: { dn: 50 } }, 'PID_ITEM_NOT_FOUND', 'item');
    expectRefusal(doc, 'update_pid_item', { item: 'T-101', set: {} }, 'PID_PARAM_INVALID', 'set');
    expectRefusal(doc, 'update_pid_item', { item: 'HV-102', set: { at: [1, 1] } }, 'PID_ITEM_KIND', 'set.at');
    expectRefusal(doc, 'update_pid_item', { item: 'T-101', set: { fluidCode: 'W' } }, 'PID_ITEM_KIND', 'set.fluidCode');
    expectRefusal(doc, 'update_pid_item', { item: 'T-101', set: { tag: 'P-101' } }, 'PID_TAG_DUPLICATE', 'set.tag');
    expectRefusal(doc, 'update_pid_item', { item: 'FT-101', set: { tag: 'xx' } }, 'PID_TAG_FORMAT', 'set.tag');
    expectRefusal(doc, 'update_pid_item', { item: DISCHARGE, set: { lineNumber: SUCTION } }, 'PID_LINE_NUMBER_DUPLICATE', 'set.lineNumber');
  });

  it('retags with its own tag (not a duplicate of itself)', () => {
    expect(byTag(apply(feedPump(), 'update_pid_item', { item: 'T-101', set: { tag: 'T-101' } }), 'T-101')).toBeDefined();
  });
});

describe('renumber_pid_lines', () => {
  it('numbers from the template in sheet, then y, then x order (the discharge line starts lower on the sheet)', () => {
    const result = ok(feedPump(), 'renumber_pid_lines', { startSeq: 1001 });
    const doc = result.document;
    expect(ofKind(doc, 'line').map((l) => l.lineNumber)).toEqual(['100-P-1002-A1', '80-P-1001-A1']);
    expect(
      data<{ renumbered: Array<{ from: string; to: string }> }>(feedPump(), 'renumber_pid_lines', {}).renumbered.map((r) => r.to),
    ).toEqual(['80-P-1-A1', '100-P-2-A1']);
    expect(result.affected).toHaveLength(2);
  });

  it('uses a given template and scope, skips lines that lack a field, and reports them', () => {
    let doc = apply(feedPump(), 'create_pid_sheet', { number: 'PID-002' });
    doc = apply(doc, 'add_pid_line', { sheet: 'PID-002', from: { free: [0, 0] }, to: { free: [50, 0] }, dn: 25 });
    const all = ok(doc, 'renumber_pid_lines', { format: '{dn}-{seq}-{class}' });
    const report = all.data as { renumbered: unknown[]; skipped: Array<{ missing: string[] }> };
    expect(report.renumbered).toHaveLength(2);
    expect(report.skipped).toEqual([expect.objectContaining({ missing: ['class'] })]);
    const scoped = ok(doc, 'renumber_pid_lines', { format: '{dn}/{seq}', scope: 'PID-002', startSeq: 7 });
    expect(ofKind(scoped.document, 'line').map((l) => l.lineNumber)).toEqual([SUCTION, DISCHARGE, '25/7']);
  });

  it('refuses an unknown token, an unknown scope, a number equal to one left out, and a template without a sequence', () => {
    const doc = feedPump();
    expectRefusal(doc, 'renumber_pid_lines', { format: '{x}' }, 'PID_LINE_NUMBER_FORMAT', 'format');
    expectRefusal(doc, 'renumber_pid_lines', { scope: 'PID-404' }, 'PID_SHEET_NOT_FOUND', 'scope');
    expectRefusal(doc, 'renumber_pid_lines', { format: '{class}' }, 'PID_LINE_NUMBER_DUPLICATE', 'format');
    const kept = apply(doc, 'add_pid_line', { sheet: 'PID-001', from: { free: [0, 0] }, to: { free: [50, 0] }, lineNumber: '80-P-1-A1' });
    expectRefusal(kept, 'renumber_pid_lines', {}, 'PID_LINE_NUMBER_DUPLICATE', 'format');
  });
});

describe('contract of the authoring commands', () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['create_pid_sheet', { number: 'PID-009' }],
    ['add_pid_equipment', { sheet: 'PID-001', class: 'Tank', tag: 'T-9', at: [400, 100], nozzles: [{ subTag: 'N1', side: 'left' }] }],
    ['add_pid_nozzle', { equipment: 'P-101', subTag: 'N7', side: 'bottom' }],
    ['add_pid_line', { sheet: 'PID-001', from: { free: [0, 0] }, to: { free: [0, 40] }, lineNumber: 'L-9' }],
    ['add_pid_inline', { line: SUCTION, at: [100, 80], class: 'GateValve', tag: 'GV-1' }],
    ['add_pid_instrument', { sheet: 'PID-001', tag: 'PT-1', at: [10, 10], location: 'field', measures: { line: SUCTION, at: [100, 80] } }],
    ['add_pid_signal_line', { from: 'FT-101', to: 'FIC-101', kind: 'software' }],
    ['add_pid_actuating_system', { valve: 'HV-102', actuator: 'motor' }],
    ['update_pid_item', { item: 'P-101', set: { at: [170, 90], rotationDeg: 180 } }],
    ['delete_pid_item', { item: 'HV-102' }],
    ['reverse_pid_flow', { line: DISCHARGE }],
    ['renumber_pid_lines', { startSeq: 5 }],
    ['set_pid_conventions', { convention: 'ISO-10628-2' }],
  ];

  it.each(calls)('%s is pure, leaves a document the plugin accepts, and survives save and load', (name, params) => {
    const before = feedPumpControlled();
    const snapshot = JSON.stringify(before);
    const result = ok(before, name, params);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(result.document).not.toBe(before);
    const pid = JSON.parse(JSON.stringify(result.document.plant?.pid)) as unknown;
    expect(pidPlugin.document?.validate({ plant: { pid } }), result.summary).toEqual([]);
    const loaded = deserializeDocument(serializeDocument(result.document));
    expect(loaded.plant?.pid).toEqual(result.document.plant?.pid);
  });

  it('replays the history of a whole authored P&ID to the same document, ids included', () => {
    const { doc } = runSteps([...FEED_PUMP, ...FEED_PUMP_CONTROL]);
    expect(execute(doc, 'replay_history', {}).document.plant?.pid).toEqual(doc.plant?.pid);
    const again = runSteps([...FEED_PUMP, ...FEED_PUMP_CONTROL]).doc;
    expect(again.plant?.pid).toEqual(doc.plant?.pid);
  });

  it('renumbering an empty P&ID changes nothing', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'renumber_pid_lines', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('does not touch the document when a command is refused (same object, nothing affected)', () => {
    const doc = createEmptyDocument();
    for (const [name, params] of calls.filter(([name]) => !/^(create_pid_sheet|set_pid_conventions|renumber_pid_lines)$/.test(name))) {
      const result = execute(doc, name, params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
  });
});
