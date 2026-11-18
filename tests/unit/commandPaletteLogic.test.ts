import { describe, it, expect } from 'vitest';
import type { ParamsSchema } from '@core/commands/types';
import { listCommands } from '@core/commands/registry';
import { fuzzyScore } from '@ui/components/commandPalette/fuzzyMatch';
import { fieldsFromSchema, humanizeName, initialValues, parseFormValues } from '@ui/components/commandPalette/paramForm';
import { allPaletteItems, searchPaletteItems } from '@ui/components/commandPalette/paletteItems';
import { suggestedPaletteIds } from '@ui/components/commandPalette/paletteSuggestions';
import { booleanPreset } from '@ui/components/toolbar/commandTools';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { xy } from '../helpers/xy';

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
  it('ranks a whole-word hit above a word-prefix hit', () => {
    expect(fuzzyScore('measure', 'add box', 'measure the volume')).toBeGreaterThan(
      fuzzyScore('measure', 'add box', 'arc lengths measured'),
    );
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
  it('writes dimensions and format acronyms in capitals', () => {
    expect(humanizeName('fillet_2d')).toBe('Fillet 2D');
    expect(humanizeName('export_stl')).toBe('Export STL');
    expect(humanizeName('import_iges_file')).toBe('Import IGES file');
    expect(humanizeName('add_d2_step')).toBe('Add d2 step');
  });
  it('derives one field per property, required first, with a kind per type', () => {
    const fields = fieldsFromSchema(SCHEMA);
    expect(fields.map((f) => f.name)).toEqual(['id', 'radius', 'mode', 'note', 'entityId2', 'anchor', 'flip', 'position', 'ids', 'points']);
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
    expect(parseFormValues(fields, { count: '3', indices: '0, 2' })).toEqual({ ok: true, params: { count: 3, indices: [0, 2] } });
  });
  it('pre-fills id fields from the selection and required enums with their first option', () => {
    const values = initialValues(fieldsFromSchema(SCHEMA), ['box-1.1', 'cyl-2.1']);
    expect(values).toMatchObject({ id: 'box-1.1', entityId2: 'cyl-2.1', ids: 'box-1.1, cyl-2.1', mode: 'a', anchor: '', note: '' });
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
      params: { id: 'box-1.1', radius: 2.5, mode: 'b', flip: false, position: [1, 2, 3], ids: ['a', 'b'], points: xy(0, 0, 1, 1) },
    });
  });
  it('reports missing required fields and unparseable values per field', () => {
    const result = parseFormValues(fieldsFromSchema(SCHEMA), { id: '', radius: 'big', mode: 'a', position: '1, x', points: '[oops' });
    expect(result).toEqual({
      ok: false,
      errors: { id: 'Required.', radius: 'Enter a number.', position: 'Enter numbers, e.g. 0, 0, 10.', points: 'Enter valid JSON.' },
    });
  });
});

describe('palette catalog', () => {
  const items = allPaletteItems();
  it('exposes every registry command exactly once', () => {
    const commandNames = items.flatMap((item) => (item.kind === 'command' ? [item.command.name] : []));
    expect([...commandNames].sort()).toEqual(
      listCommands()
        .map((c) => c.name)
        .sort(),
    );
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });
  it('groups commands by toolset, each group one contiguous run', () => {
    const commands = items.filter((item) => item.kind === 'command');
    expect(commands.find((item) => item.id === 'command:add_box')?.group).toBe('3D solids');
    expect(commands.find((item) => item.id === 'command:measure_distance')?.group).toBe('Measure');
    const runs = commands.map((item) => item.group).filter((group, index, all) => group !== all[index - 1]);
    expect(new Set(runs).size).toBe(runs.length);
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
    expect(results[0]?.id).toBe('command:mass_properties');
    expect(searchPaletteItems(items, 'qqqzzz', [])).toEqual([]);
  });
  it('opens an empty query on the suggestions for the selection, then recents, each listed once', () => {
    const results = searchPaletteItems(items, '', ['command:boolean', 'action:undo'], ['command:boolean', 'command:align', 'command:gone']);
    expect(results.slice(0, 3).map((r) => [r.id, r.group])).toEqual([
      ['command:boolean', 'Suggested for the selection'],
      ['command:align', 'Suggested for the selection'],
      ['action:undo', 'Recent'],
    ]);
    expect(results).toHaveLength(items.length);
  });
});

describe('palette suggestions', () => {
  const add = (doc: ReturnType<typeof createEmptyDocument>, name: string, params: unknown): ReturnType<typeof createEmptyDocument> =>
    execute(doc, name, params).document;
  const base = add(add(add(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }), 'add_sphere', { radius: 1 }), 'draw_rectangle', {
    width: 2,
    height: 1,
  });
  const [boxId, sphereId, rectId] = base.order as [string, string, string];
  const suggest = (selection: string[]): string[] => suggestedPaletteIds({ ...base, selection });

  it('suggests nothing without a selection (or for ids that are not entities)', () => {
    expect(suggest([])).toEqual([]);
    expect(suggest(['gone'])).toEqual([]);
  });
  it('suggests solid features for one solid and sketch features for one sketch', () => {
    expect(suggest([boxId]).slice(0, 3)).toEqual(['command:fillet_edge', 'command:chamfer_edge', 'command:shell_solid']);
    expect(suggest([rectId]).slice(0, 2)).toEqual(['command:extrude_profile', 'command:revolve_profile']);
  });
  it('suggests combining several solids, lofting several sketches, and arranging a mixed selection', () => {
    expect(suggest([boxId, sphereId])[0]).toBe('command:boolean');
    expect(suggest([rectId, rectId])[0]).toBe('command:loft_sections');
    expect(suggest([boxId, rectId])).toEqual(['command:align', 'command:measure_distance', 'command:group_entities']);
  });
  it('every suggested command is in the palette catalog', () => {
    const ids = new Set(allPaletteItems().map((item) => item.id));
    for (const selection of [[boxId], [rectId], [boxId, sphereId], [rectId, rectId], [boxId, rectId]]) {
      for (const id of suggest(selection)) expect(ids.has(id), id).toBe(true);
    }
  });
  it('the boolean shortcut takes the first selected solid as the base and the others as tools', () => {
    expect(booleanPreset('subtract', { ...base, selection: [rectId, boxId, sphereId] })).toEqual({ op: 'subtract', a: boxId, b: sphereId });
    expect(booleanPreset('union', { ...base, selection: [boxId, sphereId, boxId] })).toEqual({
      op: 'union',
      a: boxId,
      b: [sphereId, boxId],
    });
    expect(booleanPreset('intersect', { ...base, selection: [] })).toEqual({ op: 'intersect' });
  });
});
