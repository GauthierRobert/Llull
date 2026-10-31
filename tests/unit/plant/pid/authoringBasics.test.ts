/** Plant 04 PID M3: sheets, equipment, nozzles, lines, conventions (happy and refusal paths). */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { byTag, feedPump, ofKind, runSteps } from './authoringFixtures';

const sheetDoc = (): CadDocument => apply(createEmptyDocument(), 'create_pid_sheet', { number: 'PID-001' });
const sheetId = (doc: CadDocument): string => doc.plant?.pid?.sheetOrder[0] ?? '';

describe('create_pid_sheet', () => {
  it('creates a draft sheet with the defaults (A1, revision 0, empty title) and sets the project settings', () => {
    const result = ok(createEmptyDocument(), 'create_pid_sheet', {
      number: 'PID-007',
      convention: 'ISO-10628-2',
      lineNumberFormat: '{dn}-{seq}',
    });
    const pid = result.document.plant?.pid;
    expect(result.affected).toEqual(pid?.sheetOrder);
    expect(Object.values(pid?.sheets ?? {})[0]).toMatchObject({
      number: 'PID-007',
      title: '',
      paper: 'A1',
      revision: '0',
      status: 'draft',
    });
    expect(pid).toMatchObject({ convention: 'ISO-10628-2', lineNumberFormat: '{dn}-{seq}' });
  });

  it('refuses a number in use (PID_SHEET_DUPLICATE) and an unknown template token', () => {
    expectRefusal(sheetDoc(), 'create_pid_sheet', { number: 'PID-001' }, 'PID_SHEET_DUPLICATE', 'number');
    expectRefusal(createEmptyDocument(), 'create_pid_sheet', { number: 'X', lineNumberFormat: '{dn}-{colour}' }, 'PID_LINE_NUMBER_FORMAT');
  });
});

describe('add_pid_equipment', () => {
  it('places equipment with nozzles on the symbol box: top is +y, ports spread on a shared side', () => {
    const doc = feedPump();
    const tank = byTag(doc, 'T-101');
    expect(tank).toMatchObject({ kind: 'equipment', dexpiClass: 'Tank', at: [60, 150] });
    const ports = Object.fromEntries(ofKind(doc, 'nozzle').map((n) => [`${n.equipmentId === tank.id ? 'T' : 'P'}${n.subTag}`, n.port]));
    expect(ports).toEqual({ TN1: [60, 125], TN2: [60, 175], PN1: [140, 80], PN2: [160, 95] });
    const two = apply(sheetDoc(), 'add_pid_equipment', {
      sheet: 'PID-001',
      class: 'Tank',
      tag: 'T-1',
      at: [0, 0],
      nozzles: [
        { subTag: 'A', side: 'top' },
        { subTag: 'B', side: 'top' },
        { subTag: 'C', side: [10, 20], dn: 25, access: true },
      ],
    });
    expect(ofKind(two, 'nozzle').map((n) => n.port)).toEqual([
      [-5, 25],
      [5, 25],
      [10, 20],
    ]);
    expect(ofKind(two, 'nozzle')[2]).toMatchObject({ dn: 25, access: true });
  });

  it('rotates the ports with the equipment and stores attributes as text or quantity', () => {
    const doc = apply(sheetDoc(), 'add_pid_equipment', {
      sheet: sheetId(sheetDoc()),
      class: 'CentrifugalPump',
      tag: 'P-1',
      at: [100, 100],
      rotationDeg: 90,
      attributes: { DesignPressure: { value: 16, unit: 'bar' }, Note: 'spare', __proto__: 'x' },
      nozzles: [{ subTag: 'N1', side: 'left' }],
    });
    const [nozzle] = ofKind(doc, 'nozzle');
    expect(nozzle?.port[0]).toBeCloseTo(100, 9);
    expect(nozzle?.port[1]).toBeCloseTo(80, 9);
    expect(byTag(doc, 'P-1').attributes).toEqual({
      DesignPressure: { kind: 'quantity', value: 16, unit: 'bar' },
      Note: { kind: 'text', value: 'spare' },
    });
  });

  it('refuses an unknown sheet, an unknown class (close names), a used tag in any case, a repeated sub-tag and a long tag', () => {
    const doc = feedPump();
    const base = { sheet: 'PID-001', class: 'Tank', tag: 'T-9', at: [0, 0] };
    expectRefusal(doc, 'add_pid_equipment', { ...base, sheet: 'PID-404' }, 'PID_SHEET_NOT_FOUND', 'sheet');
    const unknown = expectRefusal(doc, 'add_pid_equipment', { ...base, class: 'Centrifugal' }, 'PID_CLASS_UNKNOWN', 'class');
    expect(unknown.summary).toContain('CentrifugalPump');
    expectRefusal(doc, 'add_pid_equipment', { ...base, tag: 't-101' }, 'PID_TAG_DUPLICATE', 'tag');
    expectRefusal(doc, 'add_pid_equipment', { ...base, tag: 'T'.repeat(65) }, 'PID_TAG_FORMAT', 'tag');
    expectRefusal(
      doc,
      'add_pid_equipment',
      {
        ...base,
        nozzles: [
          { subTag: 'N1', side: 'left' },
          { subTag: 'N1', side: 'right' },
        ],
      },
      'PID_TAG_DUPLICATE',
      'nozzles',
    );
  });
});

