import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { coreEntityProperties, entityPropertyBag } from '@core/geometry/entityProperties';
import { compileProfile, predicateProblem, profileProblems, referencedProperties } from '@core/geometry/colourRules';
import { validateDocumentValues } from '@core/commands/persistence/validation';
import type { ColourProfile } from '@core/model/display';
import { apply, data, expectRefusal, ok } from '../../helpers/commandAssertions';

const rule = (id: string, when: Record<string, unknown>, colour: string): Record<string, unknown> => ({ id, when, colour, legend: id });

/** Three boxes: a red tagged one, a blue one, an untagged one (tags/name are core properties). */
function scene(): CadDocument {
  let doc = createEmptyDocument();
  for (const [name, tags] of [
    ['alpha', ['hot', 'steel']],
    ['beta', ['cold']],
    ['gamma', []],
  ] as const) {
    const added = ok(doc, 'add_box', { size: [10, 10, 10] });
    doc = added.document;
    const id = added.affected[0] as string;
    doc = apply(doc, 'set_entity_name', { id, name, tags: [...tags] });
  }
  return doc;
}

const profileParams = (): Record<string, unknown> => ({
  id: 'p1',
  name: 'Test',
  rules: [
    rule('first', { property: 'name', in: ['alpha', 'beta'] }, '#ff0000'),
    rule('second', { property: 'name', equals: 'ALPHA' }, '#00ff00'),
    rule('re', { property: 'name', matches: '^gam' }, '#0000FF'),
  ],
});

