/** Plant 04 PID M4: one test per `check_pid` rule of validation/data/pid_validation_rules.json (a positive fixture and a negative one), VC-PID-09 / 10 / 19 / 20. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { PID_RULES } from '@aec/plant/pid/checks/finding';
import type { PidItem, PidModel } from '@aec/plant/pid/model';
import { getPid, withPid } from '@aec/plant/pid/state';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { PID_PACK } from './dexpiFixtures';
import { byTag, feedPump, feedPumpControlled, ofKind, segmentsOfLine } from './authoringFixtures';

export interface CheckData {
  check: string;
  status: string;
  items: Array<{
    code: string;
    status: string;
    severity: string;
    ids: string[];
    tags: string[];
    sheet: string;
    item: string;
    message: string;
    findingKey: string;
    remediation: string;
    values: Record<string, unknown>;
    reviewRequired?: boolean;
  }>;
  countsByCode: Record<string, number>;
  summary: { errors: number; warnings: number; infos: number; reviewRequired: number; accepted: number };
  rulesRun: string[];
  provenance: { convention: string; imports: unknown[] };
  reviewRequired: boolean;
}

export const check = (doc: CadDocument, params: Record<string, unknown> = {}): CheckData => data<CheckData>(doc, 'check_pid', params);
const count = (doc: CadDocument, code: string): number => check(doc).countsByCode[code] ?? -1;
const found = (doc: CadDocument, code: string): CheckData['items'] => check(doc).items.filter((f) => f.code === code);

/** Hand edit of the stored model: what an imported or hand-edited file can hold and the authoring commands refuse. */
const edit = (doc: CadDocument, patch: (pid: PidModel) => Record<string, PidItem>): CadDocument => {
  const pid = getPid(doc);
  return withPid(doc, { ...pid, items: { ...pid.items, ...patch(pid) } });
};

const place = (tag: string, at: [number, number], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sheet: 'PID-001',
  tag,
  at,
  location: 'field',
  ...extra,
});

const rulesFile = JSON.parse(readFileSync(path.join(PID_PACK, 'data/pid_validation_rules.json'), 'utf8')) as {
  pidRules: Array<{ llullCode: string; severity: string }>;
};

describe('rule table', () => {
  it('runs the 13 rules of the pack plus the 3 of the spec table: 16 codes, severities as in pid_validation_rules.json', () => {
    expect(PID_RULES).toHaveLength(16);
    const clean = check(feedPump());
    expect(Object.keys(clean.countsByCode)).toEqual([...PID_RULES]);
    for (const rule of rulesFile.pidRules) {
      expect(PID_RULES, rule.llullCode).toContain(rule.llullCode);
    }
  });

  it('gives every finding a stable key, the remediation of its rule and the sheet number', () => {
    const doc = feedPump();
    const findings = check(doc).items;
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.findingKey).toBe(`pid:${finding.code}:${[...finding.ids].sort().join(',')}`);
      expect(finding.remediation.length).toBeGreaterThan(20);
      expect(finding.sheet).toBe('PID-001');
    }
    expect(check(doc)).toEqual(check(doc));
  });
});

describe('PID_LINE_NON_TERMINATING', () => {
  const open = apply(feedPump(), 'add_pid_line', {
    sheet: 'PID-001',
    from: { tag: 'T-101', nozzle: 'N2' },
    to: { free: [60, 240] },
    lineNumber: '50-V-1003-A1',
    dn: 50,
  });

  it('flags a free end that is not marked, once per segment', () => {
    const findings = found(open, 'PID_LINE_NON_TERMINATING');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'error', item: '50-V-1003-A1', values: { freeEnds: 1 } });
  });

  it('accepts a free end marked as an end of line (vent, drain, blind, sample), and a closed line', () => {
    const segment = ofKind(open, 'segment').find((s) => s.to.type === 'free');
    const marked = apply(open, 'update_pid_item', { item: segment?.id ?? '', set: { attributes: { endOfLine: 'vent' } } });
    expect(count(marked, 'PID_LINE_NON_TERMINATING')).toBe(0);
    const falsy = apply(open, 'update_pid_item', { item: segment?.id ?? '', set: { attributes: { endOfLine: 'false' } } });
    expect(count(falsy, 'PID_LINE_NON_TERMINATING')).toBe(1);
    expect(count(feedPump(), 'PID_LINE_NON_TERMINATING')).toBe(0);
  });
});

