import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { evaluateForm } from '@core/model/propertyForms';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { formHash } from '@core/commands/document/propertyModels';
import { oracle, run } from './fixtures';

const SRC = { citation: 'test input of VC-EOP-02 (not a property claim)' };
/** rho20 = 100 % IACS, alphaR = 0.00393 /K (VC-EOP-02 test inputs), T in degC. */
const LINEAR = { kind: 'linearCoefficient', variable: 'T', referenceValue: 1.7241e-8, coefficient: 0.00393, reference: 20 };

const rhoModel = (
  form: Record<string, unknown>,
  validity: [number, number] = [-55, 150],
  property = 'electricalResistivity',
): Record<string, unknown> => ({
  id: 'rho.lin',
  property,
  unit: property === 'electricalResistivity' ? 'ohm*m' : '1',
  variables: [{ variable: 'T', unit: 'degC' }],
  form,
  validity: [{ variable: 'T', unit: 'degC', data: validity }],
  basis: 'company',
  ...(property === 'emissivityIr' ? { condition: { opticalKind: 'hemispherical_total' } } : {}),
  source: SRC,
});

const withMaterial = (): CadDocument =>
  run(createEmptyDocument(), 'create_material', { name: 'cu', density: 8960, color: '#b87333', metalness: 1, roughness: 0.3 });