describe('define_colour_profile', () => {
  it('stores an ordered profile, lower-cases colours, adds no feature step and leaves geometry alone', () => {
    const doc = scene();
    const result = ok(doc, 'define_colour_profile', profileParams());
    expect(result.affected).toEqual([]);
    expect(result.data).toEqual({ profileId: 'p1', ruleCount: 3 });
    const profile = result.document.display?.colourProfiles['p1'];
    expect(profile?.rules.map((r) => r.id)).toEqual(['first', 'second', 're']);
    expect(profile?.rules[2]?.appearance.colour).toBe('#0000ff');
    expect(profile).toMatchObject({ defaultColour: 'entity', palette: 'custom', reviewRequired: false });
    expect(result.document.entities).toBe(doc.entities);
    expect(result.document.featureHistory).toEqual(doc.featureHistory);
  });

  it('is pure', () => {
    const doc = scene();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'define_colour_profile', profileParams());
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('keeps range, any and optional appearance fields', () => {
    const result = ok(scene(), 'define_colour_profile', {
      id: 'q',
      name: 'Q',
      defaultColour: '#AAAAAA',
      palette: 'mine',
      reviewRequired: true,
      rules: [
        {
          id: 'r',
          when: { property: 'dn', range: [50, 100], any: [{ property: 'service', equals: 'x' }] },
          colour: '#112233',
          transparency: 0.5,
          hidden: true,
          legend: 'L',
        },
      ],
    });
    expect(result.document.display?.colourProfiles['q']).toMatchObject({
      defaultColour: '#aaaaaa',
      palette: 'mine',
      reviewRequired: true,
      rules: [
        {
          when: { property: 'dn', range: [50, 100], any: [{ property: 'service', equals: 'x' }] },
          appearance: { transparency: 0.5, hidden: true },
        },
      ],
    });
  });

  it('refuses an existing id without replace, and replaces with replace: true', () => {
    const doc = apply(scene(), 'define_colour_profile', profileParams());
    expectRefusal(doc, 'define_colour_profile', profileParams(), 'VIS_PROFILE_EXISTS', 'id');
    const replaced = ok(doc, 'define_colour_profile', { ...profileParams(), name: 'Renamed', replace: true });
    expect(replaced.document.display?.colourProfiles['p1']?.name).toBe('Renamed');
  });

  it('refuses bad rules and colours with stable codes and paths', () => {
    const doc = scene();
    const with1 = (r: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown => ({
      ...profileParams(),
      rules: [r],
      ...extra,
    });
    expectRefusal(doc, 'define_colour_profile', with1(rule('a', { property: 'name' }, '#ffffff')), 'VIS_RULE_INVALID', 'rules.0.when');
    expectRefusal(doc, 'define_colour_profile', with1(rule('a', { equals: 'x' }, '#ffffff')), 'VIS_RULE_INVALID', 'rules.0.when');
    expectRefusal(doc, 'define_colour_profile', with1(rule('a', { property: 'dn', range: [9, 1] }, '#ffffff')), 'VIS_RULE_INVALID');
    expectRefusal(doc, 'define_colour_profile', with1(rule('a', { property: 'n', matches: '(' }, '#ffffff')), 'VIS_RULE_INVALID');
    expectRefusal(doc, 'define_colour_profile', with1(rule('a', { property: 'n', matches: '(a)\\1' }, '#ffffff')), 'VIS_RULE_INVALID');
    expectRefusal(doc, 'define_colour_profile', with1(rule('a', { property: 'n', matches: '(a+)+$' }, '#ffffff')), 'VIS_RULE_INVALID');
    expectRefusal(
      doc,
      'define_colour_profile',
      with1(rule('a', { property: 'n', matches: 'x'.repeat(201) }, '#ffffff')),
      'VIS_RULE_INVALID',
    );
    expectRefusal(doc, 'define_colour_profile', with1(rule('a', { property: 'n', in: [] }, '#ffffff')), 'VIS_RULE_INVALID');
    expectRefusal(doc, 'define_colour_profile', with1(rule('a', { any: [] }, '#ffffff')), 'VIS_RULE_INVALID');
    expectRefusal(
      doc,
      'define_colour_profile',
      with1(rule('a', { property: 'n', equals: 1 }, 'red')),
      'VIS_COLOUR_INVALID',
      'rules.0.appearance.colour',
    );
    expectRefusal(
      doc,
      'define_colour_profile',
      with1(rule('a', { property: 'n', equals: 1 }, '#ffffff'), { defaultColour: 'blue' }),
      'VIS_COLOUR_INVALID',
      'defaultColour',
    );
    expectRefusal(
      doc,
      'define_colour_profile',
      {
        ...profileParams(),
        rules: [rule('a', { property: 'n', equals: 1 }, '#ffffff'), rule('a', { property: 'n', equals: 2 }, '#ffffff')],
      },
      'VIS_RULE_INVALID',
      'rules.1.id',
    );
    expectRefusal(
      doc,
      'define_colour_profile',
      with1(rule('a', { property: 'n', equals: 1 }, '#ffffff'), { id: '' }),
      'VIS_RULE_INVALID',
      'id',
    );
    expectRefusal(
      doc,
      'define_colour_profile',
      with1(rule('a', { property: 'n', equals: 1 }, '#ffffff'), { id: 'constructor' }),
      'CMD_RESERVED_ID',
    );
    expect(
      execute(doc, 'define_colour_profile', with1({ ...rule('a', { property: 'n', equals: 1 }, '#ffffff'), transparency: 2 })).error?.code,
    ).toBe('VIS_RULE_INVALID');
  });
});

describe('set_active_colour_profile / delete_colour_profile', () => {
  it('activates, deactivates and deletes (clearing the active id)', () => {
    const doc = apply(scene(), 'define_colour_profile', profileParams());
    const active = ok(doc, 'set_active_colour_profile', { profileId: 'p1' });
    expect(active.document.display?.activeProfileId).toBe('p1');
    expect(active.data).toEqual({ active: 'p1' });
    const off = ok(active.document, 'set_active_colour_profile', { profileId: null });
    expect(off.document.display?.activeProfileId).toBeUndefined();
    const deleted = ok(active.document, 'delete_colour_profile', { profileId: 'p1' });
    expect(deleted.document.display).toEqual({ colourProfiles: {} });
    const other = apply(apply(doc, 'define_colour_profile', { ...profileParams(), id: 'p2' }), 'set_active_colour_profile', {
      profileId: 'p2',
    });
    expect(ok(other, 'delete_colour_profile', { profileId: 'p1' }).document.display?.activeProfileId).toBe('p2');
  });

  it('refuses unknown profiles', () => {
    const doc = scene();
    expectRefusal(doc, 'set_active_colour_profile', { profileId: 'nope' }, 'VIS_PROFILE_NOT_FOUND');
    expectRefusal(doc, 'delete_colour_profile', { profileId: 'nope' }, 'VIS_PROFILE_NOT_FOUND');
    expect(execute(doc, 'set_active_colour_profile', { profileId: null }).document.display).toEqual({ colourProfiles: {} });
  });

  it('profiles survive replay_history and are dropped by clear_document', () => {
    const doc = apply(apply(scene(), 'define_colour_profile', profileParams()), 'set_active_colour_profile', { profileId: 'p1' });
    expect(execute(doc, 'replay_history', {}).document.display).toEqual(doc.display);
    expect(execute(doc, 'clear_document', {}).document.display).toBeUndefined();
  });
});

describe('persistence of display', () => {
  const raw = (display: unknown): Record<string, unknown> => ({ ...JSON.parse(JSON.stringify(createEmptyDocument())), display });
  const profile = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'p',
    name: 'P',
    palette: 'x',
    reviewRequired: false,
    defaultColour: 'entity',
    rules: [{ id: 'r', legend: 'l', when: { property: 'a', equals: 1 }, appearance: { colour: '#ffffff' } }],
    ...patch,
  });

  it('accepts a saved display and an absent one', () => {
    expect(validateDocumentValues(raw(undefined))).toEqual([]);
    expect(validateDocumentValues(raw({ colourProfiles: { p: profile() }, activeProfileId: 'p' }))).toEqual([]);
    const doc = apply(scene(), 'define_colour_profile', profileParams());
    expect(validateDocumentValues(JSON.parse(JSON.stringify(doc)))).toEqual([]);
  });

  it('rejects malformed display data', () => {
    const problems = (display: unknown): string[] => validateDocumentValues(raw(display));
    expect(problems(3)[0]).toContain('display must be');
    expect(problems({ colourProfiles: { p: profile() }, activeProfileId: 'zz' })[0]).toContain('activeProfileId');
    expect(problems({ colourProfiles: { q: profile() } })[0]).toContain('whose id is');
    expect(problems({ colourProfiles: { __proto__x: 1, constructor: profile({ id: 'constructor' }) } }).join()).toContain('reserved');
    expect(problems({ colourProfiles: { p: profile({ palette: 3 }) } })[0]).toContain('palette');
    expect(problems({ colourProfiles: { p: profile({ defaultColour: 3 }) } })[0]).toContain('defaultColour');
    expect(problems({ colourProfiles: { p: profile({ rules: [{ id: 1 }] }) } })[0]).toContain('rules must be');
    expect(
      problems({
        colourProfiles: { p: profile({ rules: [{ id: 'r', legend: 'l', when: { property: 'a' }, appearance: { colour: '#ffffff' } }] }) },
      })[0],
    ).toContain('rules.0.when');
  });
});