describe('PID_COMPONENT_UNCONNECTED', () => {
  const withValves = apply(
    apply(feedPump(), 'add_pid_inline', { line: '100-P-1001-A1', at: [100, 80], class: 'GlobeValve', tag: 'XV-1' }),
    'add_pid_inline',
    { line: '100-P-1001-A1', at: [130, 80], class: 'BlindFlange', tag: 'BF-1' },
  );
  const cut = (tag: string, node: number): CadDocument =>
    edit(withValves, (pid) => {
      const target = byTag(withValves, tag).id;
      return Object.fromEntries(
        Object.values(pid.items).flatMap((item): Array<[string, PidItem]> => {
          if (item.kind !== 'segment') return [];
          if (item.to.type === 'inline' && item.to.itemId === target && item.to.node === node)
            return [[item.id, { ...item, to: { type: 'free', at: item.route[item.route.length - 1] ?? [0, 0] } }]];
          if (item.from.type === 'inline' && item.from.itemId === target && item.from.node === node)
            return [[item.id, { ...item, from: { type: 'free', at: item.route[0] ?? [0, 0] } }]];
          return [];
        }),
      ) as Record<string, PidItem>;
    });

  it('is clean when every port has a segment', () => {
    expect(count(withValves, 'PID_COMPONENT_UNCONNECTED')).toBe(0);
  });

  it('flags a valve port without a segment', () => {
    const findings = found(cut('XV-1', 1), 'PID_COMPONENT_UNCONNECTED');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ item: 'XV-1', values: { unconnectedPorts: 1, ports: 2 } });
  });

  it('lets a blind flange or cap end a line with one open port, but not stand alone', () => {
    expect(count(cut('BF-1', 1), 'PID_COMPONENT_UNCONNECTED')).toBe(0);
    const alone = edit(withValves, (pid) => {
      const flange = byTag(withValves, 'BF-1');
      const ids = Object.values(pid.items).flatMap((i) =>
        i.kind === 'segment' && JSON.stringify([i.from, i.to]).includes(flange.id) ? [i] : [],
      );
      return Object.fromEntries(
        ids.map((s) => [
          s.id,
          {
            ...s,
            from:
              s.from.type === 'inline' && s.from.itemId === flange.id
                ? { type: 'free' as const, at: s.route[0] ?? ([0, 0] as [number, number]) }
                : s.from,
            to:
              s.to.type === 'inline' && s.to.itemId === flange.id
                ? { type: 'free' as const, at: s.route[0] ?? ([0, 0] as [number, number]) }
                : s.to,
          },
        ]),
      );
    });
    expect(found(alone, 'PID_COMPONENT_UNCONNECTED').map((f) => f.item)).toEqual(['BF-1']);
  });
});

