import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { corrosionErrors } from '@cae/corrosion/model';
import { pair, run } from './fixtures';

const SOURCE = { citation: 'test' };

describe('set_service_environment', () => {
  it('records scheme and environment', () => {
    const result = execute(createEmptyDocument(), 'set_service_environment', { scheme: 'anodic_index', environment: 'harsh' });
    expect(result.document.corrosion?.environment).toEqual({ scheme: 'anodic_index', value: 'harsh' });
    expect(result.summary).toContain('0.15 V');
  });

  it.each([
    ['anodic_index', 'artificial_seawater'],
    ['mil_std_889d', 'harsh'],
  ])('refuses %s with %s and leaves the document unchanged', (scheme, environment) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_service_environment', { scheme, environment });
    expect(result.error?.code).toBe('COR_ENVIRONMENT_INVALID');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    const before = structuredClone(doc);
    execute(doc, 'set_service_environment', { scheme: 'mil_std_889d', environment: 'artificial_seawater' });
    expect(doc).toEqual(before);
  });
});

describe('set_galvanic_group', () => {
  const { doc } = pair();

  it('stores group, override and source on the material', () => {
    const result = execute(doc, 'set_galvanic_group', {
      material: 'm_plate',
      galvanicGroup: 'aluminium_wrought_other',
      anodicIndexV: 0.8,
      source: { citation: 'data sheet', locator: 'p. 3' },
    });
    expect(result.affected).toEqual(['m_plate']);
    expect(result.document.corrosion?.materials['m_plate']).toEqual({
      galvanicGroup: 'aluminium_wrought_other',
      anodicIndexV: 0.8,
      source: { citation: 'data sheet', locator: 'p. 3' },
    });
    expect(doc.corrosion).toBeUndefined();
  });

  it.each([
    [{ material: 'nope', galvanicGroup: 'zinc', source: SOURCE }, 'COR_MATERIAL_NOT_FOUND'],
    [{ material: 'm_plate', galvanicGroup: 'unobtainium', source: SOURCE }, 'COR_GROUP_UNKNOWN'],
    [{ material: 'm_plate', galvanicGroup: 'zinc', source: { citation: '  ' } }, 'COR_PARAMS_INVALID'],
    [{ material: 'm_plate', galvanicGroup: 'zinc', anodicIndexV: 9, source: SOURCE }, 'COR_PARAMS_INVALID'],
    [{ material: '__proto__', galvanicGroup: 'zinc', source: SOURCE }, 'COR_MATERIAL_NOT_FOUND'],
  ])('refuses %j with %s', (params, code) => {
    const result = execute(doc, 'set_galvanic_group', params);
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
  });
});

describe('assign_surface_system', () => {
  it('mints ss-<step>.<k>, covers the entities and reports the plating group', () => {
    const { doc, block } = pair();
    const result = execute(doc, 'assign_surface_system', {
      entityIds: [block],
      layers: [
        { class: 'conversion_coating', spec: 'MIL-DTL-81706' },
        { class: 'metallic_plating', galvanicGroup: 'cadmium_plate', spec: 'QQ-P-416' },
      ],
    });
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^ss-/);
    expect(result.document.corrosion?.surfaceSystems[id]).toMatchObject({
      entityIds: [block],
      layers: [{ class: 'conversion_coating' }, { class: 'metallic_plating' }],
    });
    expect(result.summary).toContain('cadmium_plate');
  });

  it('one system per entity: a new assignment replaces the old; [none] clears', () => {
    const { doc, plate, block } = pair();
    const first = run(doc, 'assign_surface_system', { entityIds: [plate, block], layers: [{ class: 'primer' }] });
    const second = execute(first, 'assign_surface_system', { entityIds: [block], layers: [{ class: 'paint' }] });
    const systems = Object.values(second.document.corrosion?.surfaceSystems ?? {});
    expect(systems.map((system) => [system.entityIds, system.layers[0]?.class])).toEqual(
      expect.arrayContaining([
        [[plate], 'primer'],
        [[block], 'paint'],
      ]),
    );
    const cleared = run(second.document, 'assign_surface_system', { entityIds: [plate, block], layers: [{ class: 'none' }] });
    expect(cleared.corrosion?.surfaceSystems).toEqual({});
  });

  it.each([
    [{ entityIds: ['ghost'], layers: [{ class: 'primer' }] }, 'COR_ENTITY_NOT_FOUND'],
    [{ entityIds: [], layers: [{ class: 'primer' }] }, 'COR_PARAMS_INVALID'],
    [{ entityIds: ['$block'], layers: [] }, 'COR_PARAMS_INVALID'],
    [{ entityIds: ['$block'], layers: [{ class: 'metallic_plating' }] }, 'COR_GROUP_MISSING'],
    [{ entityIds: ['$block'], layers: [{ class: 'metallic_plating', galvanicGroup: 'unobtainium' }] }, 'COR_GROUP_UNKNOWN'],
  ])('refuses %j with %s', (params, code) => {
    const { doc, block } = pair();
    const result = execute(doc, 'assign_surface_system', {
      ...params,
      entityIds: params.entityIds.map((id) => (id === '$block' ? block : id)),
    });
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
  });
});

