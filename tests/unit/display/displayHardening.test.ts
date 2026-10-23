import { describe, expect, it } from 'vitest';
import { execute, getCommand } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { findProfile, type ColourProfile } from '@core/model/display';
import { profileProblems, storeProfile } from '@core/geometry/colourRules';
import { coreEntityProperties } from '@core/geometry/entityProperties';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import { apply, data, expectRefusal } from '../../helpers/commandAssertions';

const profile = (patch: Partial<ColourProfile> = {}): ColourProfile => ({
  id: 'p',
  name: 'P',
  palette: 'x',
  reviewRequired: false,
  defaultColour: 'entity',
  rules: [{ id: 'r', legend: 'l', when: { property: 'kind', equals: 'box' }, appearance: { colour: '#ff0000' } }],
  ...patch,
});

const boxes = (): CadDocument => {
  let doc = createEmptyDocument();
  for (let i = 0; i < 3; i++) doc = apply(doc, 'add_box', { size: [1, 1, 1] });
  return doc;
};

const withProfile = (doc: CadDocument): CadDocument =>
  apply(doc, 'define_colour_profile', {
    id: 'p',
    name: 'P',
    rules: [{ id: 'r', when: { property: 'kind', equals: 'box' }, colour: '#ff0000', legend: 'l' }],
  });

describe('reserved and prototype profile ids', () => {
  it('prototype names are not profiles', () => {
    const doc = withProfile(boxes());
    const display = doc.display ?? { colourProfiles: {} };
    expect(findProfile(display, 'toString')).toBeUndefined();
    expect(findProfile(display, 'p')?.id).toBe('p');
    for (const name of ['set_active_colour_profile', 'delete_colour_profile']) {
      const result = execute(doc, name, { profileId: 'toString' });
      expect(result.rejected, name).toBe(true);
      expect(result.document).toBe(doc);
    }
    expect(execute(doc, 'colour_by_rule_report', { profileId: 'toString' }).rejected).toBe(true);
    const dangling: CadDocument = { ...doc, display: { colourProfiles: {}, activeProfileId: 'toString' } };
    expect(data<{ status: string }>(dangling, 'check_display', {}).status).toBe('fail');
    expect(execute(doc, 'define_colour_profile', { id: 'constructor', name: 'x', rules: [] }).rejected).toBe(true);
  });

  it('storeProfile is the one writer: it refuses empty / reserved ids and invalid rules, and activates on request', () => {
    const empty = { colourProfiles: {} };
    expect(storeProfile(empty, profile({ id: '' }), false)).toMatchObject({ code: 'VIS_RULE_INVALID', path: 'id' });
    expect(storeProfile(empty, profile({ id: 'toString' }), true)).toMatchObject({ code: 'VIS_RULE_INVALID', path: 'id' });
    expect(storeProfile(empty, profile({ defaultColour: 'blue' }), false)).toMatchObject({ code: 'VIS_COLOUR_INVALID' });
    const stored = storeProfile(empty, profile(), false);
    expect(stored).toEqual({ colourProfiles: { p: profile() } });
    expect(storeProfile(stored as typeof empty, profile({ id: 'q' }), true)).toMatchObject({ activeProfileId: 'q' });
  });
});

describe('purity of set_active_colour_profile and delete_colour_profile', () => {
  it('is pure', () => {
    const active = apply(withProfile(boxes()), 'set_active_colour_profile', { profileId: 'p' });
    const snapshot = JSON.stringify(active);
    execute(active, 'set_active_colour_profile', { profileId: null });
    execute(active, 'delete_colour_profile', { profileId: 'p' });
    expect(JSON.stringify(active)).toBe(snapshot);
  });
});

