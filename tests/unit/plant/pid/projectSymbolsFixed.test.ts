/**
 * Plant 04 PID-FU2: project symbols for instrument bubbles, actuators and off-page connectors (`define_pid_symbol` on the classes "Instrument:<location>:<display>",
 * "Actuator:<kind>", "FlowInPipeOffPageConnector" / "FlowOutPipeOffPageConnector"). The graphics are fitted into the box of the built-in symbol (bubbles 9 x 9, connectors
 * 7 x 4, actuators 3.5 x 11 anchored on the stem foot); the sheet, the list, the load validation and the sheet content hash follow.
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { sheetContentSha256 } from '@aec/plant/pid/checks/sheetContent';
import { buildPidDrawing, type PidGlyph } from '@aec/plant/pid/render/pidDrawing';
import { getPid } from '@aec/plant/pid/state';
import { pidErrors } from '@aec/plant/pid/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { feedPumpControlled } from './authoringFixtures';

const square = (half: number): object => ({
  t: 'line',
  closed: true,
  pts: [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ],
});
const glyphOf = (doc: CadDocument, tag: string): PidGlyph => {
  const pid = getPid(doc);
  const sheet = Object.values(pid.sheets)[0] as NonNullable<ReturnType<typeof getPid>['sheets'][string]>;
  const glyph = buildPidDrawing(pid, sheet).glyphs.find((entry) => entry.tag === tag);
  if (glyph === undefined) throw new Error(`no glyph ${tag}`);
  return glyph;
};
const polygon = (glyph: PidGlyph): number[][] => {
  const found = glyph.primitives.find((primitive) => primitive.type === 'polygon');
  return found?.type === 'polygon' ? found.points.map((point) => [...point]) : [];
};

describe('define_pid_symbol: instrument bubbles', () => {
  const doc = feedPumpControlled();

  it('a 40 x 40 square for Instrument:central:shared replaces the bubble of FIC-101 only (box 9 x 9); FT-101 (field, discrete) keeps its circle', () => {
    const result = ok(doc, 'define_pid_symbol', { class: 'Instrument:central:shared', shapes: [square(20)] });
    expect(result.data).toMatchObject({ family: 'instrument', halfWidth: 9, halfHeight: 9, shapes: 1, replaced: false });
    expect(polygon(glyphOf(result.document, 'FIC-101'))).toEqual(
      [
        [-9, -9],
        [9, -9],
        [9, 9],
        [-9, 9],
      ].map(([x, y]) => [230 + (x as number), 170 + (y as number)]),
    );
    expect(glyphOf(result.document, 'FT-101').primitives.some((primitive) => primitive.type === 'circle')).toBe(true);
    expect(glyphOf(result.document, 'FIC-101').primitives.filter((primitive) => primitive.type === 'text').length).toBe(2);
  });

  it('is listed with source project, survives save / load and passes the load validation', () => {
    const defined = apply(doc, 'define_pid_symbol', { class: 'Instrument:field:discrete', shapes: [square(5)], name: 'Plant bubble' });
    const rows = data<{ rows: Array<{ class: string; source: string; name: string }> }>(defined, 'list_pid_symbols', {
      class: 'Instrument:field:discrete',
    }).rows;
    expect(rows.every((row) => row.source === 'project' && row.name === 'Plant bubble')).toBe(true);
    expect(getPid(deserializeDocument(serializeDocument(defined))).symbols).toEqual(getPid(defined).symbols);
    expect(pidErrors(JSON.parse(JSON.stringify(getPid(defined))) as Record<string, unknown>)).toEqual([]);
  });

  it('changes the content hash of the sheet that uses the class, so an issued stamp goes stale', () => {
    const pid = getPid(doc);
    const sheet = Object.values(pid.sheets)[0] as NonNullable<(typeof pid.sheets)[string]>;
    const before = sheetContentSha256(pid, sheet);
    const defined = getPid(apply(doc, 'define_pid_symbol', { class: 'Instrument:central:shared', shapes: [square(20)] }));
    expect(sheetContentSha256(defined, sheet)).not.toBe(before);
    const unused = getPid(apply(doc, 'define_pid_symbol', { class: 'Instrument:auxiliary:plc', shapes: [square(20)] }));
    expect(sheetContentSha256(unused, sheet)).toBe(before);
  });
});

describe('define_pid_symbol: actuators', () => {
  const doc = feedPumpControlled();

  it('is anchored on its foot: a 10 x 30 box with its bottom edge at y = 100 lands with the stem foot on the valve (origin); the width limit 3.5 / 5 sets the scale', () => {
    const tall = {
      t: 'line',
      closed: true,
      pts: [
        [-5, 100],
        [5, 100],
        [5, 130],
        [-5, 130],
      ],
    };
    const result = ok(doc, 'define_pid_symbol', { class: 'Actuator:diaphragm', shapes: [tall] });
    expect(result.data).toMatchObject({ family: 'actuator', halfWidth: 3.5, halfHeight: 11 });
    const stored = getPid(result.document).symbols?.['Actuator:diaphragm']?.shapes[0];
    const scale = 3.5 / 5;
    expect(stored).toMatchObject({
      t: 'line',
      pts: [
        [-5 * scale, 0],
        [5 * scale, 0],
        [5 * scale, 30 * scale],
        [-5 * scale, 30 * scale],
      ],
    });
    const valve = getPid(result.document);
    const actuating = Object.values(valve.items).find((item) => item.kind === 'actuating');
    const sheet = Object.values(valve.sheets)[0] as NonNullable<(typeof valve.sheets)[string]>;
    const glyph = buildPidDrawing(valve, sheet).glyphs.find((entry) => entry.id === actuating?.id) as PidGlyph;
    const ys = polygon(glyph).map((point) => point[1] as number);
    const valveY = (Object.values(valve.items).find((item) => item.tag === 'FV-101') as unknown as { at: number[] }).at[1] as number;
    expect(Math.min(...ys)).toBeCloseTo(valveY + 3.2, 9);
    expect(Math.max(...ys)).toBeCloseTo(valveY + 3.2 + 30 * scale, 9);
  });
});

describe('define_pid_symbol: off-page connectors', () => {
  const open = (): CadDocument =>
    apply(feedPumpControlled(), 'add_pid_line', {
      sheet: 'PID-001',
      from: { tag: 'T-101', nozzle: 'N2' },
      to: { free: [60, 240] },
      lineNumber: '50-V-1',
    });

  it('replaces the outgoing connector only; a square is limited by the 4 mm half height of the 7 x 4 box', () => {
    const base = apply(open(), 'add_pid_off_page_connector', { line: '50-V-1', end: 'end', pairKey: 'V-1' });
    const result = ok(base, 'define_pid_symbol', { class: 'FlowOutPipeOffPageConnector', shapes: [square(30)] });
    expect(result.data).toMatchObject({ family: 'connector', halfWidth: 7, halfHeight: 4 });
    const pid = getPid(result.document);
    const sheet = Object.values(pid.sheets)[0] as NonNullable<(typeof pid.sheets)[string]>;
    const opc = Object.values(pid.items).find((item) => item.kind === 'opc');
    const glyph = buildPidDrawing(pid, sheet).glyphs.find((entry) => entry.id === opc?.id);
    const corners = polygon(glyph as PidGlyph);
    expect(corners).toHaveLength(4);
    expect(Math.max(...corners.map((point) => Math.abs((point[0] as number) - (opc as unknown as { at: number[] }).at[0]!)))).toBeCloseTo(
      4,
      9,
    );
    expect(Math.max(...corners.map((point) => Math.abs((point[1] as number) - (opc as unknown as { at: number[] }).at[1]!)))).toBeCloseTo(
      4,
      9,
    );
  });
});

describe('define_pid_symbol: refusals and removal on the new families', () => {
  const doc = feedPumpControlled();

  it.each([
    ['an instrument class that does not exist', { class: 'Instrument:remote:discrete', shapes: [square(5)] }, 'PID_CLASS_UNKNOWN', 'class'],
    ['an actuator kind that does not exist', { class: 'Actuator:magic', shapes: [square(5)] }, 'PID_CLASS_UNKNOWN', 'class'],
    [
      'a degenerate actuator graphic',
      {
        class: 'Actuator:motor',
        shapes: [
          {
            t: 'line',
            pts: [
              [0, 0],
              [0, 0],
            ],
          },
        ],
      },
      'PID_SYMBOL_INVALID',
      'shapes',
    ],
    ['removing a symbol that was never defined', { class: 'Actuator:motor', remove: true }, 'PID_SYMBOL_NOT_FOUND', 'class'],
  ])('refuses %s with its code and path, document unchanged', (_name, params, code, path) => {
    const refused = expectRefusal(doc, 'define_pid_symbol', params, code, path);
    expect(refused.document).toBe(doc);
  });

  it('remove restores the built-in bubble', () => {
    const defined = apply(doc, 'define_pid_symbol', { class: 'Instrument:central:shared', shapes: [square(20)] });
    const removed = apply(defined, 'define_pid_symbol', { class: 'Instrument:central:shared', remove: true });
    expect(glyphOf(removed, 'FIC-101').primitives.some((primitive) => primitive.type === 'circle')).toBe(true);
  });

  it('the load validation refuses a stored actuator symbol that sits below its foot and one outside the box', () => {
    const defined = apply(doc, 'define_pid_symbol', { class: 'Actuator:motor', shapes: [square(3)] });
    const raw = (): Record<string, unknown> => JSON.parse(JSON.stringify(getPid(defined))) as Record<string, unknown>;
    expect(pidErrors(raw())).toEqual([]);
    const lowered = raw();
    const stored = (lowered['symbols'] as Record<string, { shapes: Array<{ pts: number[][] }> }>)['Actuator:motor'];
    (stored as { shapes: Array<{ pts: number[][] }> }).shapes[0]?.pts.forEach((point) => (point[1] = (point[1] as number) - 5));
    expect(pidErrors(lowered).join('\n')).toMatch(/lie outside the box of the built-in Actuator:motor/);
  });
});
