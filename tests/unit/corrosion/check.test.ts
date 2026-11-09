import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { stackContacts } from '@cae/corrosion/stacks';
import { check, expected, pair, run, withEnvironment } from './fixtures';

const ENVIRONMENTS = ['harsh', 'normal', 'controlled'] as const;

describe('check_material_compatibility: anodic screening (VC-COR-02)', () => {
  const rows = Object.entries(expected.anodicScreening).flatMap(([couple, row]) =>
    ENVIRONMENTS.map((environment) => [couple, environment, row] as const),
  );

  it.each(rows)('%s in %s matches the generated oracle', (couple, environment, row) => {
    const [first, second] = couple.split('|') as [string, string];
    const { doc, plate, block } = pair([first, second]);
    const item = check(withEnvironment(doc, environment)).items[0];
    expect(item?.ids).toEqual([plate, block]);
    expect(item?.inputs.differenceV).toBeCloseTo(row.differenceV, 12);
    const anodeId = row.anode === first ? plate : block;
    if (row.differenceV !== 0) expect(item?.inputs.anode).toBe(anodeId);
    if (row.verdict[environment] === 'incompatible') {
      expect(item?.status).toBe('fail');
      expect(item?.code).toBe('COR_GALVANIC_INCOMPATIBLE');
    } else {
      expect(['pass', 'warn']).toContain(item?.status);
      expect(item?.code).not.toBe('COR_GALVANIC_INCOMPATIBLE');
    }
    expect(item?.warnings).toContain('COR_SCREENING_RULE_ONLY');
  });

  it('a tie at the limit is compatible (VC-COR-14: override 0.80 V against cadmium plate 0.95 V in harsh)', () => {
    const { doc, block } = pair(['aluminium_wrought_other', null]);
    let next = run(doc, 'set_galvanic_group', {
      material: 'm_plate',
      galvanicGroup: 'aluminium_wrought_other',
      anodicIndexV: 0.8,
      source: { citation: 'test override' },
    });
    next = run(next, 'assign_surface_system', {
      entityIds: [block],
      layers: [{ class: 'metallic_plating', galvanicGroup: 'cadmium_plate' }],
    });
    const item = check(withEnvironment(next, 'harsh')).items[0];
    expect(item?.inputs.differenceV).toBe(0.15);
    expect(item?.code).not.toBe('COR_GALVANIC_INCOMPATIBLE');
    expect(item?.inputs.parts).toMatchObject([
      { indexFrom: 'material_override', anodicIndexV: 0.8 },
      { indexFrom: 'table', group: 'cadmium_plate' },
    ]);
  });
});

describe('check_material_compatibility: area ratio, plating, CFRP, isolation', () => {
  it('VC-COR-03 / VC-COR-13: a Cd-plated block on the 7075 plate uses the plating group, Aa/Ac = 4500/13000, COR_SMALL_ANODE', () => {
    const { doc, block } = pair(['aluminium_wrought_other', 'aluminium_wrought_other']);
    const plated = run(doc, 'assign_surface_system', {
      entityIds: [block],
      layers: [{ class: 'metallic_plating', galvanicGroup: 'cadmium_plate', spec: 'QQ-P-416' }],
    });
    const item = check(withEnvironment(plated, 'normal')).items[0];
    expect(item?.inputs.parts).toMatchObject([
      { group: 'aluminium_wrought_other' },
      { group: 'cadmium_plate', groupFrom: 'surface_system' },
    ]);
    expect(item?.inputs.anodeAreaMm2).toBeCloseTo(4500, 9);
    expect(item?.inputs.cathodeAreaMm2).toBeCloseTo(13000, 9);
    expect(item?.inputs.areaRatio).toBeCloseTo(0.346153846154, 9);
    expect(item).toMatchObject({ status: 'warn', code: 'COR_SMALL_ANODE', ruleId: 'COR-R-03' });
    expect(item?.remedies.length).toBeGreaterThan(0);
  });

  it('a larger anode is a pass with the ratio reported', () => {
    const { doc } = pair(['aluminium_wrought_other', 'aluminium_wrought_2000']);
    const item = check(withEnvironment(doc, 'controlled')).items[0];
    expect(item).toMatchObject({ status: 'pass', code: 'COR_GALVANIC_OK' });
    expect(item?.inputs.areaRatio).toBeCloseTo(13000 / 4500, 9);
  });

  it('VC-COR-07 / 08: CFRP on aluminium fails, a declared glass ply makes it pass_isolated, still reviewRequired', () => {
    const { doc, plate, block } = pair(['aluminium_wrought_other', 'graphite']);
    const env = withEnvironment(doc, 'controlled');
    expect(check(env).items[0]).toMatchObject({ status: 'fail', code: 'COR_CFRP_ALUMINIUM', ruleId: 'COR-R-04' });
    const isolated = run(env, 'declare_isolation', { pair: [block, plate], method: 'glass_isolation_ply' });
    const after = check(isolated);
    expect(after.items[0]).toMatchObject({ status: 'pass_isolated', code: 'COR_CFRP_ALUMINIUM', reviewRequired: true });
    expect(after.items[0]?.inputs.isolations).toMatchObject([{ method: 'glass_isolation_ply' }]);
    expect(after.status).toBe('pass_isolated');
    const removed = run(isolated, 'remove_isolation', { id: Object.keys(isolated.corrosion?.isolations ?? {})[0] });
    expect(check(removed).status).toBe('fail');
  });

  it('an isolation on one part covers its contacts; one on another pair does not', () => {
    const { doc, plate } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const env = withEnvironment(doc, 'normal');
    expect(check(env).items[0]?.status).toBe('fail');
    expect(check(run(env, 'declare_isolation', { entityId: plate, method: 'primer' })).items[0]?.status).toBe('pass_isolated');
    const third = execute(env, 'add_box', { size: [1, 1, 1], position: [900, 900, 900] });
    expect(check(run(third.document, 'declare_isolation', { pair: [plate, third.affected[0]], method: 'primer' })).items[0]?.status).toBe(
      'fail',
    );
  });

  it('VC-COR-09: graphite against a non-aluminium group has no anodic index', () => {
    const { doc } = pair(['nickel_titanium_group', 'graphite']);
    const item = check(withEnvironment(doc, 'normal')).items[0];
    expect(item).toMatchObject({ status: 'unknown', code: 'COR_GROUP_VALUE_MISSING' });
  });

  it('VC-COR-10: the 889D scheme without a matrix is COR_889_TABLE_MISSING (unknown, never pass)', () => {
    const { doc } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const result = check(withEnvironment(doc, 'artificial_seawater', 'mil_std_889d'));
    expect(result.items[0]).toMatchObject({ status: 'unknown', code: 'COR_889_TABLE_MISSING', ruleId: 'COR-R-01' });
    expect(result.status).toBe('unknown');
  });
});