describe('declare_isolation / remove_isolation', () => {
  it('declares a pair isolation and removes it', () => {
    const { doc, plate, block } = pair();
    const declared = execute(doc, 'declare_isolation', { pair: [plate, block], method: 'sealant_faying', spec: 'MIL-PRF-81733 Type IV' });
    const id = declared.affected[0] ?? '';
    expect(declared.document.corrosion?.isolations[id]).toEqual({
      id,
      pair: [plate, block],
      method: 'sealant_faying',
      spec: 'MIL-PRF-81733 Type IV',
    });
    const removed = execute(declared.document, 'remove_isolation', { id });
    expect(removed.document.corrosion?.isolations).toEqual({});
    expect(removed.affected).toEqual([id]);
  });

  it('accepts an instance child id through its instance and a single part', () => {
    const { doc, plate } = pair();
    expect(execute(doc, 'declare_isolation', { entityId: plate, method: 'primer' }).error).toBeUndefined();
    expect(execute(doc, 'declare_isolation', { pair: [`${plate}/x`, plate], method: 'primer' }).error).toBeUndefined();
  });

  it.each([
    [{ method: 'primer' }, 'COR_ISOLATION_TARGET_MISSING'],
    [{ method: 'primer', entityId: '$a', pair: ['$a', '$b'] }, 'COR_ISOLATION_TARGET_MISSING'],
    [{ method: 'primer', pair: ['$a', '$a'] }, 'COR_ISOLATION_TARGET_MISSING'],
    [{ method: 'primer', entityId: 'ghost' }, 'COR_ENTITY_NOT_FOUND'],
  ])('refuses %j with %s', (params, code) => {
    const { doc, plate, block } = pair();
    const fill = (value: unknown): unknown => (value === '$a' ? plate : value === '$b' ? block : value);
    const resolved = Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, Array.isArray(value) ? value.map(fill) : fill(value)]),
    );
    const result = execute(doc, 'declare_isolation', resolved);
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
  });

  it('removing an unknown isolation is refused', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'remove_isolation', { id: 'iso-9.9' });
    expect(result.error?.code).toBe('COR_ISOLATION_NOT_FOUND');
    expect(result.document).toBe(doc);
  });
});

describe('list_compatibility_rules', () => {
  it('lists the rules, the anodic table with sources and the empty 889D matrix', () => {
    const data = execute(createEmptyDocument(), 'list_compatibility_rules', {}).data as {
      rules: { id: string }[];
      anodicGroups: { id: string; anodicIndexV: number | null; source: string }[];
      anodicLimits: { environment: string; maxDifferenceV: number }[];
      galvanic889dCells: number;
    };
    expect(data.rules.map((rule) => rule.id)).toContain('COR-R-02');
    expect(data.anodicGroups.find((group) => group.id === 'cadmium_plate')).toMatchObject({ anodicIndexV: 0.95, source: 'S6' });
    expect(data.anodicGroups.find((group) => group.id === 'graphite')?.anodicIndexV).toBeNull();
    expect(Object.fromEntries(data.anodicLimits.map((limit) => [limit.environment, limit.maxDifferenceV]))).toEqual({
      harsh: 0.15,
      normal: 0.25,
      controlled: 0.5,
    });
    expect(data.galvanic889dCells).toBe(0);
  });

  it('filters to one rule and refuses an unknown one', () => {
    const doc = createEmptyDocument();
    expect((execute(doc, 'list_compatibility_rules', { ruleId: 'COR-R-04' }).data as { rules: unknown[] }).rules).toHaveLength(1);
    expect(execute(doc, 'list_compatibility_rules', { ruleId: 'COR-R-99' }).error?.code).toBe('COR_PARAMS_INVALID');
  });
});

describe('the corrosion slice validator', () => {
  const slice = { materials: {}, surfaceSystems: {}, isolations: {}, acceptances: {} };
  it('accepts a command-built slice and rejects value errors by path', () => {
    const { doc, plate, block } = pair(['zinc', null]);
    const built = run(run(doc, 'declare_isolation', { pair: [plate, block], method: 'primer' }), 'set_service_environment', {
      scheme: 'anodic_index',
      environment: 'normal',
    });
    expect(corrosionErrors({ corrosion: built.corrosion })).toEqual([]);
    expect(corrosionErrors({})).toEqual([]);
    const messages = (patch: Record<string, unknown>): string => corrosionErrors({ corrosion: { ...slice, ...patch } }).join('|');
    expect(messages({ environment: { scheme: 'anodic_index', value: 'artificial_seawater' } })).toContain('not valid for scheme');
    expect(messages({ surfaceSystems: { a: { id: 'b', entityIds: [], layers: [{ class: 'metallic_plating' }] } } })).toContain(
      'must equal its key',
    );
    expect(messages({ surfaceSystems: { a: { id: 'a', entityIds: [], layers: [{ class: 'metallic_plating' }] } } })).toContain(
      'needs a galvanicGroup',
    );
    expect(messages({ isolations: { i: { id: 'i', method: 'primer' } } })).toContain('exactly one of pair / entityId');
    expect(messages({ acceptances: { k: { itemKey: 'j' } } })).toContain('corrosion.acceptances.k');
    expect(messages({ materials: { constructor: { galvanicGroup: 'zinc', source: { citation: 'x' } } } })).toContain('Invalid key');
    expect(messages({ extra: 1 })).toContain('corrosion');
  });
});