describe('PID_NOZZLE_UNCONNECTED and PID_NOZZLE_UNCONNECTED_ACCESS', () => {
  it('warns for a nozzle without a line and not for a connected one', () => {
    const findings = found(feedPump(), 'PID_NOZZLE_UNCONNECTED');
    expect(findings.map((f) => [f.item, f.severity, f.values])).toEqual([['T-101/N2', 'warning', { dn: 50 }]]);
    expect(findings.map((f) => f.item)).not.toContain('T-101/N1');
  });

  it('reports an access nozzle (manhole) and a nozzle marked spare as info instead', () => {
    const access = apply(feedPump(), 'add_pid_nozzle', { equipment: 'T-101', subTag: 'N8', side: 'left', dn: 800, access: true });
    expect(found(access, 'PID_NOZZLE_UNCONNECTED_ACCESS').map((f) => [f.item, f.severity])).toEqual([['T-101/N8', 'info']]);
    expect(found(access, 'PID_NOZZLE_UNCONNECTED').map((f) => f.item)).toEqual(['T-101/N2']);
    const nozzle = ofKind(feedPump(), 'nozzle').find((n) => n.subTag === 'N2' && n.equipmentId === byTag(feedPump(), 'T-101').id);
    const spare = apply(feedPump(), 'update_pid_item', { item: nozzle?.id ?? '', set: { attributes: { spare: 'true' } } });
    expect(count(spare, 'PID_NOZZLE_UNCONNECTED')).toBe(0);
    expect(found(spare, 'PID_NOZZLE_UNCONNECTED_ACCESS').map((f) => f.item)).toEqual(['T-101/N2']);
  });

  it('counts a measuring line from a nozzle as a connection', () => {
    const tapped = apply(feedPump(), 'add_pid_instrument', place('PT-1', [10, 10], { measures: { tag: 'T-101', nozzle: 'N2' } }));
    expect(count(tapped, 'PID_NOZZLE_UNCONNECTED')).toBe(0);
  });
});

describe('PID_EQUIPMENT_UNCONNECTED', () => {
  it('flags a tank or vessel none of whose nozzles has a line, not a pump', () => {
    let doc = apply(feedPump(), 'add_pid_equipment', {
      sheet: 'PID-001',
      class: 'Tank',
      tag: 'T-102',
      at: [300, 200],
      nozzles: [{ subTag: 'N1', side: 'left', dn: 50 }],
    });
    doc = apply(doc, 'add_pid_equipment', {
      sheet: 'PID-001',
      class: 'CentrifugalPump',
      tag: 'P-102',
      at: [300, 100],
      nozzles: [{ subTag: 'N1', side: 'left' }],
    });
    expect(found(doc, 'PID_EQUIPMENT_UNCONNECTED').map((f) => [f.item, f.severity])).toEqual([['T-102', 'error']]);
  });

  it('is clean when a nozzle of the tank (or of its sub-equipment) is connected', () => {
    expect(count(feedPump(), 'PID_EQUIPMENT_UNCONNECTED')).toBe(0);
    const doc = feedPump();
    const tank = byTag(doc, 'T-101');
    const nozzles = ofKind(doc, 'nozzle').filter((n) => n.equipmentId === tank.id);
    if (tank.kind !== 'equipment') throw new Error('T-101 is equipment');
    const { tag: _tag, ...rest } = tank;
    const sub: PidItem = { ...rest, id: 'sub-1', parentId: tank.id };
    const moved = edit(doc, () => ({ 'sub-1': sub, ...Object.fromEntries(nozzles.map((n) => [n.id, { ...n, equipmentId: 'sub-1' }])) }));
    const withSub = withPid(moved, { ...getPid(moved), itemOrder: [...getPid(moved).itemOrder, 'sub-1'] });
    expect(count(withSub, 'PID_EQUIPMENT_UNCONNECTED')).toBe(0);
  });
});

describe('PID_SIZE_MISMATCH', () => {
  const inline = (doc: CadDocument, extra: Record<string, unknown>): CadDocument =>
    apply(doc, 'add_pid_inline', { line: '80-P-1002-A1', at: [280, 120], class: 'GlobeValve', tag: 'HV-103', ...extra });

  it('flags an inline item of another size than its line, once, with both sizes', () => {
    const findings = found(inline(feedPump(), { dn: 50 }), 'PID_SIZE_MISMATCH');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ item: 'HV-103', severity: 'error', values: { itemDn: 50, lineDn: 80 } });
    expect(findings[0]?.ids).toHaveLength(3);
  });

  it('is clean for the line size (defaulted) and for a reducer', () => {
    expect(count(inline(feedPump(), {}), 'PID_SIZE_MISMATCH')).toBe(0);
    expect(count(inline(feedPump(), { dn: 50, class: 'PipeReducer' }), 'PID_SIZE_MISMATCH')).toBe(0);
  });
});

