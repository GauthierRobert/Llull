/** check_material_models readiness items and load-time validation of material models (persistence guard). */
import { describe, expect, it } from 'vitest';
import { lawHash } from '@core/commands/document/materialModels';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { MaterialModel, MaterialValidRange } from '@core/model/materialModel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { GPa, MPa, NL1_ELASTIC, ONE, SOURCE, T293, addModel, defineSet, nl1Document, run, withMaterial } from './materialFixtures';

interface Check {
  status: 'pass' | 'warn' | 'fail';
  items: { code: string; severity: string; ids: string[]; message: string; remediation: string }[];
  stability: Record<string, { positiveDefinite?: boolean; drucker?: Record<string, unknown>; shearModulus?: number }>;
  unverified: { id: string; reasons: string[] }[];
  notes: string[];
}
const check = (doc: CadDocument, params: Record<string, unknown> = {}): Check => run(doc, 'check_material_models', params).data as Check;
const codes = (data: Check): string[] => data.items.map((item) => item.code);

const D0 = { value: 0, unit: '1/MPa' };
const treloar: MaterialValidRange = { variable: 'stretch', unit: '1', data: [0.5, 4] };

/** Replace the stored models of a material directly (states a command would refuse). */
const withModels = (doc: CadDocument, name: string, models: MaterialModel[]): CadDocument => ({
  ...doc,
  materials: {
    ...doc.materials,
    [name]: { ...(doc.materials[name] as NonNullable<(typeof doc.materials)[string]>), materialModels: models },
  },
});