describe('check_material_compatibility: missing data never passes (VC-COR-15 flags)', () => {
  it('a part without material is COR_MATERIAL_MISSING, a material without group is COR_GROUP_MISSING', () => {
    const first = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10], position: [0, 0, 0] });
    const second = execute(first.document, 'add_box', { size: [10, 10, 10], position: [10, 0, 0] });
    const env = withEnvironment(second.document, 'normal');
    expect(check(env).items[0]).toMatchObject({ status: 'unknown', code: 'COR_MATERIAL_MISSING' });
    const { doc } = pair(['zinc', null]);
    expect(check(withEnvironment(doc, 'normal')).items[0]).toMatchObject({ status: 'unknown', code: 'COR_GROUP_MISSING' });
  });

  it('every item is reviewRequired and unverified, and the overall status is the worst item', () => {
    const { doc } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const result = check(withEnvironment(doc, 'normal'), { tolerance: { value: 0.1, unit: 'mm' } });
    for (const item of result.items) expect([item.reviewRequired, item.unverified, item.fingerprint.length]).toEqual([true, true, 64]);
    expect(result).toMatchObject({ status: 'fail', scheme: 'anodic_index', environment: 'normal' });
    expect(result.counts).toMatchObject({ fail: 1, accepted: 0 });
  });

  it('approximate contacts are flagged COR_CONTACT_APPROXIMATE', () => {
    const { doc } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const sphere = execute(doc, 'add_sphere', { radius: 4, position: [50, 25, 18] });
    const withSphere = run(sphere.document, 'assign_material', { materialName: 'm_block', entityIds: [sphere.affected[0]] });
    const items = check(withEnvironment(withSphere, 'normal')).items;
    expect(items.some((item) => item.warnings.includes('COR_CONTACT_APPROXIMATE'))).toBe(true);
  });
});

describe('check_material_compatibility: refusals and purity', () => {
  it('no environment is COR_ENVIRONMENT_UNSET (no default)', () => {
    const { doc } = pair(['zinc', 'zinc']);
    const result = execute(doc, 'check_material_compatibility', {});
    expect(result.error?.code).toBe('COR_ENVIRONMENT_UNSET');
    expect(result.document).toBe(doc);
  });

  it('a find_contacts refusal is returned with its code and the document unchanged', () => {
    const { doc } = pair(['zinc', 'zinc']);
    const env = withEnvironment(doc, 'normal');
    expect(execute(env, 'check_material_compatibility', { entityIds: ['ghost'] }).error?.code).toBe('COR_ENTITY_NOT_FOUND');
    expect(execute(env, 'check_material_compatibility', { tolerance: { value: -1, unit: 'mm' } }).error?.code).toBe(
      'COR_TOLERANCE_INVALID',
    );
  });

  it('is read-only, deterministic and pure', () => {
    const { doc } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const env = withEnvironment(doc, 'normal');
    const before = structuredClone(env);
    const first = execute(env, 'check_material_compatibility', {});
    expect(first.document).toBe(env);
    expect(first.affected).toEqual([]);
    expect(env).toEqual(before);
    expect(execute(env, 'check_material_compatibility', {}).data).toEqual(first.data);
  });
});