describe('PID_SPEC_MISMATCH', () => {
  const inline = (extra: Record<string, unknown>): CadDocument =>
    apply(feedPump(), 'add_pid_inline', { line: '100-P-1001-A1', at: [100, 80], class: 'BallValve', tag: 'HV-104', ...extra });

  it('flags a piping class that differs from the line and not the line class itself', () => {
    const findings = found(inline({ pipingClass: 'B2' }), 'PID_SPEC_MISMATCH');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ item: 'HV-104', values: { itemClass: 'B2', lineClass: 'A1' } });
    expect(count(inline({}), 'PID_SPEC_MISMATCH')).toBe(0);
  });

  it('is clean at a marked spec break', () => {
    const doc = inline({ pipingClass: 'B2', attributes: { specBreak: 'true' } });
    expect(count(doc, 'PID_SPEC_MISMATCH')).toBe(0);
  });
});

describe('PID_FLOW_DIRECTION_CONFLICT', () => {
  const check105 = (reversed: boolean): CadDocument =>
    apply(feedPump(), 'add_pid_inline', { line: '100-P-1001-A1', at: [130, 80], class: 'SwingCheckValve', tag: 'CV-105', reversed });

  it('flags a check valve installed against the flow of its segment', () => {
    const findings = found(check105(true), 'PID_FLOW_DIRECTION_CONFLICT');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.item).toBe('CV-105');
    expect(findings[0]?.message).toContain('check valve');
  });

  it('is clean for a check valve along the flow, and while the flow is unknown', () => {
    expect(count(check105(false), 'PID_FLOW_DIRECTION_CONFLICT')).toBe(0);
    const reversedLine = apply(check105(true), 'reverse_pid_flow', { line: '100-P-1001-A1' });
    expect(count(reversedLine, 'PID_FLOW_DIRECTION_CONFLICT')).toBe(0);
    const none = edit(check105(true), (pid) =>
      Object.fromEntries(Object.values(pid.items).flatMap((i) => (i.kind === 'segment' ? [[i.id, { ...i, flow: 'none' as const }]] : []))),
    );
    expect(count(none, 'PID_FLOW_DIRECTION_CONFLICT')).toBe(0);
  });

  it('flags two segments that both flow into (or out of) one inline item', () => {
    const doc = apply(feedPump(), 'add_pid_inline', { line: '100-P-1001-A1', at: [100, 80], class: 'BallValve', tag: 'HV-1' });
    expect(count(doc, 'PID_FLOW_DIRECTION_CONFLICT')).toBe(0);
    const second = segmentsOfLine(doc, '100-P-1001-A1')[1];
    const conflict = apply(doc, 'reverse_pid_flow', { segment: second?.id ?? '' });
    const findings = found(conflict, 'PID_FLOW_DIRECTION_CONFLICT');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('into');
    const out = apply(doc, 'reverse_pid_flow', { segment: segmentsOfLine(doc, '100-P-1001-A1')[0]?.id ?? '' });
    expect(found(out, 'PID_FLOW_DIRECTION_CONFLICT')[0]?.message).toContain('out of');
  });
});