describe('check_material_models', () => {
  it('passes a verified, complete material and reports stability data', () => {
    let doc = withMaterial(createEmptyDocument(), 'steel');
    doc = addModel(doc, 'steel', 'e', NL1_ELASTIC, { validity: T293, basis: 'A' });
    doc = addModel(doc, 'steel', 'h', { kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: D0 }, { validity: [treloar], basis: 'A' });
    doc = defineSet(doc, 'steel', { id: 's', elastic: 'e' });
    const snapshot = structuredClone(doc);
    const result = run(doc, 'check_material_models', {});
    expect(doc).toEqual(snapshot);
    expect(result.document).toBe(doc);
    const data = result.data as Check;
    expect(data.status).toBe('pass');
    expect(data.items).toEqual([]);
    expect(data.stability['steel/e']?.positiveDefinite).toBe(true);
    expect(data.stability['steel/h']?.shearModulus).toBeCloseTo(0.4, 12);
    expect(result.summary).toContain('check_material_models: pass');
  });

  it('warns about missing validity and lists unverified models with reasons', () => {
    const doc = defineSet(addModel(withMaterial(createEmptyDocument(), 'steel'), 'steel', 'e', NL1_ELASTIC), 'steel', {
      id: 's',
      elastic: 'e',
    });
    const data = check(doc);
    expect(data.status).toBe('warn');
    expect(codes(data)).toEqual(['MATL_VALIDITY_MISSING']);
    expect(data.unverified).toEqual([{ id: 'steel/e', reasons: ['basis unspecified'] }]);
    expect(check(doc, { usedBy: 'analyses' }).notes[0]).toContain('no analyses');
    expect(check(doc, { material: ['steel'] }).status).toBe('warn');
  });

  it('fails on an unstable hyperelastic law inside its validity and warns outside it', () => {
    let doc = withMaterial(createEmptyDocument(), 'rubber');
    doc = addModel(
      doc,
      'rubber',
      'mr',
      { kind: 'hyper_mooney_rivlin', C10: MPa(0.2), C01: MPa(-0.15), D1: D0 },
      { validity: [{ variable: 'stretch', unit: '1', data: [0.95, 1.05] }] },
    );
    const stored = doc.materials['rubber']?.materialModels ?? [];
    const inside = withModels(
      doc,
      'rubber',
      stored.map((m) => ({ ...m, validity: [treloar] })),
    );
    const failing = check(inside);
    expect(failing.status).toBe('fail');
    expect(failing.items.find((item) => item.code === 'MATL_HYPERELASTIC_UNSTABLE' && item.severity === 'error')?.remediation).toContain(
      'refit',
    );
    expect(
      check(doc)
        .items.filter((item) => item.code === 'MATL_HYPERELASTIC_UNSTABLE')
        .every((item) => item.severity === 'warning'),
    ).toBe(true);
    expect(check(doc).stability['rubber/mr']?.drucker).toBeDefined();
  });

  it('reports a set broken by replacing one of its models, and an unknown default set', () => {
    const original = nl1Document();
    const creep = run(withMaterial(createEmptyDocument(), 'x'), 'add_material_model', {
      material: 'x',
      id: 'elastic',
      model: { kind: 'creep_norton', A: 1e-10, n: 5, m: 0, stressUnit: 'MPa', timeUnit: 'h', hardening: 'time' },
      basis: 'A',
      source: SOURCE,
    }).document.materials['x']?.materialModels?.[0] as MaterialModel;
    const stored = original.materials['nl1_steel']?.materialModels ?? [];
    const doc = withModels(
      original,
      'nl1_steel',
      stored.map((m) => (m.id === 'elastic' ? { ...creep, id: 'elastic' } : m)),
    );
    const data = check(doc);
    expect(data.status).toBe('fail');
    expect(codes(data)).toContain('MATL_COMBINATION_INVALID');
    const dangling = {
      ...nl1Document(),
      materials: { nl1_steel: { ...(nl1Document().materials['nl1_steel'] as object), defaultConstitutiveSet: 'ghost' } },
    } as unknown as CadDocument;
    expect(codes(check(dangling))).toContain('MATL_MODEL_NOT_FOUND');
    expect(check(createEmptyDocument(), { material: ['ghost'] }).items[0]).toMatchObject({
      code: 'MAT_RECORD_NOT_FOUND',
      severity: 'error',
    });
  });

  it('warns when monotonic and cyclic Ramberg-Osgood disagree on E', () => {
    let doc = withMaterial(createEmptyDocument(), 'al');
    doc = addModel(
      doc,
      'al',
      'ro',
      { kind: 'ramberg_osgood', form: 'calculix', E: GPa(72), nu: ONE(0.33), sigma0: MPa(400), n: 15, alpha: 0.36 },
      { validity: T293 },
    );
    doc = addModel(doc, 'al', 'cyc', { kind: 'cyclic_ramberg_osgood', Kprime: MPa(900), nPrime: 0.1, E: GPa(70) });
    const data = check(doc);
    expect(data.items.find((item) => item.code === 'MATL_RO_FORMS_DIFFER')).toMatchObject({
      severity: 'warning',
      ids: ['al/ro', 'al/cyc'],
    });
    const aligned = addModel(
      doc,
      'al',
      'cyc',
      { kind: 'cyclic_ramberg_osgood', Kprime: MPa(900), nPrime: 0.1, E: GPa(72) },
      { replace: true },
    );
    expect(codes(check(aligned))).not.toContain('MATL_RO_FORMS_DIFFER');
  });

  it('checks solver support per target', () => {
    let doc = withMaterial(createEmptyDocument(), 'poly');
    doc = addModel(doc, 'poly', 'e', { kind: 'elastic_isotropic', E: MPa(3), nu: ONE(0.3) }, { validity: T293 });
    doc = addModel(doc, 'poly', 'v', { kind: 'visco_prony', shear: [{ g: 0.3, tau: { value: 1, unit: 's' } }] }, { validity: T293 });
    doc = defineSet(doc, 'poly', { id: 's', elastic: 'e', viscoelastic: 'v' });
    expect(codes(check(doc))).not.toContain('MATL_EXPORT_UNSUPPORTED');
    expect(check(doc, { target: 'calculix' }).items.find((item) => item.code === 'MATL_EXPORT_UNSUPPORTED')).toMatchObject({
      severity: 'error',
      ids: ['poly/s'],
    });
    let rubber = withMaterial(createEmptyDocument(), 'rubber');
    rubber = addModel(rubber, 'rubber', 'h', { kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: D0 }, { validity: [treloar] });
    rubber = defineSet(rubber, 'rubber', { id: 's', hyperelastic: 'h' });
    expect(check(rubber, { target: 'calculix' }).items.map((item) => `${item.code}:${item.severity}`)).toEqual([
      'MATL_INCOMPRESSIBLE_DEFAULT:warning',
    ]);
    expect(check(rubber, { target: 'nastran' }).items.map((item) => item.code)).toEqual(['MATL_EXPORT_UNSUPPORTED']);
    const noValidity = defineSet(addModel(withMaterial(createEmptyDocument(), 'x'), 'x', 'e', NL1_ELASTIC), 'x', { id: 's', elastic: 'e' });
    expect(check(noValidity, { target: 'calculix' }).items.map((item) => `${item.code}:${item.severity}`)).toEqual([
      'MATL_VALIDITY_MISSING:warning',
      'MATL_VALIDITY_MISSING:error',
    ]);
  });

  it('reports parameter issues of stored models and property-model references', () => {
    let doc = withMaterial(createEmptyDocument(), 'steel');
    doc = addModel(doc, 'steel', 'near', { kind: 'elastic_isotropic', E: GPa(1), nu: ONE(0.4999999) }, { validity: T293 });
    expect(codes(check(doc))).toEqual(['MATL_NEAR_INCOMPRESSIBLE']);
  });
});