const define = (doc: CadDocument, model: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(doc, 'define_property_model', { material: 'cu', model });

const resistance = (doc: CadDocument, temperature?: number): Record<string, unknown> =>
  execute(doc, 'electrical_resistance', {
    material: 'cu',
    length: { value: 1, unit: 'm' },
    crossSection: { value: 1, unit: 'mm^2' },
    ...(temperature === undefined ? {} : { temperature: { value: temperature, unit: 'degC' } }),
  }).data as Record<string, unknown>;

const rel = (actual: unknown, expected: number): number => Math.abs((actual as number) - expected) / Math.abs(expected);

describe('linearCoefficient property form (TR-EOP-11)', () => {
  it('evaluates referenceValue (1 + coefficient (x - reference)) and its slope', () => {
    const at75 = evaluateForm(LINEAR as never, { T: 75 }, 'T');
    expect(at75).toMatchObject({ derivative: 1.7241e-8 * 0.00393 });
    expect(rel((at75 as { value: number }).value, 1.7241e-8 * (1 + 0.00393 * 55))).toBeLessThan(1e-15);
    expect(evaluateForm(LINEAR as never, { T: 20 })).toEqual({ value: 1.7241e-8 });
    expect(evaluateForm(LINEAR as never, { T: 20 }, 'strainRate')).toEqual({ value: 1.7241e-8, derivative: 0 });
    expect(evaluateForm(LINEAR as never, {})).toMatchObject({ code: 'PROP_VARIABLE_MISSING' });
  });

  it('electrical_resistance reads rho(T) at 20 and 75 degC (VC-EOP-02.a, .b) and names the linear model', () => {
    const doc = run(withMaterial(), 'define_property_model', { material: 'cu', model: rhoModel(LINEAR) });
    const at20 = resistance(doc, 20);
    const at75 = resistance(doc, 75);
    expect(rel(at20['dcOhm'], oracle('VC-EOP-02.a'))).toBeLessThan(1e-9);
    expect(rel(at75['dcOhm'], oracle('VC-EOP-02.b'))).toBeLessThan(1e-9);
    expect(at75['temperatureModel']).toBe('linear temperature coefficient rho0 (1 + alpha (T - T0)) at 75 degC');
  });

  it('a strap with a linear model is evaluated at the path temperature in check_bonding', () => {
    let doc = run(withMaterial(), 'define_property_model', { material: 'cu', model: rhoModel(LINEAR) });
    doc = run(doc, 'add_box', { size: [1, 1, 1] });
    doc = run(doc, 'add_box', { size: [1, 1, 1], position: [5, 0, 0] });
    const [a, b] = doc.order;
    doc = run(doc, 'define_bond_path', {
      name: 'hot strap',
      from: a,
      to: b,
      elements: [{ kind: 'strap', material: 'cu', length: { value: 1, unit: 'm' }, crossSection: { value: 1, unit: 'mm^2' } }],
      temperature: { value: 75, unit: 'degC' },
    });
    const rows = (execute(doc, 'check_bonding', {}).data as { rows: { totalOhm: number; elements: { provenance: string }[] }[] }).rows;
    expect(rel(rows[0]?.totalOhm, oracle('VC-EOP-02.b'))).toBeLessThan(1e-9);
    expect(rows[0]?.elements[0]?.provenance).toContain('linear temperature coefficient');
  });

  it('a constant model reports temperatureModel none', () => {
    const doc = run(withMaterial(), 'define_property_model', {
      material: 'cu',
      model: { ...rhoModel({ kind: 'constant', value: 1.7241e-8 }), variables: [], validity: [] },
    });
    expect(resistance(doc)['temperatureModel']).toBe('none (constant model)');
  });

  it('refuses a temperature outside the validity range (never extrapolates)', () => {
    const doc = run(withMaterial(), 'define_property_model', { material: 'cu', model: rhoModel(LINEAR) });
    const result = execute(doc, 'electrical_resistance', {
      material: 'cu',
      length: { value: 1, unit: 'm' },
      crossSection: { value: 1, unit: 'mm^2' },
      temperature: { value: 400, unit: 'degC' },
    });
    expect(result.error?.code).toBe('EOP_RESISTIVITY_UNAVAILABLE');
    expect(result.summary).toContain('PROP_OUT_OF_RANGE');
  });

  it('refuses a model whose rho goes non-positive inside its valid range', () => {
    const doc = withMaterial();
    const negative = define(doc, rhoModel({ ...LINEAR, coefficient: 0.01 }, [-150, 150]));
    expect(negative.error?.code).toBe('PROP_NONPOSITIVE_IN_RANGE');
    expect(negative.document).toBe(doc);
  });

  it('refuses a bounded property that leaves its catalogue range at a validity bound', () => {
    const result = define(
      withMaterial(),
      rhoModel(
        { kind: 'linearCoefficient', variable: 'T', referenceValue: 0.9, coefficient: 0.001, reference: 20 },
        [-55, 150],
        'emissivityIr',
      ),
    );
    expect(result.error?.code).toBe('EOP_PROPERTY_RANGE');
  });

  it('refuses a form with a missing field, and a variable not listed', () => {
    const doc = withMaterial();
    expect(define(doc, rhoModel({ kind: 'linearCoefficient', variable: 'T', referenceValue: 1e-8, reference: 20 })).error?.code).toBe(
      'PROP_FORM_INVALID',
    );
    expect(define(doc, { ...rhoModel(LINEAR), variables: [], validity: [] }).error?.code).toBe('PROP_FORM_INVALID');
  });

  it('round-trips through save / load, and a tampered stored form is refused at load', () => {
    const doc = run(withMaterial(), 'define_property_model', { material: 'cu', model: rhoModel(LINEAR) });
    const json = serializeDocument(doc);
    const loaded = execute(createEmptyDocument(), 'load_document', { json });
    expect(loaded.error).toBeUndefined();
    expect(resistance(loaded.document, 75)['dcOhm']).toBeCloseTo(oracle('VC-EOP-02.b'), 12);
    const tampered = json.replace('"coefficient":0.00393', '"coefficient":"fast"');
    expect(tampered).not.toBe(json);
    const refused = execute(createEmptyDocument(), 'load_document', { json: tampered });
    expect(refused.affected).toEqual([]);
  });

  it('load refuses a stored model whose rho goes negative in range even with a matching hash', () => {
    const doc = run(withMaterial(), 'define_property_model', { material: 'cu', model: rhoModel(LINEAR) });
    const saved = JSON.parse(serializeDocument(doc)) as {
      document: { materials: Record<string, { propertyModels: { form: Record<string, unknown>; coefficientsSha256: string }[] }> };
    };
    const stored = saved.document.materials['cu']?.propertyModels[0];
    if (stored === undefined) throw new Error('no stored model');
    stored.form['coefficient'] = -1;
    stored.coefficientsSha256 = formHash(stored.form as never);
    const refused = execute(createEmptyDocument(), 'load_document', { json: JSON.stringify(saved) });
    expect(refused.affected).toEqual([]);
    expect(refused.summary).toContain('PROP_NONPOSITIVE_IN_RANGE');
  });

  it('checks the bounds in the variable unit when the validity is in another unit, over the equation range', () => {
    const doc = withMaterial();
    const kelvin = {
      ...rhoModel({ ...LINEAR, coefficient: 0.006 }),
      validity: [{ variable: 'T', unit: 'K', data: [218.15, 423.15], equation: [100, 423.15] }],
    };
    expect(define(doc, kelvin).error?.code).toBe('PROP_NONPOSITIVE_IN_RANGE');
    const narrow = { ...kelvin, validity: [{ variable: 'T', unit: 'K', data: [218.15, 423.15] }] };
    expect(define(doc, narrow).error).toBeUndefined();
  });

  it('names another T-dependent form as a PHY-01 model, with its temperature', () => {
    const doc = run(withMaterial(), 'define_property_model', {
      material: 'cu',
      model: rhoModel({ kind: 'polynomial', variable: 'T', coefficients: [1.7241e-8, 6.7757e-11], origin: 20 }),
    });
    expect(resistance(doc, 75)['temperatureModel']).toBe('PHY-01 polynomial model at 75 degC');
  });

  it('names a temperature-free composite form without a temperature', () => {
    const doc = run(withMaterial(), 'define_property_model', {
      material: 'cu',
      model: { ...rhoModel({ kind: 'product', factors: [{ kind: 'constant', value: 1.7241e-8 }] }), variables: [], validity: [] },
    });
    expect(resistance(doc)['temperatureModel']).toBe('PHY-01 product model');
  });
});