describe('PID_OPC_UNRESOLVED', () => {
  const second = (pairKey: string): CadDocument => {
    let doc = apply(feedPump(), 'create_pid_sheet', { number: 'PID-002', title: 'Continuation', paper: 'A3' });
    doc = apply(doc, 'add_pid_equipment', {
      sheet: 'PID-002',
      class: 'Tank',
      tag: 'T-201',
      at: [100, 100],
      nozzles: [{ subTag: 'N1', side: 'left', dn: 80 }],
    });
    return apply(doc, 'add_pid_line', {
      sheet: 'PID-002',
      from: { opc: pairKey },
      to: { tag: 'T-201', nozzle: 'N1' },
      lineNumber: '80-P-2001-A1',
      dn: 80,
    });
  };

  it('flags a connector whose target sheet does not exist', () => {
    const findings = found(feedPump(), 'PID_OPC_UNRESOLVED');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('"PID-002" does not exist');
    expect(findings[0]).toMatchObject({ item: 'OPC-1', values: { pairKey: 'OPC-1', direction: 'out' } });
  });

  it('resolves the pair once the partner of the opposite direction exists on the target sheet', () => {
    expect(count(second('OPC-1'), 'PID_OPC_UNRESOLVED')).toBe(0);
  });

  it('keeps both connectors unresolved when the pair key differs, or the partner has the same direction', () => {
    const wrongKey = found(second('OPC-9'), 'PID_OPC_UNRESOLVED');
    expect(wrongKey.map((f) => f.item).sort()).toEqual(['OPC-1', 'OPC-9']);
    expect(wrongKey[0]?.message).toContain('no ');
  });
});

describe('PID_TAG_DUPLICATE', () => {
  it('flags two items with one normalised tag (imported data; authoring refuses)', () => {
    const doc = feedPumpControlled();
    expectRefusal(doc, 'add_pid_instrument', place('FIC-101', [260, 170]), 'PID_TAG_DUPLICATE', 'tag');
    const ft = byTag(doc, 'FT-101');
    const dup = edit(doc, () => ({ [ft.id]: { ...ft, tag: 'fic-101' } }));
    const findings = found(dup, 'PID_TAG_DUPLICATE');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ids).toHaveLength(2);
    expect(findings[0]).toMatchObject({ severity: 'error', item: expect.stringMatching(/FIC-101/i), values: { items: 2 } });
  });

  it('is clean when every tag is unique, also for the same tag on different case-insensitive keys of other kinds', () => {
    expect(count(feedPumpControlled(), 'PID_TAG_DUPLICATE')).toBe(0);
  });
});

describe('PID_SEGMENT_INVALID', () => {
  const two = apply(
    apply(feedPump(), 'add_pid_inline', { line: '100-P-1001-A1', at: [100, 80], class: 'BallValve', tag: 'HV-1' }),
    'add_pid_inline',
    { line: '100-P-1001-A1', at: [120, 80], class: 'BallValve', tag: 'HV-2' },
  );

  it('is clean for the chain of a drawn line', () => {
    expect(count(two, 'PID_SEGMENT_INVALID')).toBe(0);
  });

  it('flags a segment chain whose items are not consecutive', () => {
    const pieces = segmentsOfLine(two, '100-P-1001-A1');
    const hv2 = byTag(two, 'HV-2');
    const broken = edit(two, () => ({ [pieces[1]?.id ?? '']: { ...pieces[1]!, from: { type: 'inline', itemId: hv2.id, node: 1 } } }));
    const findings = found(broken, 'PID_SEGMENT_INVALID');
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]).toMatchObject({ severity: 'error', values: { reason: 'chain' } });
  });

  it('flags a port referenced by two segment ends', () => {
    const pieces = segmentsOfLine(two, '100-P-1001-A1');
    const second = pieces[1];
    const dup = edit(two, () => ({ [pieces[2]?.id ?? '']: { ...pieces[2]!, from: second!.from } }));
    const findings = found(dup, 'PID_SEGMENT_INVALID').filter((f) => f.values['reason'] === 'node referenced twice');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.values).toMatchObject({ references: 2 });
  });
});