describe('stability reports per law kind', () => {
  it('reports pivots for every elastic kind and the Drucker scan for every hyperelastic kind', () => {
    const upper = [500000, 157200, 157200, 0, 0, 0, 400000, 157200, 0, 0, 0, 300000, 0, 0, 0, 126200, 0, 0, 126200, 0, 126200];
    const models: Record<string, Record<string, unknown>> = {
      iso: NL1_ELASTIC,
      ortho: {
        kind: 'elastic_orthotropic',
        E1: MPa(135000),
        E2: MPa(10000),
        E3: MPa(10000),
        nu12: ONE(0.3),
        nu13: ONE(0.3),
        nu23: ONE(0.45),
        G12: MPa(5000),
        G13: MPa(5000),
        G23: MPa(3448),
      },
      transverse: {
        kind: 'elastic_transversely_isotropic',
        isotropyPlane: '23',
        Ep: MPa(10000),
        Et: MPa(135000),
        nuP: ONE(0.3),
        nuPT: ONE(0.02),
        Gt: MPa(5000),
      },
      aniso: { kind: 'elastic_anisotropic', stiffness: upper, unit: 'MPa' },
      neo: { kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: D0 },
      mr: { kind: 'hyper_mooney_rivlin', C10: MPa(0.16), C01: MPa(0.02), D1: D0 },
      poly: { kind: 'hyper_polynomial', order: 2, C: { C10: 0.2, C01: 0.05, C20: 0.001 }, D: [0, 0], stressUnit: 'MPa' },
      reduced: { kind: 'hyper_reduced_polynomial', order: 2, Ci0: [0.2, -0.001], D: [0, 0], stressUnit: 'MPa' },
      yeoh: { kind: 'hyper_yeoh', C10: MPa(0.18), C20: MPa(-0.002), C30: MPa(0.0001), D: [0, 0, 0], compliance: '1/MPa' },
      ogden: { kind: 'hyper_ogden', convention: 'calculix', terms: [{ mu: 0.4, alpha: 2 }], D: [0], stressUnit: 'MPa' },
      ab: { kind: 'hyper_arruda_boyce', mu: MPa(0.27), lambdaM: 2.8, D: D0 },
    };
    let doc = withMaterial(createEmptyDocument(), 'all');
    for (const [id, model] of Object.entries(models)) doc = addModel(doc, 'all', id, model, { validity: [treloar] });
    doc = addModel(doc, 'all', 'prony', { kind: 'visco_prony', shear: [{ g: 0.3, tau: { value: 1, unit: 's' } }] }, { validity: T293 });
    const data = check(doc);
    expect(Object.keys(data.stability).sort()).toEqual(
      Object.keys(models)
        .map((id) => `all/${id}`)
        .sort(),
    );
    for (const id of ['iso', 'ortho', 'transverse', 'aniso']) expect(data.stability[`all/${id}`]?.positiveDefinite).toBe(true);
    for (const id of ['neo', 'mr', 'poly', 'reduced', 'yeoh', 'ogden', 'ab']) expect(data.stability[`all/${id}`]?.drucker).toBeDefined();
    expect(data.status).toBe('warn');
  });
});

