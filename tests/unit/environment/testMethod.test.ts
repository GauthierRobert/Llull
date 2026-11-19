/** MOI-b: the `testMethod` qualifier of a stored property value (PHY-01 condition) and ENV_TEST_METHOD_MISMATCH (FR-ENV-01, 03; OQ-ENV-02). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { emptyMm, run, withPanel } from './fixtures';
import { libraryFile } from '../materials/support';

interface Item {
  material: string;
  quantity: string;
  status: string;
  value: number | null;
  derived: boolean;
  fingerprint: string;
  testMethod?: string;
  methodMismatch?: true;
}
interface Check {
  status: string;
  items: Item[];
  findings: { code: string; severity: string; message: string }[];
}

const source = { citation: 'synthetic test value (PHY-14 validation pack)' };

function withMethodMaterial(doc: CadDocument, name: string, values: Record<string, number>, testMethod?: string): CadDocument {
  let next = run(doc, 'create_material', { name, density: 0.0012, color: '#d9a441', metalness: 0, roughness: 0.6 }).document;
  for (const [property, value] of Object.entries(values))
    next = run(next, 'set_material_property', {
      material: name,
      property,
      value,
      unit: '%',
      basis: 'company',
      source,
      ...(testMethod === undefined ? {} : { testMethod }),
    }).document;
  return next;
}

const check = (doc: CadDocument, profile: string): Check => execute(doc, 'check_space_environment', { profile }).data as Check;
const item = (data: Check, quantity: string): Item | undefined => data.items.find((entry) => entry.quantity === quantity);

/** The saved `text` with every stored model condition's testMethod replaced by `value` (step params untouched). */
function withStoredMethod(text: string, value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== 'object' || node === null) return node;
    const entries = Object.entries(node).map(([key, child]): [string, unknown] =>
      key === 'condition' && typeof child === 'object' && child !== null && 'testMethod' in child
        ? [key, { ...child, testMethod: value }]
        : [key, walk(child)],
    );
    return Object.fromEntries(entries);
  };
  return JSON.stringify(walk(JSON.parse(text)));
}

/** A 200 g panel of material `name` with E595 data (TML 0.95, CVCM 0.05, WVR 0.3 %) measured with `testMethod`. */
const e595Panel = (testMethod?: string): CadDocument =>
  withPanel(withMethodMaterial(emptyMm(), 'adhesive', { TML: 0.95, CVCM: 0.05, WVR: 0.3 }, testMethod), 'adhesive').document;

describe('testMethod on a stored value (set_material_property, define_property_model, load)', () => {
  it('stores the method in the model condition, keys the id on it and returns it from evaluate_property', () => {
    const doc = e595Panel('ASTM_E595');
    const models = doc.materials['adhesive']?.propertyModels ?? [];
    const tml = models.find((model) => model.property === 'TML');
    expect(tml?.condition).toEqual({ testMethod: 'ASTM_E595' });
    expect(tml?.id).toBe('TML.company.ASTM_E595');
    const evaluated = execute(doc, 'evaluate_property', { material: 'adhesive', property: 'TML', at: {}, outputUnit: '%' });
    expect(evaluated.data).toMatchObject({ available: true, value: 0.95, testMethod: 'ASTM_E595' });
    const unqualified = withMethodMaterial(emptyMm(), 'plain', { TML: 0.5 });
    const plain = execute(unqualified, 'evaluate_property', { material: 'plain', property: 'TML', at: {}, outputUnit: '%' });
    expect(plain.data).not.toHaveProperty('testMethod');
    expect(unqualified.materials['plain']?.propertyModels?.[0]?.condition).toBeUndefined();
  });

  it('refuses a method that is not a token, with the path, and leaves the document unchanged', () => {
    const doc = withMethodMaterial(emptyMm(), 'adhesive', {});
    for (const bad of ['', 'ASTM E595', '-x', 'x'.repeat(65), '<b>']) {
      const result = execute(doc, 'set_material_property', {
        material: 'adhesive',
        property: 'TML',
        value: 0.5,
        unit: '%',
        basis: 'company',
        source,
        testMethod: bad,
      });
      expect(result.error?.code).toBe('PROP_FORM_INVALID');
      expect(result.error?.paths).toEqual(['condition.testMethod']);
      expect(result.document).toBe(doc);
    }
  });

  it('define_property_model accepts condition.testMethod and refuses a non-token one', () => {
    const doc = withMethodMaterial(emptyMm(), 'adhesive', {});
    const model = (testMethod: unknown): Record<string, unknown> => ({
      id: 'cvcm-ecss',
      property: 'CVCM',
      unit: '%',
      variables: [],
      form: { kind: 'constant', value: 0.02 },
      validity: [],
      basis: 'company',
      condition: { testMethod },
      source,
    });
    const defined = execute(doc, 'define_property_model', { material: 'adhesive', model: model('ECSS_Q_ST_70_02') });
    expect(defined.error).toBeUndefined();
    expect(defined.document.materials['adhesive']?.propertyModels?.[0]?.condition).toEqual({ testMethod: 'ECSS_Q_ST_70_02' });
    const refused = execute(doc, 'define_property_model', { material: 'adhesive', model: model('two words') });
    expect(refused.error?.code).toBe('PROP_FORM_INVALID');
    expect(refused.document).toBe(doc);
  });

  it('round-trips the method through save / load, and a hostile stored method is refused on load (hostile-load corpus entry)', () => {
    const doc = e595Panel('ASTM_E595');
    const text = serializeDocument(doc);
    const loaded = deserializeDocument(text);
    expect(loaded.materials['adhesive']?.propertyModels?.find((model) => model.property === 'TML')?.condition).toEqual({
      testMethod: 'ASTM_E595',
    });
    const hostile: readonly unknown[] = [5, null, { toString: 'x' }, 'x'.repeat(100000), '__proto__ ', ['ASTM_E595']];
    for (const value of hostile) {
      const tampered = withStoredMethod(text, value);
      expect(tampered).not.toBe(text);
      expect(() => deserializeDocument(tampered)).toThrow(/testMethod/);
      const result = execute(doc, 'load_document', { json: tampered });
      expect(result.document).toBe(doc);
      expect(result.summary).toContain('testMethod');
    }
  });
});

