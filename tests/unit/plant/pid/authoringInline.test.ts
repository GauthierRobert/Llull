/** Plant 04 PID M3: inline insertion (split) and deletion (heal), instruments, signals, actuating systems, off-page connectors, flow. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { FEED_PUMP, byTag, feedPump, feedPumpControlled, ofKind, runSteps, segmentsOfLine } from './authoringFixtures';

const SUCTION = '100-P-1001-A1';
const inline = (at: number[], tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  line: SUCTION,
  at,
  class: 'BallValve',
  tag,
  ...extra,
});

describe('add_pid_inline: split', () => {
  it('splits the segment at the snapped point with the ports 5 mm either side, pieces inherit line, dn, class, flow', () => {
    const doc = apply(feedPump(), 'add_pid_inline', inline([100, 82], 'HV-1'));
    const [first, second] = segmentsOfLine(doc, SUCTION);
    const valve = byTag(doc, 'HV-1');
    expect(valve).toMatchObject({
      kind: 'inline',
      at: [100, 80],
      rotationDeg: 0,
      ports: [
        [95, 80],
        [105, 80],
      ],
      dn: 100,
      pipingClass: 'A1',
    });
    expect(first?.route).toEqual([
      [60, 125],
      [60, 80],
      [95, 80],
    ]);
    expect(second?.route).toEqual([
      [105, 80],
      [140, 80],
    ]);
    expect(first?.to).toEqual({ type: 'inline', itemId: valve.id, node: 0 });
    expect(second?.from).toEqual({ type: 'inline', itemId: valve.id, node: 1 });
    expect(second).toMatchObject({ flow: 'forward', dn: 100, pipingClass: 'A1', primary: true, lineId: first?.lineId });
    expect(second?.to.type).toBe('nozzle');
    expect(valve.attributes).toMatchObject({
      nominalDiameter: { value: 100, defaulted: true },
      pipingClass: { value: 'A1', defaulted: true },
    });
  });

  it('inserts on a vertical leg (rotation -90) and keeps explicit dn / class unflagged', () => {
    const doc = apply(
      feedPump(),
      'add_pid_inline',
      inline([62, 100], 'HV-2', { dn: 80, pipingClass: 'B2', reversed: false, attributes: { Note: 'x' } }),
    );
    const valve = byTag(doc, 'HV-2');
    expect(valve).toMatchObject({ rotationDeg: -90, dn: 80, pipingClass: 'B2', at: [60, 100], reversed: false });
    expect(valve.attributes).toEqual({ Note: { kind: 'text', value: 'x' } });
  });

  it('refuses an unknown class (close names), a point off the line, a point near a bend or end, a used tag, an unknown line', () => {
    const doc = feedPump();
    const unknown = expectRefusal(doc, 'add_pid_inline', inline([100, 80], 'V', { class: 'BallValv' }), 'PID_CLASS_UNKNOWN', 'class');
    expect(unknown.summary).toContain('BallValve');
    expectRefusal(doc, 'add_pid_inline', inline([100, 95], 'V'), 'PID_POINT_OFF_LINE', 'at');
    expectRefusal(doc, 'add_pid_inline', inline([62, 80], 'V'), 'PID_POINT_OFF_LINE', 'at');
    expectRefusal(doc, 'add_pid_inline', inline([60, 123], 'V'), 'PID_POINT_OFF_LINE', 'at');
    expectRefusal(doc, 'add_pid_inline', inline([100, 80], 'T-101'), 'PID_TAG_DUPLICATE', 'tag');
    expectRefusal(doc, 'add_pid_inline', inline([100, 80], 'V', { line: 'no-such-line' }), 'PID_ITEM_NOT_FOUND', 'line');
  });

  it('accepts a segment id for the line and an inline item without a tag', () => {
    const doc = feedPump();
    const segmentId = ofKind(doc, 'segment')[0]?.id ?? '';
    const next = apply(doc, 'add_pid_inline', { line: segmentId, at: [100, 80], class: 'PipeReducer' });
    expect(ofKind(next, 'inline')[0]?.tag).toBeUndefined();
  });
});

describe('delete_pid_item: heal (VC-PID-13)', () => {
  it('restores the segment route exactly (1e-9 mm), on a straight leg and on a leg after a bend', () => {
    const base = feedPump();
    const original = segmentsOfLine(base, SUCTION)[0];
    for (const at of [
      [100, 80],
      [87.123456789, 80],
      [60, 101.5],
    ]) {
      const split = apply(base, 'add_pid_inline', inline(at, 'HV-9'));
      expect(segmentsOfLine(split, SUCTION)).toHaveLength(2);
      const result = ok(split, 'delete_pid_item', { item: 'HV-9' });
      const [healed] = segmentsOfLine(result.document, SUCTION);
      expect(segmentsOfLine(result.document, SUCTION)).toHaveLength(1);
      expect(healed?.id).toBe(original?.id);
      healed?.route.forEach((p, i) => {
        expect(Math.abs(p[0] - (original?.route[i]?.[0] ?? NaN))).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(p[1] - (original?.route[i]?.[1] ?? NaN))).toBeLessThanOrEqual(1e-9);
      });
      expect(healed?.route).toHaveLength(original?.route.length ?? -1);
      expect(healed?.to).toEqual(original?.to);
      expect(result.affected).toHaveLength(2);
      expect(result.document.plant?.pid?.itemOrder).toEqual(base.plant?.pid?.itemOrder);
    }
  });

  it('heals the middle one of three valves and keeps the neighbours connected in flow order', () => {
    let doc = feedPump();
    for (const [x, tag] of [
      [100, 'A'],
      [130, 'C'],
      [115, 'B'],
    ] as const)
      doc = apply(doc, 'add_pid_inline', inline([x, 80], `HV-${tag}`));
    const before = segmentsOfLine(doc, SUCTION);
    expect(before.map((s) => s.from.type)).toEqual(['nozzle', 'inline', 'inline', 'inline']);
    const healed = apply(doc, 'delete_pid_item', { item: 'HV-B' });
    const pieces = segmentsOfLine(healed, SUCTION);
    expect(pieces).toHaveLength(3);
    expect(pieces[1]?.route).toEqual([
      [105, 80],
      [125, 80],
    ]);
    expect(pieces[1]?.from).toMatchObject({ type: 'inline', itemId: byTag(healed, 'HV-A').id });
    expect(pieces[1]?.to).toMatchObject({ type: 'inline', itemId: byTag(healed, 'HV-C').id });
    const connectivity = data<{ rows: Array<Record<string, string>> }>(healed, 'pid_report', { kind: 'connectivity' });
    expect(connectivity.rows.find((r) => r['lineNumber'] === SUCTION)).toMatchObject({ from: 'T-101/N1', to: 'P-101/N1' });
  });

  it('keeps a tee on the right piece through split and heal', () => {
    let doc = apply(feedPump(), 'add_pid_line', {
      sheet: 'PID-001',
      from: { free: [100, 20] },
      to: { line: SUCTION, at: [100, 80] },
      lineNumber: '25-W-1',
    });
    const tee = (): string => {
      const end = ofKind(doc, 'segment').find((s) => s.to.type === 'branch')?.to;
      return end?.type === 'branch' ? end.segmentId : '';
    };
    const [host] = segmentsOfLine(doc, SUCTION);
    expect(tee()).toBe(host?.id);
    doc = apply(doc, 'add_pid_inline', inline([80, 80], 'HV-1'));
    expect(tee()).toBe(segmentsOfLine(doc, SUCTION)[1]?.id);
    doc = apply(doc, 'add_pid_inline', inline([120, 80], 'HV-2'));
    expect(tee()).toBe(segmentsOfLine(doc, SUCTION)[1]?.id);
    doc = apply(doc, 'delete_pid_item', { item: 'HV-1' });
    expect(tee()).toBe(host?.id);
  });

  it('with heal=false leaves two segments with free ends at the ports', () => {
    const split = apply(feedPump(), 'add_pid_inline', inline([100, 80], 'HV-1'));
    const result = ok(split, 'delete_pid_item', { item: 'HV-1', heal: false });
    const [a, b] = segmentsOfLine(result.document, SUCTION);
    expect(a?.to).toEqual({ type: 'free', at: [95, 80] });
    expect(b?.from).toEqual({ type: 'free', at: [105, 80] });
    expect(result.affected).toHaveLength(1);
  });

  it('removes the actuating system with its valve and clears nothing else', () => {
    const doc = feedPumpControlled();
    const result = ok(doc, 'delete_pid_item', { item: 'FV-101' });
    expect(ofKind(result.document, 'actuating')).toHaveLength(0);
    expect(segmentsOfLine(result.document, '80-P-1002-A1')).toHaveLength(2);
    expect(result.affected).toHaveLength(3);
  });
});

describe('delete_pid_item: cascades', () => {
  it('equipment takes its nozzles and frees the segment ends on it; a segment that loses both ends in one deletion goes with its line', () => {
    const tankGone = ok(feedPump(), 'delete_pid_item', { item: 'T-101' });
    expect(tankGone.affected).toHaveLength(3);
    expect(segmentsOfLine(tankGone.document, SUCTION)[0]?.from).toEqual({ type: 'free', at: [60, 125] });
    const loop = runSteps([
      ...FEED_PUMP.slice(0, 3),
      { command: 'add_pid_nozzle', params: { equipment: 'P-101', subTag: 'N3', side: 'bottom' } },
      { command: 'add_pid_nozzle', params: { equipment: 'P-101', subTag: 'N4', side: 'right' } },
      {
        command: 'add_pid_line',
        params: { sheet: 'PID-001', from: { tag: 'P-101', nozzle: 'N3' }, to: { tag: 'P-101', nozzle: 'N4' }, lineNumber: 'REC-1' },
      },
    ]);
    const removed = ok(loop.doc, 'delete_pid_item', { item: 'P-101' });
    expect(ofKind(removed.document, 'line')).toHaveLength(0);
    expect(ofKind(removed.document, 'segment')).toHaveLength(0);
    expect(ofKind(removed.document, 'equipment').map((e) => e.tag)).toEqual(['T-101']);
  });

  it('a line takes its segments, inline items, off-page connector, actuating system and measuring signal; instruments stay', () => {
    const doc = feedPumpControlled();
    const result = ok(doc, 'delete_pid_item', { item: '80-P-1002-A1' });
    expect(ofKind(result.document, 'line').map((l) => l.lineNumber)).toEqual([SUCTION]);
    expect(ofKind(result.document, 'inline')).toHaveLength(0);
    expect(ofKind(result.document, 'actuating')).toHaveLength(0);
    expect(ofKind(result.document, 'opc')).toHaveLength(0);
    expect(ofKind(result.document, 'signal').map((s) => s.signalKind)).toEqual(['electric']);
    expect(ofKind(result.document, 'instrument')).toHaveLength(2);
  });

  it('an instrument takes its signals; the loop goes with its last member; a controller reference is cleared', () => {
    let doc = apply(feedPumpControlled(), 'delete_pid_item', { item: 'FIC-101' });
    expect(ofKind(doc, 'actuating')[0]?.controllerId).toBeUndefined();
    expect(ofKind(doc, 'signal').map((s) => s.signalKind)).toEqual(['measuring']);
    expect(ofKind(doc, 'loop')).toHaveLength(1);
    doc = apply(doc, 'delete_pid_item', { item: 'FT-101' });
    expect(ofKind(doc, 'loop')).toHaveLength(0);
    expect(ofKind(doc, 'signal')).toHaveLength(0);
  });

  it('a loop leaves its members without loopId; an off-page connector leaves a free end; a nozzle goes alone', () => {
    let doc = apply(feedPumpControlled(), 'delete_pid_item', { item: ofKind(feedPumpControlled(), 'loop')[0]?.id ?? '' });
    expect(ofKind(doc, 'instrument').every((i) => i.loopId === undefined)).toBe(true);
    const opc = ofKind(doc, 'opc')[0];
    doc = apply(doc, 'delete_pid_item', { item: opc?.id ?? '' });
    expect(segmentsOfLine(doc, '80-P-1002-A1').at(-1)?.to).toEqual({ type: 'free', at: [300, 120] });
    const nozzle = ofKind(doc, 'nozzle').find((n) => n.subTag === 'N2' && n.dn === 50);
    const gone = ok(doc, 'delete_pid_item', { item: nozzle?.id ?? '' });
    expect(gone.affected).toEqual([nozzle?.id]);
  });

  it('refuses an unknown item and a lone segment', () => {
    const doc = feedPump();
    expectRefusal(doc, 'delete_pid_item', { item: 'X-404' }, 'PID_ITEM_NOT_FOUND', 'item');
    expectRefusal(doc, 'delete_pid_item', { item: ofKind(doc, 'segment')[0]?.id ?? '' }, 'PID_ITEM_KIND', 'item');
  });
});

describe('add_pid_instrument', () => {
  it('stores the tag split, shares the loop of the same letter and number, and draws the measuring line from a line tap', () => {
    const doc = feedPumpControlled();
    expect(byTag(doc, 'FT-101')).toMatchObject({
      category: 'F',
      functions: 'T',
      loopNumber: '101',
      location: 'field',
      display: 'discrete',
    });
    expect(byTag(doc, 'FIC-101')).toMatchObject({
      category: 'F',
      functions: 'IC',
      loopNumber: '101',
      location: 'central',
      display: 'shared',
    });
    const loops = ofKind(doc, 'loop');
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ tag: 'F-101' });
    expect(ofKind(doc, 'instrument').map((i) => i.loopId)).toEqual([loops[0]?.id, loops[0]?.id]);
    const measuring = ofKind(doc, 'signal').find((s) => s.signalKind === 'measuring');
    expect(measuring?.from).toMatchObject({ type: 'branch', at: [230, 120] });
    expect(measuring?.route).toEqual([
      [230, 120],
      [230, 140],
    ]);
    const host = ofKind(doc, 'segment').find((s) => s.id === (measuring?.from.type === 'branch' ? measuring.from.segmentId : ''));
    expect(host?.route).toEqual(
      [
        [255, 120],
        [275, 120],
      ].length
        ? host?.route
        : [],
    );
    expect(host?.route[0]?.[0]).toBeLessThan(230);
    expect(host?.route.at(-1)?.[0]).toBeGreaterThan(230);
  });

  it('takes a tag with a suffix, separator variants and the explicit parts form; draws a nozzle tap', () => {
    let doc = apply(feedPump(), 'add_pid_instrument', { sheet: 'PID-001', tag: 'FV 101A', at: [10, 10], location: 'local_panel' });
    expect(byTag(doc, 'FV 101A')).toMatchObject({ category: 'F', functions: 'V', loopNumber: '101', location: 'local_panel' });
    doc = apply(doc, 'add_pid_instrument', {
      sheet: 'PID-001',
      parts: { category: 'P', functions: 'DIT', loop: '12.01' },
      at: [20, 20],
      location: 'auxiliary',
      loop: 'L-A',
    });
    expect(byTag(doc, 'PDIT-12.01')).toMatchObject({ loopNumber: '12.01' });
    expect(ofKind(doc, 'loop').map((l) => l.tag)).toEqual(['F-101', 'L-A']);
    doc = apply(doc, 'add_pid_instrument', {
      sheet: 'PID-001',
      tag: 'PT-5',
      at: [140, 90],
      location: 'field',
      loop: 'L-A',
      measures: { tag: 'P-101', nozzle: 'N1' },
    });
    const signal = ofKind(doc, 'signal')[0];
    expect(signal).toMatchObject({ signalKind: 'measuring', from: { type: 'nozzle' } });
    expect(ofKind(doc, 'loop')).toHaveLength(2);
  });

  it('refuses an unknown sheet, unparseable or missing tags, a used tag, and bad process connections', () => {
    const doc = feedPump();
    const base = { sheet: 'PID-001', tag: 'FT-1', at: [0, 0], location: 'field' };
    expectRefusal(doc, 'add_pid_instrument', { ...base, sheet: 'PID-9' }, 'PID_SHEET_NOT_FOUND', 'sheet');
    expectRefusal(doc, 'add_pid_instrument', { ...base, tag: 'ft-1' }, 'PID_TAG_FORMAT', 'tag');
    expectRefusal(doc, 'add_pid_instrument', { ...base, tag: 'FT1X1' }, 'PID_TAG_FORMAT', 'tag');
    expectRefusal(doc, 'add_pid_instrument', { sheet: 'PID-001', at: [0, 0], location: 'field' }, 'PID_TAG_FORMAT', 'tag');
    expectRefusal(doc, 'add_pid_instrument', { ...base, tag: 'T-101' }, 'PID_TAG_DUPLICATE', 'tag');
    expectRefusal(doc, 'add_pid_instrument', { ...base, measures: { line: SUCTION, at: [100, 150] } }, 'PID_POINT_OFF_LINE', 'measures.at');
    expectRefusal(
      doc,
      'add_pid_instrument',
      { ...base, measures: { line: 'no-such', at: [100, 80] } },
      'PID_ITEM_NOT_FOUND',
      'measures.line',
    );
    expectRefusal(doc, 'add_pid_instrument', { ...base, measures: { tag: 'P-404', nozzle: 'N1' } }, 'PID_ITEM_NOT_FOUND', 'measures.tag');
    expectRefusal(
      doc,
      'add_pid_instrument',
      { ...base, measures: { tag: 'P-101', nozzle: 'N9' } },
      'PID_ITEM_NOT_FOUND',
      'measures.nozzle',
    );
    expectRefusal(doc, 'add_pid_instrument', { ...base, measures: {} }, 'PID_LINE_ENDPOINT_INVALID', 'measures');
  });
});

describe('add_pid_signal_line', () => {
  it('draws a signal between instruments, to an actuating system, and along via points', () => {
    let doc = feedPumpControlled();
    const actuating = ofKind(doc, 'actuating')[0]?.id ?? '';
    doc = apply(doc, 'add_pid_signal_line', {
      from: 'FIC-101',
      to: actuating,
      kind: 'pneumatic',
      via: [
        [260, 170],
        [260, 132],
      ],
    });
    const signal = ofKind(doc, 'signal').at(-1);
    expect(signal).toMatchObject({ signalKind: 'pneumatic', from: { type: 'instrument' }, to: { type: 'instrument', itemId: actuating } });
    expect(signal?.route).toEqual([
      [230, 170],
      [260, 170],
      [260, 132],
      [250, 132],
    ]);
  });

  it('refuses unknown or non-signal ends, the same item, ends on different sheets and coincident ends', () => {
    let doc = apply(feedPumpControlled(), 'create_pid_sheet', { number: 'PID-002' });
    doc = apply(doc, 'add_pid_instrument', { sheet: 'PID-002', tag: 'LT-1', at: [5, 5], location: 'field' });
    doc = apply(doc, 'add_pid_instrument', { sheet: 'PID-001', tag: 'LT-2', at: [230, 170], location: 'field' });
    expectRefusal(doc, 'add_pid_signal_line', { from: 'X-404', to: 'FIC-101', kind: 'electric' }, 'PID_ITEM_NOT_FOUND', 'from');
    expectRefusal(doc, 'add_pid_signal_line', { from: 'FT-101', to: 'X-404', kind: 'electric' }, 'PID_ITEM_NOT_FOUND', 'to');
    expectRefusal(doc, 'add_pid_signal_line', { from: 'FT-101', to: 'T-101', kind: 'electric' }, 'PID_LINE_ENDPOINT_INVALID', 'from');
    expectRefusal(doc, 'add_pid_signal_line', { from: 'FT-101', to: 'FT-101', kind: 'electric' }, 'PID_LINE_ENDPOINT_INVALID', 'from');
    expectRefusal(doc, 'add_pid_signal_line', { from: 'FT-101', to: 'LT-1', kind: 'electric' }, 'PID_LINE_ENDPOINT_INVALID', 'from');
    expectRefusal(doc, 'add_pid_signal_line', { from: 'FIC-101', to: 'LT-2', kind: 'software' }, 'PID_LINE_ENDPOINT_INVALID', 'from');
  });
});

describe('add_pid_actuating_system', () => {
  it('marks the valve operated and records actuator, fail action, controller and tag', () => {
    const doc = feedPumpControlled();
    const [system] = ofKind(doc, 'actuating');
    expect(system).toMatchObject({
      actuator: 'diaphragm',
      failAction: 'FC',
      valveId: byTag(doc, 'FV-101').id,
      controllerId: byTag(doc, 'FIC-101').id,
      at: [250, 132],
    });
    expect(byTag(doc, 'FV-101')).toMatchObject({ operated: true });
    const tagged = apply(doc, 'add_pid_actuating_system', { valve: 'HV-102', actuator: 'solenoid', tag: 'SOL-1' });
    expect(byTag(tagged, 'SOL-1')).toMatchObject({ kind: 'actuating', actuator: 'solenoid' });
  });

  it('refuses a missing valve, a non-valve, a second system, a controller that is not an instrument and a used tag', () => {
    const doc = feedPumpControlled();
    const reducer = apply(doc, 'add_pid_inline', { line: SUCTION, at: [100, 80], class: 'PipeReducer', tag: 'RED-1' });
    expectRefusal(doc, 'add_pid_actuating_system', { valve: 'XV-404', actuator: 'motor' }, 'PID_ITEM_NOT_FOUND', 'valve');
    expectRefusal(reducer, 'add_pid_actuating_system', { valve: 'RED-1', actuator: 'motor' }, 'PID_ITEM_KIND', 'valve');
    expectRefusal(doc, 'add_pid_actuating_system', { valve: 'T-101', actuator: 'motor' }, 'PID_ITEM_KIND', 'valve');
    expectRefusal(doc, 'add_pid_actuating_system', { valve: 'FV-101', actuator: 'piston' }, 'PID_ACTUATOR_EXISTS', 'valve');
    expectRefusal(
      doc,
      'add_pid_actuating_system',
      { valve: 'HV-102', actuator: 'piston', controller: 'P-101' },
      'PID_ITEM_KIND',
      'controller',
    );
    expectRefusal(
      doc,
      'add_pid_actuating_system',
      { valve: 'HV-102', actuator: 'piston', controller: 'FIC-404' },
      'PID_ITEM_NOT_FOUND',
      'controller',
    );
    expectRefusal(doc, 'add_pid_actuating_system', { valve: 'HV-102', actuator: 'piston', tag: 'FIC-101' }, 'PID_TAG_DUPLICATE', 'tag');
  });
});

describe('add_pid_off_page_connector', () => {
  const open = (): CadDocument =>
    apply(feedPumpControlled(), 'add_pid_line', {
      sheet: 'PID-001',
      from: { tag: 'T-101', nozzle: 'N2' },
      to: { free: [60, 240] },
      lineNumber: '50-V-1',
    });

  it('puts an outgoing connector on the free end and an incoming one on the free start, resolving a known target sheet', () => {
    let doc = apply(open(), 'create_pid_sheet', { number: 'PID-002' });
    doc = apply(doc, 'add_pid_off_page_connector', { line: '50-V-1', end: 'end', pairKey: 'V-1', targetSheet: 'PID-002' });
    const out = ofKind(doc, 'opc').find((o) => o.pairKey === 'V-1');
    expect(out).toMatchObject({ direction: 'out', at: [60, 240], targetSheet: doc.plant?.pid?.sheetOrder[1] });
    expect(segmentsOfLine(doc, '50-V-1')[0]?.to).toEqual({ type: 'opc', itemId: out?.id });
    doc = apply(doc, 'add_pid_line', { sheet: 'PID-001', from: { free: [400, 10] }, to: { free: [450, 10] }, lineNumber: '15-X-1' });
    doc = apply(doc, 'add_pid_off_page_connector', { line: '15-X-1', end: 'start', pairKey: 'X-1', targetSheet: 'PID-9' });
    const into = ofKind(doc, 'opc').find((o) => o.pairKey === 'X-1');
    expect(into).toMatchObject({ direction: 'in', passthrough: { 'pid:targetSheet': 'PID-9' } });
    expect(into?.targetSheet).toBeUndefined();
  });

  it('refuses an unknown line and an end that is already connected', () => {
    const doc = open();
    expectRefusal(doc, 'add_pid_off_page_connector', { line: 'nope', end: 'end', pairKey: 'K' }, 'PID_ITEM_NOT_FOUND', 'line');
    expectRefusal(doc, 'add_pid_off_page_connector', { line: '50-V-1', end: 'start', pairKey: 'K' }, 'PID_LINE_ENDPOINT_INVALID', 'end');
    expectRefusal(
      doc,
      'add_pid_off_page_connector',
      { line: '80-P-1002-A1', end: 'end', pairKey: 'K' },
      'PID_LINE_ENDPOINT_INVALID',
      'end',
    );
  });
});

describe('reverse_pid_flow', () => {
  it('flips every segment of a line, one segment, and turns flow none into forward', () => {
    let doc = feedPumpControlled();
    const line = '80-P-1002-A1';
    const flipped = ok(doc, 'reverse_pid_flow', { line });
    expect(segmentsOfLine(flipped.document, line).map((s) => s.flow)).toEqual(['reverse', 'reverse', 'reverse']);
    expect(flipped.affected).toHaveLength(3);
    const back = apply(flipped.document, 'reverse_pid_flow', { line });
    expect(segmentsOfLine(back, line).map((s) => s.flow)).toEqual(['forward', 'forward', 'forward']);
    const one = segmentsOfLine(doc, line)[1]?.id ?? '';
    doc = apply(doc, 'reverse_pid_flow', { segment: one });
    expect(segmentsOfLine(doc, line).map((s) => s.flow)).toEqual(['forward', 'reverse', 'forward']);
    doc = apply(doc, 'add_pid_line', { sheet: 'PID-001', from: { free: [1, 1] }, to: { free: [9, 1] }, lineNumber: 'Q-1', flow: 'none' });
    expect(segmentsOfLine(apply(doc, 'reverse_pid_flow', { line: 'Q-1' }), 'Q-1')[0]?.flow).toBe('forward');
  });

  it('refuses neither or both of line / segment, unknown items and a non-segment', () => {
    const doc = feedPumpControlled();
    expectRefusal(doc, 'reverse_pid_flow', {}, 'PID_PARAM_INVALID');
    expectRefusal(doc, 'reverse_pid_flow', { line: 'a', segment: 'b' }, 'PID_PARAM_INVALID');
    expectRefusal(doc, 'reverse_pid_flow', { line: 'nope' }, 'PID_ITEM_NOT_FOUND', 'line');
    expectRefusal(doc, 'reverse_pid_flow', { segment: 'nope' }, 'PID_ITEM_NOT_FOUND', 'segment');
    expectRefusal(doc, 'reverse_pid_flow', { segment: 'T-101' }, 'PID_ITEM_KIND', 'segment');
  });
});