describe('fastener stack contacts (VC-COR-12)', () => {
  const stack = {
    id: 'fst-1.1',
    layers: [{ entityId: 'plate1' }, { entityId: 'plate2' }],
    fastener: { instanceId: 'bolt' },
    washers: [{ instanceId: 'washer', side: 'nut' }],
    nut: { instanceId: 'nut' },
  };
  const withStacks = (doc: ReturnType<typeof pair>['doc'], stacks: unknown): ReturnType<typeof pair>['doc'] =>
    ({ ...doc, fasteners: { catalogs: {}, stacks } }) as never;

  it('2 plates + bolt + nut-side washer + nut give the 5 expected pairs, sorted', () => {
    const oracle = expected.cases.find((entry) => entry.id === 'VC-COR-12')?.value as { pairs: string[][] };
    expect(stackContacts(withStacks(createEmptyDocument(), { a: stack }))).toEqual(oracle.pairs);
  });

  it('a head washer sits on the first layer; a nut without washer sits on the last layer; duplicates merge', () => {
    const second = { ...stack, id: 'fst-1.2', washers: [{ instanceId: 'hw', side: 'head' }], nut: { instanceId: 'nut2' } };
    const pairs = stackContacts(withStacks(createEmptyDocument(), { a: stack, b: second })).map((entry) => entry.join('|'));
    expect(pairs).toContain('hw|plate1');
    expect(pairs).toContain('nut2|plate2');
    expect(pairs.filter((entry) => entry === 'bolt|plate1')).toHaveLength(1);
  });

  it.each([[undefined], [null], [{ stacks: 5 }], [{ stacks: { a: 7, b: { layers: 'x', fastener: [], washers: {}, nut: 3 } } }]])(
    'a malformed fasteners slice %j yields no pair and no throw',
    (slice) => {
      expect(stackContacts({ ...createEmptyDocument(), fasteners: slice } as never)).toEqual([]);
    },
  );

  it('the check reports stack pairs without geometry and marks geometric ones that the stack also holds', () => {
    const { doc, plate, block } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const env = withEnvironment(doc, 'normal');
    const stackDoc = withStacks(env, {
      s: {
        ...stack,
        layers: [{ entityId: plate }, { entityId: block }],
        fastener: { instanceId: 'ghost-bolt' },
        washers: [],
        nut: undefined,
      },
    });
    const items = check(stackDoc).items;
    expect(items.find((item) => item.key === `galvanic:${plate}|${block}`)?.contact.source).toBe('stack');
    expect(items.find((item) => item.key.includes('ghost-bolt'))).toMatchObject({ status: 'unknown', code: 'COR_MATERIAL_MISSING' });
    expect(check(stackDoc, { includeStacks: false }).items).toHaveLength(1);
    expect(check(stackDoc, { includeStacks: false }).items[0]?.contact.source).toBe('closed_form');
    expect(check(stackDoc, { entityIds: [plate, block] }).items.every((item) => !item.key.includes('ghost-bolt'))).toBe(true);
  });

  it('10^4 stacks resolve to contacts well inside the 1 s budget', () => {
    const stacks = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        `s${index}`,
        { ...stack, layers: [{ entityId: `p${index}` }, { entityId: `q${index}` }], fastener: { instanceId: `b${index}` } },
      ]),
    );
    const started = performance.now();
    expect(stackContacts(withStacks(createEmptyDocument(), stacks)).length).toBeGreaterThan(40_000);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('CSV report (VC-COR-16)', () => {
  it('has the 12 columns and one neutralised row per item', () => {
    const { doc } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const named = run(doc, 'create_material', { name: '=cmd', density: 0.001, color: '#ffffff', metalness: 0, roughness: 1 });
    const result = check(withEnvironment(named, 'normal'), { report: true });
    const [header, row] = (result.text ?? '').split('\n');
    const oracle = expected.cases.find((entry) => entry.id === 'VC-COR-16')?.value as string[];
    expect(header?.split(',')).toEqual(oracle);
    expect(row?.startsWith('galvanic:')).toBe(true);
    expect(row?.split(',')).toHaveLength(12 + (row?.match(/"[^"]*,[^"]*"/g)?.length ?? 0) * 0);
    expect(result.fileName).toBe('corrosion.csv');
    expect(check(withEnvironment(named, 'normal')).text).toBeUndefined();
  });
});

describe('CSV cells and replay seed', () => {
  it('quotes commas and quotes, and writes the acceptance column', () => {
    const { doc } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const named = run(doc, 'create_material', { name: 'a,"b"', density: 0.001, color: '#ffffff', metalness: 0, roughness: 1 });
    const second = run(named, 'assign_material', { materialName: 'a,"b"', entityIds: [Object.keys(named.entities)[1]] });
    const text = check(withEnvironment(second, 'normal'), { report: true }).text ?? '';
    expect(text).toContain('a,""b""');
  });

  it('a history replay of a document without acceptances keeps its slice', () => {
    const { doc } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const env = withEnvironment(doc, 'normal');
    const replayed = execute(env, 'replay_history', {});
    expect(replayed.document.corrosion?.environment).toEqual({ scheme: 'anodic_index', value: 'normal' });
  });
});

describe('what the check cannot see is never a silent pass', () => {
  it('an instance whose component is missing becomes an unknown COR_CONTACT_SKIPPED item', () => {
    const base = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10], position: [0, 0, 0] });
    const unit = execute(base.document, 'add_box', { size: [10, 10, 10], position: [100, 0, 0] });
    const component = execute(unit.document, 'create_component', { name: 'Unit', entityIds: [unit.affected[0]] });
    const instance = component.affected.find((id) => component.document.entities[id]?.kind === 'instance') ?? '';
    const broken = { ...withEnvironment(component.document, 'normal'), components: {} };
    const result = check(broken);
    expect(result.status).toBe('unknown');
    expect(result.items).toMatchObject([
      { key: `skipped:${instance}`, status: 'unknown', code: 'COR_CONTACT_SKIPPED', reviewRequired: true },
    ]);
    expect(result.items[0]?.inputs['reason']).toContain('missing');
  });

  it('a pair whose anode area is unknown (a sphere) warns COR_AREA_UNKNOWN instead of skipping the small-anode rule', () => {
    const { doc } = pair(['aluminium_wrought_other', 'aluminium_wrought_2000']);
    const sphere = execute(doc, 'add_sphere', { radius: 4, position: [50, 25, 18] });
    const withSphere = run(sphere.document, 'assign_material', { materialName: 'm_plate', entityIds: [sphere.affected[0]] });
    const item = check(withEnvironment(withSphere, 'normal')).items.find((entry) => entry.ids.includes(sphere.affected[0] ?? ''));
    expect(item?.warnings).toContain('COR_AREA_UNKNOWN');
    expect(item?.inputs['areaBasis']).toBe('unavailable');
    const csv = check(withEnvironment(withSphere, 'normal'), { report: true }).text ?? '';
    expect(csv).toContain('COR_GALVANIC_OK;COR_AREA_UNKNOWN');
  });

  it('known areas record their basis', () => {
    const { doc } = pair(['aluminium_wrought_other', 'aluminium_wrought_2000']);
    expect(String(check(withEnvironment(doc, 'normal')).items[0]?.inputs['areaBasis'])).toContain('box total surface area');
  });

  it('a whole-part isolation warns COR_ISOLATION_BROAD; a pair isolation does not', () => {
    const { doc, plate, block } = pair(['aluminium_wrought_other', 'nickel_titanium_group']);
    const env = withEnvironment(doc, 'normal');
    expect(check(run(env, 'declare_isolation', { entityId: plate, method: 'primer' })).items[0]?.warnings).toContain('COR_ISOLATION_BROAD');
    expect(check(run(env, 'declare_isolation', { pair: [plate, block], method: 'primer' })).items[0]?.warnings).not.toContain(
      'COR_ISOLATION_BROAD',
    );
  });

  it('the plugin keeps acceptances through a replay seed and validates / restores a slice unchanged', async () => {
    const { corrosionPlugin } = await import('@cae/corrosion/plugin');
    const extension = corrosionPlugin.document;
    const { doc } = pair();
    expect(extension?.replaySeed?.(doc)).toEqual({});
    const acceptance = {
      itemKey: 'k',
      decision: 'accepted',
      justification: 'j',
      fingerprint: 'a'.repeat(64),
      signer: 's',
      signatureId: 'i',
      signature: {},
      documentUid: 'u',
    };
    const seeded = { ...doc, corrosion: { materials: {}, surfaceSystems: {}, isolations: {}, acceptances: { k: acceptance } } } as never;
    expect(extension?.replaySeed?.(seeded)).toMatchObject({ corrosion: { acceptances: { k: acceptance }, isolations: {} } });
    expect(extension?.derivedEntityIds(doc).size).toBe(0);
    expect(extension?.restore({ a: 1 })).toEqual({ a: 1 });
  });
});
