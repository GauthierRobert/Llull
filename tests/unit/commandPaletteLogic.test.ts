/**
 * Command palette pure logic: fuzzy ranking, schema -> form fields, form text -> params, and the
 * catalog (every registry command reachable, recents first on an empty query).
 */

import { describe, it, expect } from 'vitest';
import type { ParamsSchema } from '@core/commands/types';
import { listCommands } from '@core/commands/registry';
import { fuzzyScore } from '@ui/components/commandPalette/fuzzyMatch';
import {
  fieldsFromSchema,
  humanizeName,
  initialValues,
  parseFormValues,
} from '@ui/components/commandPalette/paramForm';
import { allPaletteItems, searchPaletteItems } from '@ui/components/commandPalette/paletteItems';

describe('fuzzyScore', () => {
  it('matches everything on an empty query', () => {
    expect(fuzzyScore('  ', 'Add box')).toBe(1);
  });

  it('ranks prefix > word start > substring > subsequence', () => {
    const prefix = fuzzyScore('add', 'add box');
    const wordStart = fuzzyScore('box', 'add box');
    const substring = fuzzyScore('dd', 'add box');
    const subsequence = fuzzyScore('abx', 'add box');
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
  });

  it('requires every token, from the label or the keywords', () => {
    expect(fuzzyScore('add cyl', 'Add cylinder')).toBeGreaterThan(0);
    expect(fuzzyScore('volume', 'Measure volume')).toBeGreaterThan(0);
    expect(fuzzyScore('hole', 'Boolean subtract', 'cut a hole')).toBeGreaterThan(0);
    expect(fuzzyScore('add zzz', 'Add box')).toBe(0);
  });

  it('prefers a label hit over a keyword-only hit', () => {
    expect(fuzzyScore('box', 'Add box')).toBeGreaterThan(fuzzyScore('box', 'Add cone', 'box'));
  });
});

const SCHEMA: ParamsSchema = {
  type: 'object',
  properties: {
    note: { type: 'string', description: 'Free text' },
    id: { type: 'string', description: 'Target entity id' },
    entityId2: { type: 'string', description: 'Second entity' },
    radius: { type: 'number', description: 'Radius' },
    anchor: { type: 'string', description: 'Anchor', enum: ['center', 'min'] },
    mode: { type: 'string', description: 'Mode', enum: ['a', 'b'] },
    flip: { type: 'boolean', description: 'Flip it' },
    position: { type: 'array', description: 'XYZ', items: { type: 'number' } },
    ids: { type: 'array', description: 'Entity ids', items: { type: 'string' } },
    points: { type: 'array', description: 'Points', items: { type: 'array' } },
  },
  required: ['id', 'radius', 'mode'],
};

describe('paramForm', () => {
  it('humanizes snake_case and camelCase names', () => {
    expect(humanizeName('add_box')).toBe('Add box');
    expect(humanizeName('entityId')).toBe('Entity id');
  });

  it('derives one field per property, required first, with a kind per type', () => {
    const fields = fieldsFromSchema(SCHEMA);
    expect(fields.map((f) => f.name)).toEqual([
      'id',
      'radius',
      'mode',
      'note',
      'entityId2',
      'anchor',
      'flip',
      'position',
      'ids',
      'points',
    ]);
    const kinds = Object.fromEntries(fields.map((f) => [f.name, f.kind]));
    expect(kinds).toEqual({
      id: 'text',
      radius: 'number',
      mode: 'enum',
      note: 'text',
      entityId2: 'text',
      anchor: 'enum',
      flip: 'boolean',
      position: 'numberList',
      ids: 'textList',
      points: 'json',
    });
    expect(fields.find((f) => f.name === 'anchor')?.options).toEqual(['center', 'min']);
  });

  it('renders integer params and integer arrays exactly like number ones', () => {
    const fields = fieldsFromSchema({
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'Count' },
        indices: { type: 'array', description: 'Indices', items: { type: 'integer' } },
      },
      required: ['count'],
    });
    expect(fields.map((f) => [f.name, f.kind])).toEqual([
      ['count', 'number'],
      ['indices', 'numberList'],
    ]);
    expect(parseFormValues(fields, { count: '3', indices: '0, 2' })).toEqual({
      ok: true,
      params: { count: 3, indices: [0, 2] },
    });
  });

  it('pre-fills id fields from the selection and required enums with their first option', () => {
    const values = initialValues(fieldsFromSchema(SCHEMA), ['box-1.1', 'cyl-2.1']);
    expect(values).toMatchObject({
      id: 'box-1.1',
      entityId2: 'cyl-2.1',
      ids: 'box-1.1, cyl-2.1',
      mode: 'a',
      anchor: '',
      note: '',
    });
    expect(initialValues(fieldsFromSchema(SCHEMA), []).id).toBe('');
    const requiredBoolean = fieldsFromSchema({
      type: 'object',
      properties: { visible: { type: 'boolean', description: 'Visible' } },
      required: ['visible'],
    });
    expect(initialValues(requiredBoolean, [])).toEqual({ visible: 'true' });
  });

  it('parses typed text into params, omitting blank optional fields', () => {
    const result = parseFormValues(fieldsFromSchema(SCHEMA), {
      id: 'box-1.1',
      radius: ' 2.5 ',
      mode: 'b',
      flip: 'false',
      position: '1, 2 3',
      ids: 'a, b',
      points: '[[0,0],[1,1]]',
      note: '',
    });
    expect(result).toEqual({
      ok: true,
      params: {
        id: 'box-1.1',
        radius: 2.5,
        mode: 'b',
        flip: false,
        position: [1, 2, 3],
        ids: ['a', 'b'],
        points: [
          [0, 0],
          [1, 1],
        ],
      },
    });
  });

  it('reports missing required fields and unparseable values per field', () => {
    const result = parseFormValues(fieldsFromSchema(SCHEMA), {
      id: '',
      radius: 'big',
      mode: 'a',
      position: '1, x',
      points: '[oops',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        id: 'Required.',
        radius: 'Enter a number.',
        position: 'Enter numbers, e.g. 0, 0, 10.',
        points: 'Enter valid JSON.',
      },
    });
  });
});

describe('palette catalog', () => {
  const items = allPaletteItems();

  it('exposes every registry command exactly once', () => {
    const commandNames = items.flatMap((item) =>
      item.kind === 'command' ? [item.command.name] : [],
    );
    expect(commandNames).toEqual(listCommands().map((c) => c.name));
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it('marks commands that need input with an ellipsis', () => {
    const addBox = items.find((item) => item.id === 'command:add_box');
    expect(addBox?.label).toBe('Add box…');
  });

  it('lists recents first (as "Recent") on an empty query, without duplicates', () => {
    const results = searchPaletteItems(items, '', ['command:add_box', 'action:undo', 'gone']);
    expect(results.slice(0, 2).map((r) => [r.id, r.group])).toEqual([
      ['command:add_box', 'Recent'],
      ['action:undo', 'Recent'],
    ]);
    expect(results).toHaveLength(items.length);
  });

  it('ranks the best label match first and drops non-matches', () => {
    const results = searchPaletteItems(items, 'measure vol', []);
    expect(results[0]?.id).toBe('command:measure_volume');
    expect(searchPaletteItems(items, 'qqqzzz', [])).toEqual([]);
  });
});