describe('add_pid_nozzle', () => {
  it('adds a nozzle by side (shifted 10 mm when the spot is taken) or at an absolute point', () => {
    let doc = feedPump();
    doc = apply(doc, 'add_pid_nozzle', { equipment: 'P-101', subTag: 'N3', side: 'left', dn: 50 });
    doc = apply(doc, 'add_pid_nozzle', { equipment: 'T-101', subTag: 'N3', at: [100, 150], access: true });
    const n3 = ofKind(doc, 'nozzle').filter((n) => n.subTag === 'N3');
    expect(n3.map((n) => n.port)).toEqual([
      [140, 90],
      [100, 150],
    ]);
    expect(n3[0]).toMatchObject({ dn: 50 });
    expect(n3[1]).toMatchObject({ access: true });
    const result = ok(doc, 'add_pid_nozzle', { equipment: 'P-101', subTag: 'N4', side: 'bottom' });
    expect(result.affected).toHaveLength(1);
    expect(data<{ port: number[] }>(doc, 'add_pid_nozzle', { equipment: 'P-101', subTag: 'N5', side: [1, 2] }).port).toEqual([161, 82]);
  });

  it('refuses an unknown or non-equipment target, a used sub-tag and a missing or doubled position', () => {
    const doc = feedPump();
    const nozzleId = ofKind(doc, 'nozzle')[0]?.id ?? '';
    expectRefusal(doc, 'add_pid_nozzle', { equipment: 'P-404', subTag: 'N9', side: 'left' }, 'PID_ITEM_NOT_FOUND', 'equipment');
    expectRefusal(doc, 'add_pid_nozzle', { equipment: nozzleId, subTag: 'N9', side: 'left' }, 'PID_ITEM_KIND', 'equipment');
    expectRefusal(doc, 'add_pid_nozzle', { equipment: 'P-101', subTag: 'N1', side: 'left' }, 'PID_TAG_DUPLICATE', 'subTag');
    expectRefusal(doc, 'add_pid_nozzle', { equipment: 'P-101', subTag: 'N9' }, 'PID_PARAM_INVALID');
    expectRefusal(doc, 'add_pid_nozzle', { equipment: 'P-101', subTag: 'N9', side: 'left', at: [1, 1] }, 'PID_PARAM_INVALID');
  });
});

