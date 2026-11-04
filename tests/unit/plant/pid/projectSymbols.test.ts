/**
 * Plant 04 PID-FU-4: define_pid_symbol. The definition is untrusted data: every limit has a refusal test, and the load validation of the stored symbols
 * refuses what the command would. Graphics are fitted into the box of the built-in class (Tank 25 x 25 half extents, inline components 5 x 3.2).
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { buildPidDrawing } from '@aec/plant/pid/render/pidDrawing';
import { getPid } from '@aec/plant/pid/state';
import { pidErrors } from '@aec/plant/pid/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { feedPump, feedPumpControlled } from './authoringFixtures';

const square = (half: number, at: [number, number] = [0, 0]): object => ({
  t: 'line',
  closed: true,
  pts: [
    [at[0] - half, at[1] - half],
    [at[0] + half, at[1] - half],
    [at[0] + half, at[1] + half],
    [at[0] - half, at[1] + half],
  ],
});

interface Row {
  class: string;
  convention: string;
  source: string;
  shapes: number;
}
const rows = (doc: CadDocument, params: Record<string, unknown>): Row[] => data<{ rows: Row[] }>(doc, 'list_pid_symbols', params).rows;
const polygonOf = (doc: CadDocument, tag: string, convention?: 'ISA-5.1' | 'ISO-10628-2'): number[][] => {
  const pid = getPid(doc);
  const sheet = Object.values(pid.sheets)[0] as NonNullable<ReturnType<typeof getPid>['sheets'][string]>;
  const glyph = buildPidDrawing(pid, sheet, convention).glyphs.find((entry) => entry.tag === tag);
  const polygon = glyph?.primitives.find((primitive) => primitive.type === 'polygon');
  return polygon?.type === 'polygon' ? polygon.points.map((point) => [...point]) : [];
};

describe('define_pid_symbol: graphics fitted into the box of the class', () => {
  const doc = feedPump();

  it('a 100 x 100 square for Tank (half extents 25 x 25) is scaled by 0.25 and the Tank on the sheet is drawn with it: corners at the tank position +/- 25', () => {
    const result = ok(doc, 'define_pid_symbol', { class: 'Tank', shapes: [square(50)] });
    expect(result.data).toMatchObject({ class: 'Tank', family: 'equipment', shapes: 1, halfWidth: 25, halfHeight: 25, replaced: false });
    expect(result.affected).toEqual([]);
    const stored = getPid(result.document).symbols?.['Tank'];
    expect(stored?.conventions).toEqual(['ISA-5.1', 'ISO-10628-2']);
    expect(stored?.shapes[0]).toMatchObject({
      t: 'line',
      closed: true,
      pts: [
        [-25, -25],
        [25, -25],
        [25, 25],
        [-25, 25],
      ],
    });
    expect(polygonOf(result.document, 'T-101').sort()).toEqual(
      [
        [35, 125],
        [35, 175],
        [85, 125],
        [85, 175],
      ].sort(),
    );
    expect(polygonOf(result.document, 'T-101', 'ISO-10628-2')).toHaveLength(4);
  });

  it('an offset 40 x 20 rectangle is centred and scaled by min(25 / 20, 25 / 10) = 1.25 to +/-25 x +/-12.5; a circle and a text are scaled with it', () => {
    const result = ok(doc, 'define_pid_symbol', {
      class: 'Tank',
      name: 'Company tank',
      shapes: [
        {
          t: 'line',
          closed: true,
          pts: [
            [80, 90],
            [120, 90],
            [120, 110],
            [80, 110],
          ],
        },
        { t: 'circle', c: [100, 100], r: 4 },
        { t: 'text', at: [100, 100], h: 2, s: 'T' },
      ],
    });
    const stored = getPid(result.document).symbols?.['Tank'];
    expect(stored?.name).toBe('Company tank');
    expect(stored?.shapes[0]).toMatchObject({
      pts: [
        [-25, -12.5],
        [25, -12.5],
        [25, 12.5],
        [-25, 12.5],
      ],
    });
    expect(stored?.shapes[1]).toMatchObject({ t: 'circle', c: [0, 0], r: 5 });
    expect(stored?.shapes[2]).toMatchObject({ t: 'text', at: [0, 0], h: 2.5, s: 'T' });
  });

  it('an inline class takes the box 5 x 3.2: a BallValve drawn 20 x 20 shrinks by min(5/10, 3.2/10) = 0.32', () => {
    const result = ok(feedPumpControlled(), 'define_pid_symbol', { class: 'BallValve', shapes: [square(10)] });
    expect(getPid(result.document).symbols?.['BallValve']?.shapes[0]).toMatchObject({
      pts: [
        [-3.2, -3.2],
        [3.2, -3.2],
        [3.2, 3.2],
        [-3.2, 3.2],
      ],
    });
    expect(result.data).toMatchObject({ family: 'piping', halfWidth: 5, halfHeight: 3.2 });
  });

  it('fromEntities copies a rectangle and a polyline drawn in the document, with their positions applied', () => {
    let drawn = apply(doc, 'draw_rectangle', { width: 40, height: 20, position: [100, 50, 0] });
    drawn = apply(drawn, 'draw_polyline', {
      points: [
        [0, 0],
        [40, 20],
      ],
      position: [100, 50, 0],
    });
    const ids = drawn.order.slice(-2);
    const result = ok(drawn, 'define_pid_symbol', { class: 'PressureVessel', fromEntities: ids });
    const stored = getPid(result.document).symbols?.['PressureVessel'];
    expect(stored?.shapes).toHaveLength(2);
    const ys = (stored?.shapes[0] as unknown as { pts: number[][] }).pts.map((point) => point[1] as number);
    // the drawing is 40 x 20 (half 20 x 10) and PressureVessel is 15 x 30: scale min(15 / 20, 30 / 10) = 0.75
    expect(Math.max(...ys)).toBeCloseTo(7.5, 9);
    expect(Math.min(...ys)).toBeCloseTo(-7.5, 9);
  });

  it('conventions limit it: ISO only leaves the ISA-5.1 drawing on the built-in symbol; list_pid_symbols says "project"; a second call replaces; remove restores the built-in', () => {
    const iso = apply(doc, 'define_pid_symbol', { class: 'Tank', conventions: ['ISO-10628-2'], shapes: [square(50)] });
    expect(rows(iso, { class: 'Tank' }).map((row) => [row.convention, row.source])).toEqual([
      ['ISA-5.1', 'builtin'],
      ['ISO-10628-2', 'project'],
    ]);
    const replaced = ok(iso, 'define_pid_symbol', { class: 'Tank', shapes: [square(20)] });
    expect(replaced.data).toMatchObject({ replaced: true });
    expect(rows(replaced.document, { class: 'Tank' }).map((row) => row.source)).toEqual(['project', 'project']);
    expect(rows(replaced.document, { class: 'Tank' })[0]?.shapes).toBe(1);
    const removed = ok(replaced.document, 'define_pid_symbol', { class: 'Tank', remove: true });
    expect(removed.data).toMatchObject({ removed: true });
    expect(getPid(removed.document).symbols).toBeUndefined();
    expect(rows(removed.document, { class: 'Tank' }).map((row) => row.source)).toEqual(['builtin', 'builtin']);
  });

  it('survives a save / load round trip and is pure', () => {
    const snapshot = JSON.stringify(doc);
    const defined = apply(doc, 'define_pid_symbol', { class: 'Tank', shapes: [square(50)] });
    expect(JSON.stringify(doc)).toBe(snapshot);
    const loaded = deserializeDocument(serializeDocument(defined));
    expect(getPid(loaded).symbols).toEqual(getPid(defined).symbols);
  });
});

describe('define_pid_symbol: untrusted definitions are refused with a path, the document unchanged', () => {
  const doc = feedPump();
  const line = (pts: unknown): object => ({ t: 'line', pts });
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ['a class that is not in the library', { class: 'Spaceship', shapes: [square(5)] }, 'PID_CLASS_UNKNOWN', 'class'],
    ['an instrument bubble class (no project symbols)', { class: 'FieldBubble', shapes: [square(5)] }, 'PID_CLASS_UNKNOWN', 'class'],
    ['both fromEntities and shapes', { class: 'Tank', shapes: [square(5)], fromEntities: ['x'] }, 'PID_PARAM_INVALID', 'shapes'],
    ['neither fromEntities nor shapes', { class: 'Tank' }, 'PID_PARAM_INVALID', 'shapes'],
    ['an entity that does not exist', { class: 'Tank', fromEntities: ['rect-404'] }, 'PID_SYMBOL_INVALID', 'fromEntities.0'],
    [
      'a coordinate beyond +/-1000 mm',
      {
        class: 'Tank',
        shapes: [
          line([
            [0, 0],
            [1e9, 0],
          ]),
        ],
      },
      'PID_SYMBOL_INVALID',
      'shapes',
    ],
    [
      'a point that is not [x, y]',
      {
        class: 'Tank',
        shapes: [
          line([
            [0, 0],
            [1, 2, 3],
          ]),
        ],
      },
      'PID_SYMBOL_INVALID',
      'shapes',
    ],
    ['a line of one point', { class: 'Tank', shapes: [line([[0, 0]])] }, 'PID_SYMBOL_INVALID', 'shapes'],
    ['65 shapes (limit 64)', { class: 'Tank', shapes: Array.from({ length: 65 }, () => square(5)) }, 'CMD_INVALID_PARAMS', ''],
    [
      '201 points in a line',
      { class: 'Tank', shapes: [line(Array.from({ length: 201 }, (_, i) => [i, 0]))] },
      'PID_SYMBOL_INVALID',
      'shapes',
    ],
    ['a circle of radius 0', { class: 'Tank', shapes: [{ t: 'circle', c: [0, 0], r: 0 }] }, 'PID_SYMBOL_INVALID', 'shapes'],
    ['a circle without a centre', { class: 'Tank', shapes: [{ t: 'circle', r: 3 }] }, 'PID_SYMBOL_INVALID', 'shapes'],
    [
      'a text with markup characters',
      { class: 'Tank', shapes: [{ t: 'text', at: [0, 0], h: 2, s: '<script>' }] },
      'PID_SYMBOL_INVALID',
      'shapes',
    ],
    [
      'a text of 25 characters',
      { class: 'Tank', shapes: [{ t: 'text', at: [0, 0], h: 2, s: 'x'.repeat(25) }] },
      'PID_SYMBOL_INVALID',
      'shapes',
    ],
    ['a text of height 0', { class: 'Tank', shapes: [{ t: 'text', at: [0, 0], h: 0, s: 'a' }] }, 'PID_SYMBOL_INVALID', 'shapes'],
    [
      'graphics with no extent',
      {
        class: 'Tank',
        shapes: [
          line([
            [3, 3],
            [3, 3],
          ]),
        ],
      },
      'PID_SYMBOL_INVALID',
      'shapes',
    ],
    ['remove of a class that has no project symbol', { class: 'Tank', remove: true }, 'PID_SYMBOL_NOT_FOUND', 'class'],
    ['remove together with graphics', { class: 'Tank', remove: true, shapes: [square(5)] }, 'PID_PARAM_INVALID', 'remove'],
  ];
  it.each(cases)('%s', (_name, params, code, path) => {
    if (code === 'CMD_INVALID_PARAMS') {
      const result = execute(doc, 'define_pid_symbol', params);
      expect(result.error?.code).toBe(code);
      expect(result.document).toBe(doc);
      return;
    }
    expectRefusal(doc, 'define_pid_symbol', params, code, path);
  });

  it('refuses a 3D entity, an ellipse (unsupported) and an entity drawn out of the XY plane', () => {
    let drawn = apply(doc, 'add_box', { size: [10, 10, 10], position: [0, 0, 0] });
    const box = drawn.order.at(-1) as string;
    expectRefusal(drawn, 'define_pid_symbol', { class: 'Tank', fromEntities: [box] }, 'PID_SYMBOL_INVALID', 'fromEntities.0');
    drawn = apply(doc, 'draw_ellipse', { center: [0, 0], radiusX: 10, radiusY: 5 });
    expectRefusal(
      drawn,
      'define_pid_symbol',
      { class: 'Tank', fromEntities: [drawn.order.at(-1) as string] },
      'PID_SYMBOL_INVALID',
      'fromEntities.0',
    );
  });

  it('a prototype-key class or an unknown key never reaches the stored map', () => {
    expectRefusal(doc, 'define_pid_symbol', { class: '__proto__', shapes: [square(5)] }, 'PID_CLASS_UNKNOWN', 'class');
    expectRefusal(doc, 'define_pid_symbol', { class: 'constructor', shapes: [square(5)] }, 'PID_CLASS_UNKNOWN', 'class');
  });
});

describe('load validation of stored symbols', () => {
  const defined = apply(feedPump(), 'define_pid_symbol', { class: 'Tank', shapes: [square(50)] });
  const raw = (): Record<string, unknown> => JSON.parse(JSON.stringify(getPid(defined))) as Record<string, unknown>;
  const symbol = (state: Record<string, unknown>): Record<string, unknown> =>
    (state['symbols'] as Record<string, Record<string, unknown>>)['Tank'] as Record<string, unknown>;

  it('accepts what the command stored', () => {
    expect(pidErrors(raw())).toEqual([]);
  });

  it.each([
    [
      'a key that is not a library class',
      (state: Record<string, unknown>) => ((state['symbols'] as Record<string, unknown>)['Nope'] = symbol(state)),
      /key must be an equipment or piping class/,
    ],
    ['a class that differs from the key', (state: Record<string, unknown>) => (symbol(state)['class'] = 'Pump'), /class equals its key/],
    ['an empty name', (state: Record<string, unknown>) => (symbol(state)['name'] = ''), /name must be 1 to 64/],
    [
      'conventions that are not conventions',
      (state: Record<string, unknown>) => (symbol(state)['conventions'] = ['DIN']),
      /conventions must list/,
    ],
    ['no shapes', (state: Record<string, unknown>) => (symbol(state)['shapes'] = []), /must not be empty/],
    [
      'a non-finite coordinate',
      (state: Record<string, unknown>) =>
        (((symbol(state)['shapes'] as Array<Record<string, unknown>>)[0] as { pts: unknown[] }).pts[0] = [null, 0]),
      /every point must be/,
    ],
    [
      'a shape of an unknown type',
      (state: Record<string, unknown>) => ((symbol(state)['shapes'] as Array<Record<string, unknown>>)[0] = { t: 'script' }),
      /t must be line, circle or text/,
    ],
    [
      'graphics outside the box of the built-in symbol',
      (state: Record<string, unknown>) =>
        ((symbol(state)['shapes'] as Array<Record<string, unknown>>)[0] = { t: 'circle', c: [0, 0], r: 90 }),
      /outside the box/,
    ],
    ['symbols that are not an object', (state: Record<string, unknown>) => (state['symbols'] = []), /plant.pid.symbols must be an object/],
  ])('refuses %s', (_name, mutate, pattern) => {
    const state = raw();
    mutate(state);
    expect(pidErrors(state).join('\n')).toMatch(pattern);
  });
});

describe('define_pid_symbol: what is accepted always loads (the fitted shapes are re-validated)', () => {
  const base = feedPump();
  const drawing = (extent: number): object[] => [
    {
      t: 'line',
      closed: true,
      pts: [
        [0, 0],
        [extent, 0],
        [extent, extent],
        [0, extent],
      ],
    },
    { t: 'text', at: [extent / 2, extent / 2], h: 2, s: 'T' },
  ];

  it('a tiny drawing whose text would scale beyond 100 mm is refused with PID_SYMBOL_INVALID, not stored', () => {
    expectRefusal(base, 'define_pid_symbol', { class: 'Tank', shapes: drawing(0.01) }, 'PID_SYMBOL_INVALID', 'shapes');
  });

  it('property: over extents from 0.001 to 1000 mm every accepted definition survives serialize / deserialize and the load validation', () => {
    let accepted = 0;
    for (const extent of [0.001, 0.01, 0.1, 1, 10, 50, 100, 500, 1000]) {
      const result = execute(base, 'define_pid_symbol', { class: 'Tank', shapes: drawing(extent) });
      if (result.rejected !== undefined) {
        expect(result.error?.code, `extent ${extent}`).toBe('PID_SYMBOL_INVALID');
        continue;
      }
      accepted += 1;
      expect(pidErrors(getPid(result.document)), `extent ${extent}`).toEqual([]);
      expect(getPid(deserializeDocument(serializeDocument(result.document))).symbols).toEqual(getPid(result.document).symbols);
    }
    expect(accepted).toBeGreaterThan(3);
  });
});