describe('geometry/colourRules', () => {
  const make = (rules: ColourProfile['rules']): ColourProfile => ({
    id: 'p',
    name: 'p',
    rules,
    defaultColour: 'entity',
    palette: 'x',
    reviewRequired: false,
  });
  const r = (id: string, when: ColourProfile['rules'][number]['when']): ColourProfile['rules'][number] => ({
    id,
    when,
    appearance: { colour: '#000000' },
    legend: id,
  });

  it('matches equals case-insensitively for strings and exactly for numbers/booleans, in, regex, range and any', () => {
    const select = (when: ColourProfile['rules'][number]['when'], bag: Record<string, string | number | boolean | string[]>): boolean =>
      compileProfile(make([r('x', when)])).select(bag) !== null;
    expect(select({ property: 'a', equals: 'Water' }, { a: 'water' })).toBe(true);
    expect(select({ property: 'a', equals: 100 }, { a: '100' })).toBe(false);
    expect(select({ property: 'a', equals: true }, { a: true })).toBe(true);
    expect(select({ property: 'a', in: ['x', 'Y'] }, { a: 'y' })).toBe(true);
    expect(select({ property: 'a', matches: '^pu?mp' }, { a: 'PUMP-1' })).toBe(true);
    expect(select({ property: 'a', range: [10, 20] }, { a: 20 })).toBe(true);
    expect(select({ property: 'a', range: [10, 20] }, { a: '15' })).toBe(false);
    expect(select({ property: 'a', range: [10, 20] }, { a: 21 })).toBe(false);
    expect(
      select(
        {
          any: [
            { property: 'a', equals: 1 },
            { property: 'b', equals: 2 },
          ],
        },
        { b: 2 },
      ),
    ).toBe(true);
    expect(select({ property: 'a', equals: 1, any: [{ property: 'b', equals: 2 }] }, { b: 2 })).toBe(false);
    expect(select({ property: 'a', equals: 'hot' }, { a: ['cold', 'hot'] })).toBe(true);
    expect(select({ property: 'missing', equals: 'x' }, {})).toBe(false);
    expect(select({ property: 'toString', equals: 'x' }, {})).toBe(false);
  });

  it('first match wins and reports referenced properties', () => {
    const profile = make([
      r('a', { property: 'k', equals: 1 }),
      r('b', {
        any: [
          { property: 'k', equals: 1 },
          { property: 'j', equals: 2 },
        ],
      }),
    ]);
    expect(compileProfile(profile).select({ k: 1 })?.id).toBe('a');
    expect(compileProfile(profile).select({ j: 2 })?.id).toBe('b');
    expect([...referencedProperties(profile)].sort()).toEqual(['j', 'k']);
    expect(profileProblems(profile)).toEqual([]);
  });

  it('limits predicate nesting depth', () => {
    let nested = { property: 'a', equals: 1 } as ColourProfile['rules'][number]['when'];
    for (let i = 0; i < 6; i++) nested = { any: [nested] };
    expect(predicateProblem(nested)).toContain('nest deeper');
  });

  it('core properties: tags are multi-valued, providers cannot override core keys, unknown ids are empty', () => {
    const doc = scene();
    const id = doc.order[0] as string;
    const core = coreEntityProperties(doc, id);
    expect(core).toMatchObject({ id, kind: 'box', is2D: false, name: 'alpha' });
    expect(entityPropertyBag(doc, id, [() => ({ kind: 'fake', extra: 1 })])).toMatchObject({ kind: 'box', extra: 1 });
    expect(entityPropertyBag(doc, id, [() => ({ x: 1 }), () => ({ x: 2, y: 3 })])).toMatchObject({ x: 1, y: 3 });
    expect(coreEntityProperties(doc, 'nope')).toEqual({});
    expect(entityPropertyBag(doc, 'nope', [() => ({ x: 1 })])).toEqual({});
    const profile = make([r('t', { property: 'tag', equals: 'steel' })]);
    expect(compileProfile(profile).select(coreEntityProperties(doc, id))?.id).toBe('t');
  });
});

describe('VC-VIS-03 first-match order, unmatched reporting, geometry invariance', () => {
  it('the earlier rule wins, unmatched entities are reported, and switching profiles changes no geometry', () => {
    const base = apply(scene(), 'define_colour_profile', profileParams());
    const before = JSON.stringify(base.entities);
    const activated = apply(base, 'set_active_colour_profile', { profileId: 'p1' });
    const report = data<{
      groups: Record<string, { ruleId: string | null; count: number; displayHex: string | null }>;
      unmatched: string[];
      legend: Array<{ ruleId: string; count: number }>;
    }>(activated, 'colour_by_rule_report', { groupBy: 'rule' });
    expect(report.groups['first']).toMatchObject({ count: 2, displayHex: '#ff0000' });
    expect(report.groups['second']).toBeUndefined();
    expect(report.groups['re']).toMatchObject({ count: 1, displayHex: '#0000ff' });
    expect(report.legend.map((l) => [l.ruleId, l.count])).toEqual([
      ['first', 2],
      ['second', 0],
      ['re', 1],
    ]);
    expect(report.unmatched).toEqual([]);
    expect(JSON.stringify(activated.entities)).toBe(before);
  });
});