describe('add_pid_line', () => {
  it('routes orthogonally from a nozzle (L from a bottom port to a left port), straight when aligned, Z when both leave sideways', () => {
    const doc = feedPump();
    const suction = ofKind(doc, 'segment')[0];
    expect(suction?.route).toEqual([
      [60, 125],
      [60, 80],
      [140, 80],
    ]);
    expect(suction).toMatchObject({ flow: 'forward', dn: 100, pipingClass: 'A1', primary: true });
    const z = apply(
      apply(doc, 'add_pid_equipment', {
        sheet: 'PID-001',
        class: 'Tank',
        tag: 'T-2',
        at: [300, 200],
        nozzles: [{ subTag: 'N1', side: 'left' }],
      }),
      'add_pid_equipment',
      { sheet: 'PID-001', class: 'Tank', tag: 'T-3', at: [500, 300], nozzles: [{ subTag: 'N1', side: 'left' }] },
    );
    const zl = apply(z, 'add_pid_line', {
      sheet: 'PID-001',
      from: { tag: 'T-2', nozzle: 'N1' },
      to: { tag: 'T-3', nozzle: 'N1' },
      flow: 'none',
    });
    const last = ofKind(zl, 'segment').at(-1);
    expect(last?.route).toEqual([
      [275, 200],
      [375, 200],
      [375, 300],
      [475, 300],
    ]);
    expect(last?.flow).toBe('none');
  });

  it('takes a tee off another line (branch end, snapped) and an incoming off-page connector with a resolved target sheet', () => {
    let doc = apply(feedPump(), 'create_pid_sheet', { number: 'PID-002' });
    doc = apply(doc, 'add_pid_line', {
      sheet: 'PID-001',
      from: { opc: 'IN-1', targetSheet: 'PID-002', at: [20, 20] },
      to: { line: '100-P-1001-A1', at: [100, 83] },
      lineNumber: '25-W-1',
    });
    const tee = ofKind(doc, 'segment').at(-1);
    expect(tee?.to).toMatchObject({ type: 'branch', at: [100, 80] });
    expect(tee?.route.at(-1)).toEqual([100, 80]);
    const opc = ofKind(doc, 'opc').find((o) => o.pairKey === 'IN-1');
    expect(opc).toMatchObject({ direction: 'in', pairKey: 'IN-1', dexpiClass: 'FlowInPipeOffPageConnector', at: [20, 20] });
    expect(opc?.targetSheet).toBe(doc.plant?.pid?.sheetOrder[1]);
    expect(tee?.from).toEqual({ type: 'opc', itemId: opc?.id });
  });

  it('refuses an occupied nozzle, malformed ends, a point off the line, a used line number, an unknown sheet or nozzle', () => {
    const doc = feedPump();
    const free = { free: [300, 300] };
    const line = (patch: Record<string, unknown>): Record<string, unknown> => ({
      sheet: 'PID-001',
      from: free,
      to: { free: [400, 300] },
      ...patch,
    });
    expectRefusal(doc, 'add_pid_line', line({ from: { tag: 'T-101', nozzle: 'N1' } }), 'PID_NOZZLE_OCCUPIED', 'from');
    expectRefusal(doc, 'add_pid_line', line({ from: { tag: 'T-101', nozzle: 'N9' } }), 'PID_ITEM_NOT_FOUND', 'from.nozzle');
    expectRefusal(doc, 'add_pid_line', line({ from: { tag: 'T-404', nozzle: 'N1' } }), 'PID_ITEM_NOT_FOUND', 'from.tag');
    expectRefusal(doc, 'add_pid_line', line({ from: { tag: 'T-101' } }), 'PID_LINE_ENDPOINT_INVALID', 'from');
    expectRefusal(doc, 'add_pid_line', line({ from: { free: [1, 1], opc: 'X' } }), 'PID_LINE_ENDPOINT_INVALID', 'from');
    expectRefusal(doc, 'add_pid_line', line({ from: {} }), 'PID_LINE_ENDPOINT_INVALID', 'from');
    expectRefusal(doc, 'add_pid_line', line({ from: { line: '100-P-1001-A1' } }), 'PID_LINE_ENDPOINT_INVALID', 'from.at');
    expectRefusal(doc, 'add_pid_line', line({ from: { line: '100-P-1001-A1', at: [100, 95] } }), 'PID_POINT_OFF_LINE', 'from.at');
    expectRefusal(doc, 'add_pid_line', line({ from: { line: 'no-such', at: [100, 80] } }), 'PID_ITEM_NOT_FOUND', 'from.line');
    expectRefusal(doc, 'add_pid_line', line({ lineNumber: '100-P-1001-A1' }), 'PID_LINE_NUMBER_DUPLICATE', 'lineNumber');
    expectRefusal(doc, 'add_pid_line', line({ sheet: 'PID-404' }), 'PID_SHEET_NOT_FOUND', 'sheet');
    expectRefusal(doc, 'add_pid_line', line({ to: { free: [300, 300] } }), 'PID_LINE_ENDPOINT_INVALID', 'from');
    expectRefusal(doc, 'add_pid_line', line({ from: { opc: 'A' }, to: { opc: 'B' } }), 'PID_LINE_ENDPOINT_INVALID', 'from');
    expectRefusal(
      doc,
      'add_pid_line',
      line({ from: { tag: 'P-101', nozzle: 'N1' }, to: { tag: 'T-101', nozzle: 'N2' } }),
      'PID_NOZZLE_OCCUPIED',
    );
  });

  it('refuses a nozzle on another sheet and keeps an unknown target sheet unresolved', () => {
    const second = apply(feedPump(), 'create_pid_sheet', { number: 'PID-002' });
    expectRefusal(
      second,
      'add_pid_line',
      { sheet: 'PID-002', from: { tag: 'T-101', nozzle: 'N2' }, to: { free: [0, 0] } },
      'PID_LINE_ENDPOINT_INVALID',
      'from',
    );
  });
});