describe('check_space_environment: ENV_TEST_METHOD_MISMATCH (OQ-ENV-02)', () => {
  it('E595 data judged by the ECSS profile: computed anyway (RML derived), each item flagged, one warning per material', () => {
    const data = check(e595Panel('ASTM_E595'), 'ecss_q_st_70_02');
    expect(item(data, 'RML')).toMatchObject({ derived: true, testMethod: 'ASTM_E595', methodMismatch: true, status: 'pass' });
    expect(item(data, 'RML')?.value).toBeCloseTo(0.65, 12);
    expect(item(data, 'CVCM')).toMatchObject({ testMethod: 'ASTM_E595', methodMismatch: true });
    const warnings = data.findings.filter((finding) => finding.code === 'ENV_TEST_METHOD_MISMATCH');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe('warning');
    expect(warnings[0]?.message).toContain('ECSS_Q_ST_70_02');
    expect(data.status).toBe('pass');
  });

  it('E595 data under the NASA (E595) profile has the method and no mismatch; unrecorded methods are not flagged', () => {
    const nasa = check(e595Panel('ASTM_E595'), 'nasa_gsfc_screening');
    expect(item(nasa, 'TML')).toMatchObject({ testMethod: 'ASTM_E595' });
    expect(nasa.items.some((entry) => entry.methodMismatch === true)).toBe(false);
    expect(nasa.findings.some((finding) => finding.code === 'ENV_TEST_METHOD_MISMATCH')).toBe(false);
    const unrecorded = check(e595Panel(), 'ecss_q_st_70_02');
    expect(unrecorded.items.every((entry) => entry.testMethod === undefined && entry.methodMismatch === undefined)).toBe(true);
    expect(unrecorded.findings.some((finding) => finding.code === 'ENV_TEST_METHOD_MISMATCH')).toBe(false);
  });

  it("prefers the value measured with the profile's method when the material holds both (no preferred flag needed)", () => {
    let doc = withMethodMaterial(emptyMm(), 'adhesive', { TML: 0.95, CVCM: 0.05 }, 'ASTM_E595');
    doc = run(doc, 'set_material_property', {
      material: 'adhesive',
      property: 'CVCM',
      value: 0.2,
      unit: '%',
      basis: 'company',
      source,
      testMethod: 'ECSS_Q_ST_70_02',
    }).document;
    doc = withPanel(doc, 'adhesive').document;
    const nasa = check(doc, 'nasa_gsfc_screening');
    expect(item(nasa, 'CVCM')).toMatchObject({ value: 0.05, status: 'pass', testMethod: 'ASTM_E595' });
    const ecss = check(doc, 'ecss_q_st_70_02');
    expect(item(ecss, 'CVCM')).toMatchObject({ value: 0.2, status: 'fail', testMethod: 'ECSS_Q_ST_70_02' });
    expect(item(ecss, 'CVCM')?.methodMismatch).toBeUndefined();
  });

  it('the method is part of the finding fingerprint only when recorded: an unqualified item keeps the fingerprint of the base build', () => {
    /** sha256 computed on the commit before MOI-b (00eac362a) for the same panel: earlier deviations keep applying. */
    const BASE_TML_FINGERPRINT = '7880c036bf5a052cccd70bf1aadeec82196a055dea4e9f24f13217118bc4382f';
    expect(item(check(e595Panel(), 'nasa_gsfc_screening'), 'TML')?.fingerprint).toBe(BASE_TML_FINGERPRINT);
    expect(item(check(e595Panel('ASTM_E595'), 'nasa_gsfc_screening'), 'TML')?.fingerprint).not.toBe(BASE_TML_FINGERPRINT);
  });

  it('an ambiguous read of the profile method is unknown with the reason, never replaced by a preferred value of another method', () => {
    let doc = withMethodMaterial(emptyMm(), 'adhesive', { CVCM: 0.05 }, 'ASTM_E595');
    const tml = (value: number, testMethod: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      material: 'adhesive',
      property: 'TML',
      value,
      unit: '%',
      basis: 'company',
      source,
      testMethod,
      ...extra,
    });
    doc = run(doc, 'set_material_property', tml(0.5, 'ASTM_E595')).document;
    doc = run(doc, 'set_material_property', tml(0.7, 'ASTM_E595')).document;
    doc = run(doc, 'set_material_property', tml(0.3, 'ECSS_Q_ST_70_02', { preferred: true })).document;
    doc = withPanel(doc, 'adhesive').document;
    const data = check(doc, 'nasa_gsfc_screening');
    const tmlItem = data.items.find((entry) => entry.quantity === 'TML') as (Item & { code?: string; valueSource?: string }) | undefined;
    expect(tmlItem).toMatchObject({ status: 'unknown', value: null, code: 'ENV_OUTGASSING_DATA_MISSING' });
    expect((tmlItem as { valueSource?: string } | undefined)?.valueSource).toContain('ASTM_E595 value');
    expect((tmlItem as { valueSource?: string } | undefined)?.valueSource).toContain('none is preferred');
    expect(data.findings.some((finding) => finding.code === 'ENV_TEST_METHOD_MISMATCH')).toBe(false);
    expect(data.status).toBe('unknown');
  });

  it('an ambiguous profile-method RML is not derived from TML - WVR', () => {
    let doc = withMethodMaterial(emptyMm(), 'adhesive', { TML: 0.9, CVCM: 0.05, WVR: 0.3 }, 'ECSS_Q_ST_70_02');
    for (const value of [0.5, 0.6])
      doc = run(doc, 'set_material_property', {
        material: 'adhesive',
        property: 'RML',
        value,
        unit: '%',
        basis: 'company',
        source,
        testMethod: 'ECSS_Q_ST_70_02',
      }).document;
    const data = check(withPanel(doc, 'adhesive').document, 'ecss_q_st_70_02');
    expect(item(data, 'RML')).toMatchObject({ status: 'unknown', derived: false, value: null });
  });

  it('values without a recorded method give one ENV_TEST_METHOD_UNRECORDED info per material, outside the status and the fingerprint', () => {
    const data = check(e595Panel(), 'nasa_gsfc_screening');
    const unrecorded = data.findings.filter((finding) => finding.code === 'ENV_TEST_METHOD_UNRECORDED');
    expect(unrecorded).toHaveLength(1);
    expect(unrecorded[0]?.severity).toBe('info');
    expect(unrecorded[0]?.message).toBe('adhesive: TML, CVCM: no test method recorded; confirm it was ASTM_E595');
    expect(data.status).toBe('pass');
    expect(check(e595Panel('ASTM_E595'), 'nasa_gsfc_screening').findings.some((f) => f.code === 'ENV_TEST_METHOD_UNRECORDED')).toBe(false);
  });
});

describe('material library conditions (import_material_library)', () => {
  const withCondition = (condition: Record<string, unknown>): Record<string, unknown> => {
    const file = libraryFile();
    const [material] = file['materials'] as Record<string, unknown>[];
    const [first, ...rest] = (material?.['propertyModels'] ?? []) as Record<string, unknown>[];
    return { ...file, materials: [{ ...material, propertyModels: [{ ...first, condition }, ...rest] }] };
  };

  it('accepts every PropertyCondition field, testMethod included', () => {
    const condition = { testMethod: 'ASTM_E595', thickness: { min: 0.5, max: 1, unit: 'mm' }, edOverD: 2, exposureHours: 10, rrr: 50 };
    expect(execute(emptyMm(), 'import_material_library', { library: withCondition(condition) }).error).toBeUndefined();
  });

  it('refuses an unknown condition key and a non-token testMethod (document unchanged)', () => {
    const doc = emptyMm();
    for (const condition of [{ freeText: 'x' }, { testMethod: 'two words' }, { testMethod: 5 }]) {
      const result = execute(doc, 'import_material_library', { library: withCondition(condition) });
      expect(result.error).toBeDefined();
      expect(result.document).toBe(doc);
    }
  });
});