describe('load validation of malformed display data never throws', () => {
  const rule = (patch: Record<string, unknown>): Record<string, unknown> => ({
    id: 'r',
    legend: 'l',
    when: { property: 'a', equals: 1 },
    appearance: { colour: '#ffffff' },
    ...patch,
  });
  const load = (rules: unknown[]): string[] =>
    validateDocumentValues({
      ...JSON.parse(JSON.stringify(createEmptyDocument())),
      display: { colourProfiles: { p: { id: 'p', name: 'P', palette: 'x', reviewRequired: false, defaultColour: 'entity', rules } } },
    });

  it('accepts a well-formed rule', () => {
    expect(load([rule({})])).toEqual([]);
    const scheme = { id: 's', rowId: 'r', category: 'c', names: { a: 'b' } };
    expect(load([rule({ scheme, when: { any: [{ property: 'a', in: [1, 'x'] }] } })])).toEqual([]);
  });

  const deep = JSON.parse('{"any":['.repeat(8) + '{"property":"a","equals":1}' + ']}'.repeat(8)) as unknown;

  it.each([
    ['matches not a string', { when: { property: 'a', matches: 5 } }],
    ['any not an array', { when: { any: 5 } }],
    ['range null', { when: { property: 'a', range: null } }],
    ['range wrong length', { when: { property: 'a', range: [1] } }],
    ['in not an array', { when: { property: 'a', in: 'x' } }],
    ['in with an object', { when: { property: 'a', in: [{}] } }],
    ['equals an object', { when: { property: 'a', equals: {} } }],
    ['property a number', { when: { property: 3, equals: 1 } }],
    ['nested any malformed', { when: { any: [{ property: 'a', matches: 5 }] } }],
    ['too deep', { when: deep }],
    ['when not a record', { when: 'x' }],
    ['scheme not a record', { scheme: 3 }],
    ['scheme names not strings', { scheme: { id: 's', rowId: 'r', category: 'c', names: { a: 1 } } }],
    ['transparency a string', { appearance: { colour: '#ffffff', transparency: 'x' } }],
    ['hidden a string', { appearance: { colour: '#ffffff', hidden: 'x' } }],
  ])('%s is reported as a problem', (_label, patch) => {
    const problems = load([rule(patch)]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain("display.colourProfiles['p']");
  });
});

describe('regex guard', () => {
  const problem = (matches: string): string | undefined =>
    profileProblems({
      defaultColour: 'entity',
      rules: [{ id: 'r', legend: 'l', when: { property: 'a', matches }, appearance: { colour: '#ffffff' } }],
    })[0]?.message;

  it.each(['(a+)+', '((a+))+', '(a|aa)+', '(a{2,})+', '(a*)*b', '(x(y|z)w)*', '(?:a+)+'])('rejects %s', (source) => {
    expect(problem(source)).toContain('repeated group');
  });

  it.each(['^pu?mp', '(ab)+', '(a|b)', '[(+]+', '\\(a+\\)+', '(a+)', 'P-[0-9]+', '(ab)?c+'])('allows %s', (source) => {
    expect(problem(source)).toBeUndefined();
  });
});

describe('colour_by_rule_report grouping', () => {
  const scene = (): CadDocument => {
    const doc = apply(boxes(), 'define_colour_profile', {
      id: 'p',
      name: 'P',
      rules: [
        { id: 'a', when: { property: 'kind', equals: 'box' }, colour: '#ff0000', legend: 'boxes' },
        { id: 'b', when: { property: 'kind', equals: 'sphere' }, colour: '#00ff00', legend: 'spheres' },
      ],
    });
    return apply(doc, 'set_active_colour_profile', { profileId: 'p' });
  };

  it('defaults to rule groups; groups by entity; by a property value; limits groups', () => {
    const doc = scene();
    const byRule = data<{ groupBy: string; groups: Record<string, { count: number }> }>(doc, 'colour_by_rule_report', {});
    expect(byRule.groupBy).toBe('rule');
    expect(Object.keys(byRule.groups)).toEqual(['a']);
    expect(byRule.groups['a']?.count).toBe(3);
    const byEntity = data<{ groups: Record<string, unknown>; groupCount: number }>(doc, 'colour_by_rule_report', {
      groupBy: 'entity',
      limit: 2,
    });
    expect(Object.keys(byEntity.groups)).toHaveLength(2);
    expect(byEntity.groupCount).toBe(3);
    const byLayer = data<{ groups: Record<string, { count: number }> }>(doc, 'colour_by_rule_report', {
      groupBy: 'property',
      groupProperty: 'layerName',
    });
    expect(Object.values(byLayer.groups).reduce((sum, group) => sum + group.count, 0)).toBe(3);
    const none = data<{ groups: Record<string, unknown> }>(doc, 'colour_by_rule_report', { groupBy: 'property', groupProperty: 'nothing' });
    expect(Object.keys(none.groups)).toEqual(['(none)']);
  });

  it('needs groupProperty for groupBy property', () => {
    expectRefusal(scene(), 'colour_by_rule_report', { groupBy: 'property' }, 'VIS_GROUP_PROPERTY_MISSING', 'groupProperty');
  });

  it('scheme names cannot overwrite the report fields', () => {
    const doc = scene();
    const display = doc.display;
    const source = display?.colourProfiles['p'];
    const rule = source?.rules[0];
    if (display === undefined || source === undefined || rule === undefined) throw new Error('fixture');
    const names = { ruleId: 'fake', category: 'fake', count: 'fake' };
    const hostile: CadDocument = {
      ...doc,
      display: {
        ...display,
        colourProfiles: { p: { ...source, rules: [{ ...rule, scheme: { id: 's', rowId: 'x', category: 'real', names } }] } },
      },
    };
    const report = data<{ groups: Record<string, Record<string, unknown>>; legend: Array<Record<string, unknown>> }>(
      hostile,
      'colour_by_rule_report',
      {},
    );
    expect(report.groups['a']).toMatchObject({ ruleId: 'a', category: 'real', count: 3 });
    expect(report.legend[0]).toMatchObject({ ruleId: 'a', category: 'real', count: 3 });
  });
});

describe('without a context, and core keys', () => {
  it('check_display and the report read core properties when no ctx reader is given', () => {
    const doc = apply(boxes(), 'define_colour_profile', {
      id: 'p',
      name: 'P',
      rules: [{ id: 'a', when: { property: 'kind', equals: 'sphere' }, colour: '#ff0000', legend: 'spheres' }],
    });
    const active = apply(doc, 'set_active_colour_profile', { profileId: 'p' });
    const run = (name: string): { data?: unknown } | undefined => getCommand(name)?.run(active, {}, undefined);
    expect((run('check_display')?.data as { status: string }).status).toBe('warn');
    expect((run('colour_by_rule_report')?.data as { unmatched: string[] }).unmatched).toHaveLength(3);
  });

  it('check_display without an active profile reports only rule-property problems', () => {
    const doc = withProfile(boxes());
    expect(data<{ status: string; issues: unknown[] }>(doc, 'check_display', {})).toMatchObject({ status: 'pass', issues: [] });
  });

  it('core keys: material, component, layer id and name (no layer name for an unknown layer)', () => {
    const doc = boxes();
    const id = doc.order[0] as string;
    const entity = doc.entities[id];
    if (entity === undefined) throw new Error('fixture');
    const tweaked: CadDocument = {
      ...doc,
      entities: { ...doc.entities, [id]: { ...entity, materialId: 'steel', layerId: 'ghost', componentId: 'comp-1' } as typeof entity },
    };
    const bag = coreEntityProperties(tweaked, id);
    expect(bag).toMatchObject({ materialId: 'steel', layerId: 'ghost', componentId: 'comp-1' });
    expect('layerName' in bag).toBe(false);
    expect(coreEntityProperties(doc, id)).toHaveProperty('layerName');
  });
});