describe('PID_CONTROL_VALVE_NO_ACTUATOR', () => {
  it('flags an operated valve without an actuating system and not one with it', () => {
    const doc = apply(feedPump(), 'add_pid_inline', {
      line: '100-P-1001-A1',
      at: [115, 80],
      class: 'GlobeValve',
      tag: 'XV-106',
      operated: true,
    });
    expect(found(doc, 'PID_CONTROL_VALVE_NO_ACTUATOR').map((f) => f.item)).toEqual(['XV-106']);
    expect(count(feedPumpControlled(), 'PID_CONTROL_VALVE_NO_ACTUATOR')).toBe(0);
  });

  it('flags an actuating system without a controlling instrument', () => {
    const doc = apply(feedPump(), 'add_pid_inline', { line: '100-P-1001-A1', at: [115, 80], class: 'GlobeValve', tag: 'XV-1' });
    const actuated = apply(doc, 'add_pid_actuating_system', { valve: 'XV-1', actuator: 'solenoid' });
    const findings = found(actuated, 'PID_CONTROL_VALVE_NO_ACTUATOR');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('no controlling instrument');
  });
});

describe('PID_SAFETY_VALVE_NO_SET_PRESSURE', () => {
  const psv = (attributes?: Record<string, unknown>): CadDocument =>
    apply(feedPump(), 'add_pid_inline', {
      line: '100-P-1001-A1',
      at: [100, 80],
      class: 'SpringLoadedGlobeSafetyValve',
      tag: 'PSV-1',
      ...(attributes === undefined ? {} : { attributes }),
    });

  it('flags a safety valve without SetPressureHigh and marks it for human review', () => {
    const result = check(psv());
    const findings = result.items.filter((f) => f.code === 'PID_SAFETY_VALVE_NO_SET_PRESSURE');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ item: 'PSV-1', severity: 'warning', reviewRequired: true });
    expect(result.summary.reviewRequired).toBe(1);
    expect(result.reviewRequired).toBe(true);
  });

  it('is clean with a set pressure, and ordinary valves never need one', () => {
    const doc = psv({ SetPressureHigh: { value: 6, unit: 'bar' } });
    expect(count(doc, 'PID_SAFETY_VALVE_NO_SET_PRESSURE')).toBe(0);
    expect(check(doc).reviewRequired).toBe(false);
    expect(count(feedPumpControlled(), 'PID_SAFETY_VALVE_NO_SET_PRESSURE')).toBe(0);
  });
});

describe('PID_LINE_NUMBER_MISSING', () => {
  it('flags a line without a line number', () => {
    const doc = apply(feedPump(), 'add_pid_line', { sheet: 'PID-001', from: { tag: 'T-101', nozzle: 'N2' }, to: { free: [60, 240] } });
    expect(count(doc, 'PID_LINE_NUMBER_MISSING')).toBe(1);
    expect(count(feedPump(), 'PID_LINE_NUMBER_MISSING')).toBe(0);
  });
});

describe('PID_INSTRUMENT_UNCONNECTED', () => {
  it('flags an instrument with no signal line and no loop partner', () => {
    const doc = apply(feedPump(), 'add_pid_instrument', place('PT-9', [10, 10]));
    expect(found(doc, 'PID_INSTRUMENT_UNCONNECTED').map((f) => f.item)).toEqual(['PT-9']);
  });

  it('is clean with a signal line, as controller of an actuating system, or with a partner in the loop', () => {
    expect(count(feedPumpControlled(), 'PID_INSTRUMENT_UNCONNECTED')).toBe(0);
    let doc = apply(feedPump(), 'add_pid_instrument', place('PT-9', [10, 10]));
    doc = apply(doc, 'add_pid_instrument', place('PI-9', [20, 10]));
    expect(count(doc, 'PID_INSTRUMENT_UNCONNECTED')).toBe(0);
    const tapped = apply(feedPump(), 'add_pid_instrument', place('LT-1', [10, 10], { measures: { tag: 'T-101', nozzle: 'N2' } }));
    expect(count(tapped, 'PID_INSTRUMENT_UNCONNECTED')).toBe(0);
  });
});

