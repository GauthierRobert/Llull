/** add_material_model: storage, replacement, refusals, preferred models, fit records and validity. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { NL1_ELASTIC, NL1_PERFECT, ONE, SOURCE, addModel, codeOf, nl1Document, run, withMaterial } from './materialFixtures';

const base = (): CadDocument => withMaterial(createEmptyDocument(), 'steel');
const add = (doc: CadDocument, model: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  codeOf(doc, 'add_material_model', { material: 'steel', id: 'm', model, basis: 'typical', source: SOURCE, ...extra });

describe('add_material_model', () => {
  it('stores a model with a recomputed hash, records a step and is pure', () => {
    const doc = base();
    const snapshot = structuredClone(doc);
    const result = execute(doc, 'add_material_model', {
      material: 'steel',
      id: 'elastic',
      model: NL1_ELASTIC,
      basis: 'A',
      source: SOURCE,
      validity: [{ variable: 'T', unit: 'K', data: [293, 293] }],
    });
    expect(doc).toEqual(snapshot);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(/add_material_model 'steel\/elastic': elastic_isotropic \(basis A, sha256 [0-9a-f]{12}…\)/);
    const stored = result.document.materials['steel']?.materialModels?.[0];
    expect(stored?.parametersSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.provenance).toEqual(SOURCE);
    expect(stored?.reviewedBy).toBeUndefined();
    expect(result.document.featureHistory.at(-1)?.name).toBe('add_material_model');
    expect((result.data as { kind: string }).kind).toBe('elastic_isotropic');
  });

  it('replaces a model, and create_material keeps models, sets and the default set', () => {
    const doc = nl1Document();
    const replaced = run(doc, 'add_material_model', {
      material: 'nl1_steel',
      id: 'elastic',
      model: { ...NL1_ELASTIC, nu: ONE(0.3) },
      basis: 'B',
      source: SOURCE,
      replace: true,
    });
    expect(replaced.summary).toContain(', replaced');
    expect(replaced.document.materials['nl1_steel']?.materialModels?.map((m) => m.id)).toEqual(['elastic', 'perfect', 'iso_h']);
    const recreated = run(replaced.document, 'create_material', {
      name: 'nl1_steel',
      density: 0.0079,
      color: '#aaaaaa',
      metalness: 1,
      roughness: 0.3,
    });
    const material = recreated.document.materials['nl1_steel'];
    expect(material?.materialModels).toHaveLength(3);
    expect(material?.constitutiveSets?.map((s) => s.id)).toEqual(['perfect', 'iso_hardening']);
    expect(material?.defaultConstitutiveSet).toBe('iso_hardening');
  });

  it('refuses unknown materials, duplicates, malformed laws and missing provenance', () => {
    const doc = addModel(base(), 'steel', 'm', NL1_ELASTIC);
    expect(add(doc, NL1_ELASTIC)).toBe('MATL_MODEL_EXISTS');
    expect(add(doc, NL1_ELASTIC, { id: 'other', material: 'nope' })).toBe('MAT_RECORD_NOT_FOUND');
    expect(add(doc, { kind: 'no_such_law' }, { id: 'x' })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, { ...NL1_ELASTIC, extra: 1 }, { id: 'x' })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, { notAKind: true }, { id: 'x' })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, NL1_ELASTIC, { id: 'x', source: { citation: ' ' } })).toBe('MAT_PROVENANCE_MISSING');
    expect(add(doc, NL1_ELASTIC, { id: 'x', fit: { method: 'magic' } })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(doc, NL1_ELASTIC, { id: 'x', validity: [{ variable: 'T', unit: 'K', data: [1, 2], extra: true }] })).toBe(
      'CMD_INVALID_PARAMS',
    );
    const result = execute(doc, 'add_material_model', {
      material: 'steel',
      id: 'x',
      model: { ...NL1_ELASTIC, extra: 1 },
      basis: 'A',
      source: SOURCE,
    });
    expect(result.error?.paths[0]).toBe('model');
    expect(result.error?.remediation).toContain('describe add_material_model');
  });

  it('refuses malformed validity ranges with PROP_RANGE_INVALID', () => {
    const doc = base();
    const range = (patch: Record<string, unknown>): string =>
      add(doc, NL1_ELASTIC, { validity: [{ variable: 'T', unit: 'K', data: [200, 300], ...patch }] });
    expect(range({})).toBe('accepted');
    expect(range({ data: [300, 200] })).toBe('PROP_RANGE_INVALID');
    expect(range({ equation: [250, 400] })).toBe('PROP_RANGE_INVALID');
    expect(range({ equation: [100, 250] })).toBe('PROP_RANGE_INVALID');
    expect(range({ unit: 'MPa' })).toBe('PROP_RANGE_INVALID');
    expect(range({ unit: 'degC', data: [-70, 30] })).toBe('accepted');
    const twice = [
      { variable: 'T', unit: 'K', data: [200, 300] },
      { variable: 'T', unit: 'K', data: [200, 300] },
    ];
    expect(add(doc, NL1_ELASTIC, { validity: twice })).toBe('PROP_RANGE_INVALID');
  });

  it('allows one preferred model per kind', () => {
    const doc = addModel(base(), 'steel', 'a', NL1_ELASTIC, { preferred: true });
    expect(add(doc, NL1_ELASTIC, { id: 'b', preferred: true })).toBe('MAT_PREFERRED_CONFLICT');
    expect(add(doc, NL1_ELASTIC, { id: 'a', preferred: true, replace: true })).toBe('accepted');
    expect(add(doc, NL1_PERFECT, { id: 'b', preferred: true })).toBe('accepted');
  });

  it('accepts a fit record from fit_material_model and never marks it reviewed', () => {
    const fit = {
      method: 'linear_least_squares',
      objective: 'absolute',
      points: 5,
      datasetSha256: 'a'.repeat(64),
      residual: { rms: 0.1, maxAbs: 0.2, maxRel: 0.3, unit: 'MPa' },
      fittedRange: [{ variable: 'stretch', unit: '1', data: [1, 4] }],
      tool: 'test',
    };
    const added = run(base(), 'add_material_model', {
      material: 'steel',
      id: 'f',
      model: NL1_ELASTIC,
      basis: 'typical',
      source: SOURCE,
      fit,
    });
    expect(added.document.materials['steel']?.materialModels?.[0]?.fit?.fittedRange[0]?.variable).toBe('stretch');
    expect(added.document.materials['steel']?.materialModels?.[0]?.reviewedBy).toBeUndefined();
  });
});