describe('persistence of material models', () => {
  const document = nl1Document();

  it('round-trips models, sets and the default set', () => {
    const loaded = deserializeDocument(serializeDocument(document));
    const material = loaded.materials['nl1_steel'];
    expect(material?.materialModels).toEqual(document.materials['nl1_steel']?.materialModels);
    expect(material?.constitutiveSets).toEqual(document.materials['nl1_steel']?.constitutiveSets);
    expect(material?.defaultConstitutiveSet).toBe('iso_hardening');
  });

  it('rejects tampered hashes, broken sets and malformed models at load time', () => {
    const text = serializeDocument(document);
    type Stored = {
      document?: { materials: Record<string, Record<string, unknown>> };
      materials?: Record<string, Record<string, unknown>>;
    };
    const mutate = (change: (material: Record<string, unknown>) => void): string => {
      const copy = JSON.parse(text) as Stored;
      const material = (copy.document?.materials ?? copy.materials ?? {})['nl1_steel'];
      if (material === undefined) throw new Error('no material');
      change(material);
      return JSON.stringify(copy);
    };
    const models = (material: Record<string, unknown>): Record<string, unknown>[] =>
      material['materialModels'] as Record<string, unknown>[];
    const sets = (material: Record<string, unknown>): Record<string, unknown>[] =>
      material['constitutiveSets'] as Record<string, unknown>[];
    const fails = (change: (material: Record<string, unknown>) => void, pattern: RegExp): void => {
      expect(() => deserializeDocument(mutate(change))).toThrow(pattern);
    };
    fails((m) => void (models(m)[0]!['parametersSha256'] = '0'.repeat(64)), /parametersSha256/);
    fails((m) => void (m['defaultConstitutiveSet'] = 'ghost'), /defaultConstitutiveSet/);
    fails((m) => void (sets(m)[0]!['plastic'] = 'elastic'), /MATL_COMBINATION_INVALID/);
    fails((m) => void (models(m)[0]!['model'] = { kind: 'made_up' }), /materialModels\[0\]/);
    fails((m) => void sets(m).push({ id: 'perfect', elastic: 'elastic' }), /duplicate constitutive set id/);
    fails((m) => void (m['materialModels'] = 'x'), /materialModels must be an array/);
    fails((m) => void (m['constitutiveSets'] = {}), /constitutiveSets must be an array/);
    fails((m) => void models(m).push(models(m)[0]!), /duplicate material model id/);
    fails((m) => void (sets(m)[0]!['id'] = 3), /constitutiveSets\[0\]/);
    fails((m) => {
      const first = models(m)[0]!;
      first['model'] = { kind: 'elastic_isotropic', E: { value: 250, unit: 'GPa' }, nu: { value: 0.5, unit: '1' } };
    }, /parametersSha256/);
    fails((m) => void (models(m)[0]!['validity'] = [{ variable: 'T', unit: 'K', data: [5, 1] }]), /PROP_RANGE_INVALID/);
    fails((m) => void (m['defaultConstitutiveSet'] = 7), /defaultConstitutiveSet/);
    fails((m) => {
      const invalid = { kind: 'elastic_isotropic', E: { value: 250, unit: 'GPa' }, nu: { value: 0.5, unit: '1' } } as const;
      Object.assign(models(m)[0]!, { model: invalid, parametersSha256: lawHash(invalid) });
    }, /MATL_POISSON_BOUND/);
    expect(() => deserializeDocument(text)).not.toThrow();
  });

  it('survives a command replay of its history', () => {
    const replayed = execute(document, 'replay_history', {});
    expect(replayed.rejected).toBeUndefined();
    expect(replayed.document.materials['nl1_steel']?.materialModels?.map((m) => m.parametersSha256)).toEqual(
      document.materials['nl1_steel']?.materialModels?.map((m) => m.parametersSha256),
    );
  });
});
