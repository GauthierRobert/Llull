import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { type BondContext, pairKey, stackPairsOf, systemsOf, untestedOf } from '@cae/electroOptical/bondContext';
import { bondRow } from '@cae/electroOptical/bondEval';
import type { BondPath } from '@cae/electroOptical/types';
import { checkBonding, run, runPlan } from './fixtures';

const SRC = { citation: 'test input (not a property claim)' };
const LIMIT = { value: 2.5, unit: 'mohm', ruleId: 'r', source: SRC };
const joint = (interfaces?: [string, string]): Record<string, unknown> => ({
  kind: 'joint',
  resistance: { value: 0.5, unit: 'mohm' },
  source: SRC,
  ...(interfaces === undefined ? {} : { interfaces }),
});

const base = (): { doc: CadDocument; box: string; structure: string } => {
  const { doc, aliases } = runPlan('eop_bonding_paths.plan.json', 'check_bonding');
  return { doc, box: aliases['box'] ?? '', structure: aliases['structure'] ?? '' };
};

const answer = (data: unknown, rejected = false): CommandResult => ({
  document: {} as CadDocument,
  summary: '',
  affected: [],
  data,
  ...(rejected ? { rejected } : {}),
});

/** A one-joint path whose joint solids are a and b. */
const pathOf = (a: string, b: string): BondPath => ({
  id: 'bp-t.1',
  name: 't',
  from: a,
  to: b,
  elements: [{ kind: 'joint', resistance: { value: 0.5, unit: 'mohm' }, source: SRC, interfaces: [a, b] }],
  limit: { ...LIMIT, unverified: true },
});

const emptyContext = (extra: Partial<BondContext> = {}): BondContext => ({
  contacts: new Set(),
  untested: new Map(),
  stackPairs: new Set(),
  systems: [],
  ...extra,
});

describe('check_bonding: solids find_contacts did not test (never a pass)', () => {
  /** A box and an instance of a second box resting on it; `broken` removes the component so find_contacts skips the instance. */
  function withInstance(broken: boolean): { doc: CadDocument; base: string; instance: string } {
    const lower = execute(base().doc, 'add_box', { size: [10, 10, 10], position: [1000, 0, 0] });
    const upper = execute(lower.document, 'add_box', { size: [10, 10, 10], position: [1000, 0, 10] });
    const component = execute(upper.document, 'create_component', { name: 'Unit', entityIds: [upper.affected[0]] });
    const instance = component.affected.find((id) => component.document.entities[id]?.kind === 'instance') ?? '';
    return { doc: broken ? { ...component.document, components: {} } : component.document, base: lower.affected[0] ?? '', instance };
  }
  const check = (doc: CadDocument, a: string, b: string): ReturnType<typeof checkBonding>['rows'][number] | undefined => {
    const defined = execute(doc, 'define_bond_path', { name: 'inst', from: a, to: b, elements: [joint([a, b])], limit: LIMIT });
    expect(defined.error).toBeUndefined();
    return checkBonding(defined.document, { pathIds: [defined.affected[0] ?? ''] }).rows[0];
  };

  it('an instance resting on a solid is found in contact through its children (the root of `instance/child`) and passes', () => {
    const { doc, base: lower, instance } = withInstance(false);
    expect(check(doc, lower, instance)).toMatchObject({ status: 'pass', code: null });
  });

  it('an instance whose component is gone is EOP_CONTACT_NOT_TESTED with the reason, not EOP_JOINT_NO_CONTACT', () => {
    const { doc, base: lower, instance } = withInstance(true);
    const row = check(doc, lower, instance);
    expect(row).toMatchObject({ status: 'unknown', code: 'EOP_CONTACT_NOT_TESTED' });
    expect(row?.findings.map((finding) => finding.code)).not.toContain('EOP_JOINT_NO_CONTACT');
    expect(row?.findings[0]?.message).toContain('component');
  });
});

describe('bond context readers on hostile answers', () => {
  it('a non-array or missing skipped list makes every contact unconfirmed', () => {
    for (const data of [{ skipped: 'x' }, { skipped: null }, {}, null, 42]) expect(untestedOf(data).get('*')).toContain('unreadable');
  });

  it('a malformed skipped entry (no string id, empty id, non-object) is unconfirmed; a valid one keeps its reason', () => {
    for (const entry of [{ id: 5, reason: 'r' }, { id: '', reason: 'r' }, 'text', null, { reason: 'r' }])
      expect(untestedOf({ skipped: [entry] }).get('*')).toContain('malformed');
    const map = untestedOf({ skipped: [{ id: 'inst/child', reason: 'gone' }, { id: 'other' }] });
    expect([...map.entries()]).toEqual([
      ['inst', 'gone'],
      ['other', 'no reason given'],
    ]);
  });

  it('an unconfirmed skipped list stops a joint from passing', () => {
    const row = bondRow(
      { ...base().doc },
      pathOf('a', 'b'),
      emptyContext({ untested: new Map([['*', 'unreadable']]), contacts: new Set([pairKey('a', 'b')]) }),
      undefined,
    );
    expect(row.findings.map((finding) => finding.code)).toContain('EOP_CONTACT_NOT_TESTED');
  });

  it('stack answers: consecutive layers make evidence; malformed or rejected answers make none', () => {
    const stacks = [
      { layers: [{ entityId: 'a' }, { entityId: 'b' }, { entityId: 'c' }] },
      { layers: [{ entityId: 'd' }, { entityId: 7 }, { entityId: 'e' }] },
      { layers: 'x' },
      null,
    ];
    expect([...stackPairsOf(answer({ stacks }))].sort()).toEqual([pairKey('a', 'b'), pairKey('b', 'c')].sort());
    expect(stackPairsOf(answer({ stacks: 'x' })).size).toBe(0);
    expect(stackPairsOf(answer(undefined)).size).toBe(0);
    expect(stackPairsOf(answer({ stacks }, true)).size).toBe(0);
  });

  it('surface-system answers: malformed entries are dropped, layer classes read defensively', () => {
    const systems = systemsOf(
      answer({
        systems: [
          { id: 's1', entityIds: ['a', 5], layers: [{ class: 'anodize' }, { nope: 1 }] },
          { id: 5, entityIds: [], layers: [] },
          { id: 's3', entityIds: 'x', layers: [] },
          'text',
        ],
      }),
    );
    expect(systems).toEqual([{ id: 's1', entityIds: ['a'], layers: ['anodize', 'unreadable'] }]);
    expect(systemsOf(answer({ systems: 3 }))).toEqual([]);
    expect(systemsOf(answer(undefined, true))).toEqual([]);
  });
});

