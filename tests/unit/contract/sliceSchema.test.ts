import { describe, expect, it } from 'vitest';
import { z } from '@core/commands/schema';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';

const sheet = z.object({ number: z.string().min(1), items: z.array(z.object({ tag: z.string() })) });
const slice = z.object({ version: z.literal(1), sheets: z.record(z.string(), sheet) });

describe('sliceSchemaErrors', () => {
  it('returns no error for a valid slice', () => {
    expect(sliceSchemaErrors(slice, { version: 1, sheets: { S1: { number: 'A-1', items: [{ tag: 'T' }] } } }, 'plant.pid')).toEqual([]);
  });

  it('prefixes every issue with the dotted path inside the slice, array indices in brackets', () => {
    const errors = sliceSchemaErrors(
      slice,
      { version: 1, sheets: { S1: { number: '', items: [{ tag: 'T' }, { tag: 7 }] }, S2: { number: 'B', items: 'x' } } },
      'plant.pid',
    );
    expect(errors).toHaveLength(3);
    expect(errors.map((error) => error.split(':')[0])).toEqual([
      'plant.pid.sheets.S1.number',
      'plant.pid.sheets.S1.items[1].tag',
      'plant.pid.sheets.S2.items',
    ]);
    for (const error of errors) expect(error.split(':')[1]?.trim().length).toBeGreaterThan(0);
  });

  it('names the root itself when the whole value has the wrong type, and never throws on hostile input', () => {
    expect(sliceSchemaErrors(slice, 5, 'plant.pid')).toEqual([expect.stringMatching(/^plant\.pid: /)]);
    for (const hostile of [
      null,
      undefined,
      [],
      NaN,
      'x',
      { version: 1, sheets: { __proto__: 3 } },
      { version: 1, sheets: { a: { number: 'n' } } },
    ])
      expect(() => sliceSchemaErrors(slice, hostile, 'root')).not.toThrow();
  });

  it('rejects non-finite numbers (a slice must survive JSON)', () => {
    const numbers = z.object({ x: z.number() });
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(sliceSchemaErrors(numbers, { x: value }, 's')).toEqual([expect.stringMatching(/^s\.x: /)]);
  });

  it('caps the error list so a hostile file cannot build an unbounded message', () => {
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`S${index}`, { number: 1, items: [] }]));
    expect(sliceSchemaErrors(slice, { version: 1, sheets: many }, 'plant.pid')).toHaveLength(50);
  });

  it('does not touch its input', () => {
    const value = { version: 1, sheets: { S1: { number: 3, items: [] } } };
    const copy = structuredClone(value);
    sliceSchemaErrors(slice, value, 'r');
    expect(value).toEqual(copy);
  });
});
