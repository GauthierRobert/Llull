import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { Entity } from '@core/model/types';
import { sheetMetalErrors } from '@aero/sheetmetal/validate';
import { sheetMetalDocument } from '@aero/sheetmetal/derive';
import { RULE, bracket } from './helpers';
import { apply } from '../../../helpers/commandAssertions';

type Json = Record<string, unknown>;

/** A saved slice that contains every node type: bend, joggle (with its flats and bends) and relief. */
function validSlice(): Json {
  const { doc, part } = bracket(
    { relief: { type: 'rectangular', widthRatio: 0.5 }, thresholds: { minFlange: { value: 3, source: 'rule' } } },
    false,
  );
  let next = apply(doc, 'add_flange', {
    id: part,
    edge: { near: [33.6, 25, 0] },
    angle: 90,
    length: 30,
    lengthReference: 'outside_mold_line',
    position: 'material_outside',
    widthStart: 4,
    autoRelief: false,
  });
  next = apply(next, 'add_relief', { id: part, bend: 'b1', end: 'end' });
  next = apply(next, 'add_joggle', {
    id: part,
    face: { near: [10, 25, 0] },
    line: [
      [20, 50],
      [20, 0],
    ],
    offset: 3,
    angle: 30,
    side: 'up',
  });
  next = apply(next, 'import_bend_radius_table', {
    rows: [{ material: '2024-T3', temper: 'T3', thickness: 1.6, minInsideRadius: 4, units: 'mm', bendAngle: 90, source: 'test' }],
  });
  return JSON.parse(JSON.stringify(next.sheetMetal)) as Json;
}

const part = (slice: Json): Json => Object.values(slice['parts'] as Json)[0] as Json;
const nodes = (slice: Json): Record<string, Json> => part(slice)['nodes'] as Record<string, Json>;
const rule = (slice: Json): Json => (slice['rules'] as Record<string, Json>)[RULE.name] as Json;

function errorsAfter(edit: (slice: Json) => void): string[] {
  const slice = validSlice();
  edit(slice);
  return sheetMetalErrors(slice);
}