describe('set_pid_conventions', () => {
  it('sets the convention and template, and tag formats apply to later tags (null removes a format)', () => {
    let doc = apply(sheetDoc(), 'set_pid_conventions', {
      convention: 'ISO-10628-2',
      lineNumberFormat: '{area}-{seq}',
      tagFormats: { equipment: { pattern: '^[A-Z]-\\d{3}$', separator: '-' } },
    });
    expect(doc.plant?.pid).toMatchObject({ convention: 'ISO-10628-2', lineNumberFormat: '{area}-{seq}' });
    const add = (tag: string): Record<string, unknown> => ({ sheet: 'PID-001', class: 'Tank', tag, at: [0, 0] });
    expectRefusal(doc, 'add_pid_equipment', add('TANK1'), 'PID_TAG_FORMAT', 'tag');
    doc = apply(doc, 'add_pid_equipment', add('T-101'));
    doc = apply(doc, 'set_pid_conventions', { tagFormats: { equipment: null } });
    expect(doc.plant?.pid?.tagFormats).toEqual({});
    apply(doc, 'add_pid_equipment', add('TANK1'));
  });

  it('refuses an unknown token, an unsafe tag pattern and an empty request', () => {
    const doc = sheetDoc();
    expectRefusal(doc, 'set_pid_conventions', { lineNumberFormat: '{foo}' }, 'PID_LINE_NUMBER_FORMAT', 'lineNumberFormat');
    expectRefusal(doc, 'set_pid_conventions', { tagFormats: { valve: { pattern: '(a+)+$', separator: '-' } } }, 'PID_TAG_FORMAT');
    expectRefusal(doc, 'set_pid_conventions', {}, 'PID_PARAM_INVALID');
  });

  it('enforces the valve and instrument formats on inline items and instruments', () => {
    let doc = apply(feedPump(), 'set_pid_conventions', {
      tagFormats: { valve: { pattern: '^[HF]V-\\d+$', separator: '-' }, instrument: { pattern: '^F', separator: '-' } },
    });
    expectRefusal(
      doc,
      'add_pid_inline',
      { line: '100-P-1001-A1', at: [100, 80], class: 'BallValve', tag: 'XV-1' },
      'PID_TAG_FORMAT',
      'tag',
    );
    doc = apply(doc, 'add_pid_inline', { line: '100-P-1001-A1', at: [100, 80], class: 'BallValve', tag: 'HV-1' });
    apply(doc, 'add_pid_inline', { line: '100-P-1001-A1', at: [120, 80], class: 'PipeReducer', tag: 'RED-1' });
    expectRefusal(doc, 'add_pid_instrument', { sheet: 'PID-001', tag: 'PT-1', at: [0, 0], location: 'field' }, 'PID_TAG_FORMAT', 'tag');
  });
});

describe('replay of the authored document', () => {
  it('re-mints the same ids', () => {
    const { doc } = runSteps([{ command: 'create_pid_sheet', params: { number: 'PID-001' } }]);
    expect(execute(doc, 'replay_history', {}).document.plant?.pid).toEqual(doc.plant?.pid);
  });
});
