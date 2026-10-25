/**
 * Plant 04 PID M1 review fixes: line <-> segment membership both ways, reserved names as record keys (a JSON.parse'd __proto__), and the tag pattern
 * safety check.
 */

import { describe, expect, it } from 'vitest';
import { MAX_TAG_PATTERN_LENGTH } from '@aec/plant/pid/patternSafety';
import { pidErrors } from '@aec/plant/pid/validate';

const item = (id: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind,
  sheetId: 's1',
  at: [0, 0],
  rotationDeg: 0,
  dexpiClass: 'X',
  attributes: {},
  ...extra,
});

const segment = (id: string, lineId: string): Record<string, unknown> =>
  item(id, 'segment', {
    lineId,
    from: { type: 'free', at: [0, 0] },
    to: { type: 'free', at: [1, 0] },
    route: [
      [0, 0],
      [1, 0],
    ],
    flow: 'forward',
    primary: true,
  });

/** A valid slice: one sheet, one line with two segments. */
function slice(edit: (raw: Record<string, unknown>) => void = () => undefined): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    version: 1,
    convention: 'ISA-5.1',
    lineNumberFormat: '{dn}',
    tagFormats: {},
    sheets: { s1: { id: 's1', number: 'PID-1', title: '', paper: 'A1', revision: 'A', status: 'draft' } },
    sheetOrder: ['s1'],
    items: { L: item('L', 'line', { segmentIds: ['a', 'b'] }), a: segment('a', 'L'), b: segment('b', 'L') },
    itemOrder: ['L', 'a', 'b'],
    counters: {},
  };
  edit(raw);
  return raw;
}

const items = (raw: Record<string, unknown>): Record<string, Record<string, unknown>> =>
  raw['items'] as Record<string, Record<string, unknown>>;

describe('plant.pid: line and segment membership', () => {
  it('the base slice is valid', () => {
    expect(pidErrors(slice())).toEqual([]);
  });

  it('refuses a segment its line does not list', () => {
    const errors = pidErrors(slice((raw) => (items(raw)['L']!['segmentIds'] = ['a'])));
    expect(errors).toEqual(['plant.pid.items.b.lineId: the line does not list this segment in segmentIds']);
  });

  it('refuses a line listing a segment twice', () => {
    const errors = pidErrors(slice((raw) => (items(raw)['L']!['segmentIds'] = ['a', 'b', 'a'])));
    expect(errors).toContain('plant.pid.items.L.segmentIds lists a segment twice');
  });

  it('checks a long line in linear time', () => {
    const count = 20_000;
    const ids = Array.from({ length: count }, (_, i) => `g${i}`);
    const raw = slice((r) => {
      items(r)['L']!['segmentIds'] = ids;
      for (const id of ids) items(r)[id] = segment(id, 'L');
      r['itemOrder'] = ['L', ...ids];
      delete items(r)['a'];
      delete items(r)['b'];
    });
    const started = performance.now();
    expect(pidErrors(raw)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('plant.pid: reserved names as record keys', () => {
  const parsed = (json: string): unknown => JSON.parse(json);

  it('refuses __proto__ and constructor in attributes, passthrough, acceptances and counters', () => {
    const errors = pidErrors(
      slice((raw) => {
        items(raw)['L']!['attributes'] = parsed('{"__proto__":{"kind":"text","value":"x"}}');
        items(raw)['a']!['passthrough'] = parsed('{"constructor":"x"}');
        raw['acceptances'] = parsed('{"__proto__":{"reason":"r","by":"b","at":"t"}}');
        raw['counters'] = parsed('{"toString":1}');
      }),
    );
    expect(errors).toContain('plant.pid.items.L.attributes.__proto__: the name is reserved');
    expect(errors).toContain('plant.pid.items.a.passthrough.constructor: the name is reserved');
    expect(errors).toContain('plant.pid.acceptances.__proto__: the name is reserved');
    expect(errors).toContain('plant.pid.counters.toString: the name is reserved');
  });
});

describe('plant.pid: tag pattern safety', () => {
  const errorsFor = (pattern: string): string[] =>
    pidErrors(slice((raw) => (raw['tagFormats'] = { equipment: { pattern, separator: '-' } })));

  it.each(['^[A-Z]-\\d{3}$', '^(?:FIC|TIC)-\\d+[A-Z]?$', '^([A-Z]{1,3})-(\\d{3})$', '^(?:[A-Z]\\d?)?$', '^(ab){2}$'])(
    'accepts %s',
    (pattern) => {
      expect(errorsFor(pattern)).toEqual([]);
    },
  );

  it.each([
    ['^(a+)+$', /catastrophic/],
    ['^(\\d*)*$', /catastrophic/],
    ['^(x{2,})*$', /catastrophic/],
    ['^(a|b+)+c$', /catastrophic/],
    ['^(a)\\1$', /backreferences/],
    ['^(?<n>a)\\k<n>$', /backreferences/],
    ['^(?=a)a$', /lookahead/],
    ['^(?<!a)b$', /lookahead/],
    ['(', /regular expression/],
    ['a'.repeat(MAX_TAG_PATTERN_LENGTH + 1), /longer than 200/],
  ])('refuses %s', (pattern, expected) => {
    const errors = errorsFor(pattern);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(expected);
  });

  it('accepts a pattern of exactly the maximum length', () => {
    expect(errorsFor('a'.repeat(MAX_TAG_PATTERN_LENGTH))).toEqual([]);
  });
});