describe('PID_TAG_NONSTANDARD', () => {
  it('reports instrument letters outside ISA 5.1 as info, keeping the tag', () => {
    const doc = apply(feedPump(), 'add_pid_instrument', {
      sheet: 'PID-001',
      parts: { category: 'F', functions: 'DD', loop: '7' },
      at: [10, 10],
      location: 'field',
    });
    const findings = found(doc, 'PID_TAG_NONSTANDARD');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'info', status: 'info', item: 'FDD-7', values: { parseCode: 'PID_TAG_NONSTANDARD' } });
  });

  it('is clean for ISA tags', () => {
    expect(count(feedPumpControlled(), 'PID_TAG_NONSTANDARD')).toBe(0);
  });
});

describe('options, envelope and purity', () => {
  it('limits to a sheet (unknown sheet refused) and to some rules', () => {
    const doc = feedPumpControlled();
    expect(check(doc, { sheet: 'PID-001' }).countsByCode).toEqual(check(doc).countsByCode);
    expectRefusal(doc, 'check_pid', { sheet: 'PID-009' }, 'PID_SHEET_NOT_FOUND', 'sheet');
    const only = check(doc, { rules: ['PID_NOZZLE_UNCONNECTED', 'PID_OPC_UNRESOLVED'] });
    expect(only.rulesRun).toEqual(['PID_NOZZLE_UNCONNECTED', 'PID_OPC_UNRESOLVED']);
    expect(execute(doc, 'check_pid', { rules: ['PID_NOPE'] }).rejected).toBe(true);
  });

  it('filters by sheet across two sheets', () => {
    let doc = apply(feedPump(), 'create_pid_sheet', { number: 'PID-002', title: 'Other' });
    doc = apply(doc, 'add_pid_instrument', { sheet: 'PID-002', tag: 'LT-1', at: [5, 5], location: 'field' });
    expect(check(doc, { sheet: 'PID-002' }).countsByCode['PID_INSTRUMENT_UNCONNECTED']).toBe(1);
    expect(check(doc, { sheet: 'PID-001' }).countsByCode['PID_INSTRUMENT_UNCONNECTED']).toBe(0);
  });

  it('hides accepted findings unless includeAccepted, and counts them', () => {
    const doc = feedPump();
    const key = check(doc).items.find((f) => f.code === 'PID_NOZZLE_UNCONNECTED')?.findingKey ?? '';
    const accepted = withPid(doc, {
      ...getPid(doc),
      acceptances: { [key]: { reason: 'spare for a later tie-in', by: 'reviewer', at: '2026-10-31T00:00:00Z' } },
    });
    expect(count(accepted, 'PID_NOZZLE_UNCONNECTED')).toBe(0);
    expect(check(accepted).summary.accepted).toBe(1);
    expect(check(accepted, { includeAccepted: true }).countsByCode['PID_NOZZLE_UNCONNECTED']).toBe(1);
  });

  it('orders findings errors first, then by rule and natural label; status follows the worst severity; an empty document passes', () => {
    const result = check(feedPump());
    const rank = { error: 0, warning: 1, info: 2 };
    const order = result.items.map(
      (f) => [rank[f.severity as keyof typeof rank], PID_RULES.indexOf(f.code as (typeof PID_RULES)[number])] as const,
    );
    expect(order).toEqual([...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    expect(result.items[0]?.code).toBe('PID_OPC_UNRESOLVED');
    expect(result.status).toBe('fail');
    expect(result.summary).toMatchObject({ errors: 1, warnings: 1, infos: 0 });
    const warnOnly = check(apply(feedPump(), 'create_pid_sheet', { number: 'PID-009' }), { rules: ['PID_NOZZLE_UNCONNECTED'] });
    expect(warnOnly.status).toBe('warn');
    const empty = execute(createEmptyDocument(), 'check_pid', {});
    expect(empty.data).toMatchObject({ status: 'pass', items: [] });
    expect(empty.summary).toContain('0 errors');
  });

  it('is pure and replays to the same findings', () => {
    const doc = feedPumpControlled();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'check_pid', {});
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(check(replayed)).toEqual(check(doc));
  });
});