describe('check_bonding: other evidence', () => {
  it('a joint whose solids touch only by construction in a fastener stack is evidenced; without the stack it is not', () => {
    const { doc, box, structure } = base();
    const path = pathOf(box, structure);
    const stacked = bondRow(doc, path, emptyContext({ stackPairs: new Set([pairKey(box, structure)]) }), undefined);
    const alone = bondRow(doc, path, emptyContext(), undefined);
    expect(stacked.status).toBe('pass');
    expect(alone).toMatchObject({ status: 'unknown', code: 'EOP_JOINT_NO_CONTACT' });
  });

  it('a joint that names no solids is flagged unchecked in unverifiedReasons', () => {
    const { doc, box, structure } = base();
    const defined = execute(doc, 'define_bond_path', {
      name: 'bare',
      from: box,
      to: structure,
      elements: [joint(), joint([box, structure])],
      limit: LIMIT,
    });
    const row = checkBonding(defined.document, { pathIds: [defined.affected[0] ?? ''] }).rows[0];
    expect(row?.unverifiedReasons.filter((reason) => reason.startsWith('EOP_JOINT_UNCHECKED'))).toEqual([
      'EOP_JOINT_UNCHECKED: joint 0 names no solids, so its contact and coating are not checked',
    ]);
    expect(row?.unverified).toBe(true);
  });

  it('a composite strap warns EOP_CFRP_IN_PATH without changing the status; a metallic one does not', () => {
    const { doc, box, structure } = base();
    const model = {
      id: 'rho',
      property: 'electricalResistivity',
      unit: 'ohm*m',
      variables: [],
      form: { kind: 'constant', value: 1e-5 },
      validity: [],
      basis: 'company',
      source: SRC,
      preferred: true,
    };
    let next = run(doc, 'define_material_record', {
      id: 'cfrp_ud',
      designation: 'T700 UD',
      productForm: 'laminate',
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    });
    next = run(next, 'define_property_model', { material: 'cfrp_ud', model });
    const strap = { kind: 'strap', material: 'cfrp_ud', length: { value: 10, unit: 'mm' }, crossSection: { value: 100, unit: 'mm^2' } };
    const defined = execute(next, 'define_bond_path', { name: 'c', from: box, to: structure, elements: [strap], limit: LIMIT });
    const row = checkBonding(defined.document, { pathIds: [defined.affected[0] ?? ''] }).rows[0];
    expect(row?.warnings.map((warning) => warning.code)).toEqual(['EOP_CFRP_IN_PATH']);
    expect(row?.status).toBe('pass');
    const metallic = checkBonding(doc).rows.flatMap((item) => item.warnings);
    expect(metallic).toEqual([]);
  });
});

describe('list_surface_systems (PHY-13 read-only listing)', () => {
  it('lists the systems sorted, filters by solid and is pure', () => {
    const { doc, box, structure } = base();
    const once = run(doc, 'assign_surface_system', { entityIds: [box], layers: [{ class: 'anodize', spec: 'MIL-A-8625' }] });
    const twice = run(once, 'assign_surface_system', { entityIds: [structure], layers: [{ class: 'paint' }] });
    const before = structuredClone(twice);
    const all = execute(twice, 'list_surface_systems', {});
    const data = all.data as { systems: { entityIds: string[]; layers: { class: string }[] }[]; count: number };
    expect(data.count).toBe(2);
    expect(data.systems.map((system) => system.entityIds[0])).toEqual([box, structure].sort());
    const filtered = execute(twice, 'list_surface_systems', { entityId: box }).data as typeof data;
    expect(filtered.systems.map((system) => system.layers[0]?.class)).toEqual(['anodize']);
    expect(all.document).toBe(twice);
    expect(all.affected).toEqual([]);
    expect(twice).toEqual(before);
  });

  it('a document without corrosion data answers an empty list and does not crash', () => {
    const { doc } = base();
    const { corrosion: _corrosion, ...bare } = doc;
    const result = execute(bare as CadDocument, 'list_surface_systems', {});
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ systems: [], count: 0 });
    expect(execute(bare as CadDocument, 'list_surface_systems', { entityId: 'nope' }).error).toBeUndefined();
  });
});