describe('sheetMetalErrors', () => {
  it('accepts a complete valid slice', () => {
    expect(sheetMetalErrors(validSlice())).toEqual([]);
    expect(Object.values(nodes(validSlice())).map((node) => node['type'])).toEqual(
      expect.arrayContaining(['flat', 'bend', 'joggle', 'relief']),
    );
  });

  it.each<[string, (slice: Json) => void, string]>([
    ['rule name mismatch', (s) => ((s['rules'] as Json)['other'] = rule(s)), 'named'],
    ['rule thickness', (s) => (rule(s)['thickness'] = 0), 'thickness'],
    ['rule radius', (s) => (rule(s)['insideRadius'] = -1), 'insideRadius'],
    ['K standard', (s) => (rule(s)['k'] = { standard: 'xx', value: 0.4 }), 'standard'],
    ['K value', (s) => (rule(s)['k'] = { standard: 'ansi', value: 0.9 }), 'value'],
    [
      'K table row',
      (s) => (rule(s)['k'] = { standard: 'ansi', table: [{ rOverT: 1, k: 0.9 }], source: 's', verification: 'verified' }),
      'table[0]',
    ],
    [
      'K table source',
      (s) => (rule(s)['k'] = { standard: 'ansi', table: [{ rOverT: 1, k: 0.4 }], source: '', verification: 'verified' }),
      'source',
    ],
    [
      'K table verification',
      (s) => (rule(s)['k'] = { standard: 'din', table: [{ rOverT: 1, k: 0.4 }], source: 's', verification: 'maybe' }),
      'verification',
    ],
    ['threshold', (s) => (rule(s)['thresholds'] = { minFlange: { value: -1, source: '', verification: 'x' } }), 'thresholds.minFlange'],
    ['row object', (s) => ((s['radiusTable'] as unknown[])[0] = 5), 'must be an object'],
    ['row units', (s) => (((s['radiusTable'] as Json[])[0] as Json)['units'] = 'cm'), 'units'],
    ['row numbers', (s) => (((s['radiusTable'] as Json[])[0] as Json)['thickness'] = 0), 'invalid number'],
    ['row text', (s) => (((s['radiusTable'] as Json[])[0] as Json)['temper'] = ''), 'material and temper'],
    ['row verification', (s) => (((s['radiusTable'] as Json[])[0] as Json)['verification'] = 'x'), 'verification'],
    ['part id', (s) => (part(s)['id'] = 'zz'), 'part with id'],
    ['part nodes', (s) => delete part(s)['nodes'], 'nodes and order'],
    ['part rule', (s) => (part(s)['rule'] = 'ghost'), 'existing rule'],
    ['part side', (s) => (part(s)['side'] = 'left'), 'side'],
    ['part root', (s) => (part(s)['root'] = 'b1'), 'root'],
    ['node id', (s) => (nodes(s)['f1']!['id'] = 'f9'), 'must equal its key'],
    ['node shape', (s) => (nodes(s)['f1'] = 3 as unknown as Json), 'with an id'],
    ['flat outline', (s) => (nodes(s)['f1']!['outline'] = [[0, 0]]), 'malformed flat'],
    ['flat frame', (s) => (nodes(s)['f1']!['frame'] = {}), 'malformed flat'],
    ['flat cutouts', (s) => (nodes(s)['f1']!['cutouts'] = [5]), 'malformed flat'],
    ['bend line', (s) => (nodes(s)['b1']!['lineInFrom'] = [[0, 0]]), 'malformed bend'],
    ['bend flats', (s) => (nodes(s)['b1']!['to'] = 'b1'), 'malformed bend'],
    ['joggle angle', (s) => (nodes(s)['j1']!['angle'] = 0), 'malformed joggle'],
    ['relief width', (s) => (nodes(s)['r1']!['width'] = 0), 'malformed relief'],
    ['node type', (s) => (nodes(s)['r1']!['type'] = 'weld'), 'unknown type'],
    ['order', (s) => (part(s)['order'] = ['f1']), 'order'],
  ])('reports %s', (_name, edit, fragment) => {
    const errors = errorsAfter(edit);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' | ')).toContain(fragment);
  });

  it('rejects slices of the wrong shape', () => {
    expect(sheetMetalErrors(3)).toEqual(['sheetMetal must be an object']);
    expect(sheetMetalErrors({ rules: {}, parts: {} })[0]).toContain('needs rules');
    expect(sheetMetalErrors({ rules: { a: 3 }, parts: {}, radiusTable: [] })[0]).toContain('rule named a');
    expect(sheetMetalErrors({ rules: {}, parts: { p: 3 }, radiusTable: [] })[0]).toContain('part with id p');
  });
});

describe('document extension', () => {
  it('validates only when the slice is present', () => {
    expect(sheetMetalDocument.validate({})).toEqual([]);
    expect(sheetMetalDocument.validate({ sheetMetal: 4 })).toHaveLength(1);
  });

  it('restores nothing from an absent, invalid or incomplete slice and skips parts whose rule is gone', () => {
    const raw: Json = { entities: {}, order: [], layers: {} };
    expect(sheetMetalDocument.restore(raw)).toBe(raw);
    const invalid = { ...raw, sheetMetal: 4 };
    expect(sheetMetalDocument.restore(invalid)).toBe(invalid);
    const slice = validSlice();
    expect(sheetMetalDocument.restore({ ...raw, sheetMetal: slice })['entities']).toHaveProperty(String(part(slice)['id']));
    const noEntities = { sheetMetal: slice, order: [] };
    expect(sheetMetalDocument.restore(noEntities)).toBe(noEntities);
    const noRules = { ...raw, sheetMetal: { ...slice, rules: {} } };
    expect(sheetMetalDocument.restore(noRules)).toBe(noRules);
  });

  it('re-derives into the first layer when the default layer is missing', () => {
    const slice = validSlice();
    const restored = sheetMetalDocument.restore({ entities: {}, order: [], layers: { 'layer-x': { id: 'layer-x' } }, sheetMetal: slice });
    const entity = (restored['entities'] as Record<string, Entity>)[String(part(slice)['id'])];
    expect(entity?.layerId).toBe('layer-x');
  });

  it('round-trips through save / load with every node type', () => {
    const { doc } = bracket();
    expect(deserializeDocument(serializeDocument(doc)).sheetMetal).toEqual(doc.sheetMetal);
  });
});
