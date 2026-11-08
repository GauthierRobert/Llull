import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { marginBar } from '../cae/marginsFixtures';
import { dataOf, empty, expectedCase, run, step, syntheticDocument, withBlock, withMaterial, workedDocument } from './fixtures';

interface Item {
  readonly code: string;
  readonly severity: string;
  readonly ids: string[];
  readonly remediation: string;
}

const items = (result: ReturnType<typeof run>): Item[] => dataOf(result)['items'] as Item[];
const codes = (result: ReturnType<typeof run>): string[] => items(result).map((item) => item.code);

describe('check_material_selection', () => {
  it('passes when every material in use has a verified density and E on one basis', () => {
    const { doc } = withBlock(syntheticDocument(), 'syn_a');
    const result = run(doc, 'check_material_selection', {});
    expect(dataOf(result)).toMatchObject({ status: 'pass', items: [], basesUsed: ['company'], unverified: false, reviewRequired: true });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('VC-SEL-16: warns SEL_VALUE_UNVERIFIED for typical / supplier values and SEL_BASIS_MIXED for several bases', () => {
    const base = withBlock(workedDocument(), 'ti6al4v_annealed');
    const result = run(base.doc, 'check_material_selection', {});
    const data = dataOf(result);
    expect(data['status']).toBe('warn');
    expect(codes(result)).toEqual(['SEL_VALUE_UNVERIFIED', expectedCase('VC-SEL-16').value]);
    expect(items(result)[0]?.ids).toEqual(expect.arrayContaining(['ti6al4v_annealed']));
    expect(items(result)[0]?.remediation.length).toBeGreaterThan(0);
    expect(data['basesUsed']).toEqual(['supplier_unstated', 'typical']);
    expect(data['unverified']).toBe(true);
    expect(result.summary).toContain('warn');
  });

  it('reports a record without a density (warning) and without E (info) as SEL_PROPERTY_MISSING with the entity ids', () => {
    const doc = withMaterial(empty(), 'bare', [{ property: 'Fty', value: 300, unit: 'MPa', basis: 'A', citation: 'test' }]);
    const block = withBlock(doc, 'bare');
    const result = run(block.doc, 'check_material_selection', {});
    expect(items(result).map((item) => [item.code, item.severity])).toEqual([
      ['SEL_PROPERTY_MISSING', 'warning'],
      ['SEL_PROPERTY_MISSING', 'info'],
    ]);
    expect(items(result)[0]?.ids).toEqual(['bare', block.id]);
    expect(dataOf(result)['status']).toBe('warn');
  });

  it('a legacy create_material density is unverified (no source) and a restricted entityIds scope only checks those entities', () => {
    const legacy = step(empty(), 'create_material', { name: 'plain', density: 0.0078, color: '#999999', metalness: 1, roughness: 0.4 });
    const block = withBlock(legacy, 'plain');
    const both = withBlock(block.doc, 'plain');
    const syn = withBlock(withBlock(syntheticDocument(), 'syn_a').doc, 'syn_b');
    expect(codes(run(block.doc, 'check_material_selection', {}))).toContain('SEL_VALUE_UNVERIFIED');
    const scoped = run(syn.doc, 'check_material_selection', { entityIds: [syn.id] });
    expect((dataOf(scoped)['materials'] as { material: string }[]).map((row) => row.material)).toEqual(['syn_b']);
    expect((dataOf(run(both.doc, 'check_material_selection', {}))['materials'] as { entityIds: string[] }[])[0]?.entityIds).toHaveLength(2);
  });

  it('SEL_FEA_STALE_AFTER_SUBSTITUTION: a solved analysis over the checked entities whose inputs changed since the solve (05 staleness hash)', () => {
    const bar = marginBar();
    expect(codes(run(bar.recorded, 'check_material_selection', {}))).not.toContain('SEL_FEA_STALE_AFTER_SUBSTITUTION');
    const edited = execute(bar.recorded, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'g',
      kind: 'gravity',
      vector: [0, 0, -1],
    }).document;
    const result = run(edited, 'check_material_selection', {});
    const stale = items(result).find((item) => item.code === 'SEL_FEA_STALE_AFTER_SUBSTITUTION');
    expect(stale).toMatchObject({ severity: 'warning', ids: [bar.analysisId, bar.boxId] });
    expect(dataOf(result)['status']).toBe('warn');
    const other = withBlock(edited, 'steel');
    expect(codes(run(other.doc, 'check_material_selection', { entityIds: [other.id] }))).not.toContain('SEL_FEA_STALE_AFTER_SUBSTITUTION');
  });

  it('is pure', () => {
    const { doc } = withBlock(workedDocument(), 'aa7075_t6');
    const before = structuredClone(doc);
    const result = execute(doc, 'check_material_selection', {});
    expect(doc).toEqual(before);
    expect(result.document).toBe(doc);
  });

  it('refuses an entity that is not in the document (unchanged doc)', () => {
    const { doc } = withBlock(syntheticDocument(), 'syn_a');
    const result = run(doc, 'check_material_selection', { entityIds: ['ghost'] });
    expect(result.rejected).toBe(true);
    expect(result.error).toMatchObject({ code: 'SEL_ENTITY_NOT_FOUND', ids: ['ghost'] });
    expect(result.document).toBe(doc);
  });
});
