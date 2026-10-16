import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { Material } from '@core/model/types';
import { caseTemperatureRange, partMaterials, propertiesNeeded, propertyTable, type PropertyRequest } from '@cae/thermal/material';
import { enthalpyFunction } from '@cae/thermal/storedEnergy';
import { addBc, caseOf, must, thermalFixture } from './fixtures';

const SOURCE = { citation: 'synthetic model for the tabulation tests' };
const base = (material: Material, property: PropertyRequest['property'], extra: Partial<PropertyRequest> = {}): PropertyRequest => ({
  materialName: 'steel',
  material,
  documentUnit: 'm',
  property,
  scale: 'degC',
  unitSystem: 'N-m-kg-s',
  required: [20, 80],
  ...extra,
});

function materialWith(model: Record<string, unknown>): Material {
  const doc = must(thermalFixture({ k: null, cp: null, density: null }).doc, 'define_property_model', {
    material: 'steel',
    model: { variables: [{ variable: 'T', unit: 'K' }], source: SOURCE, basis: 'company', ...model },
  }).document;
  return doc.materials['steel'] as Material;
}

const quadratic = (id = 'k_quad'): Record<string, unknown> => ({
  id,
  property: 'k',
  unit: 'W/(m*K)',
  validity: [{ variable: 'T', unit: 'K', data: [200, 600] }],
  form: { kind: 'polynomial', variable: 'T', coefficients: [5, 0.1, 0.0005], origin: 0 },
});

describe('propertyTable', () => {
  it('tabulates a nonlinear k(T) in K on the degC case scale to the named relative tolerance, +- 50 K margin', () => {
    const table = propertyTable(base(materialWith(quadratic()), 'k'));
    if ('code' in table) throw new Error(table.message);
    expect(table.range).toEqual([-30, 130]);
    expect(table.points.length).toBeGreaterThan(3);
    expect(table.maxRelError).toBeLessThanOrEqual(1e-3);
    const exact = (t: number): number => 5 + 0.1 * (t + 273.15) + 0.0005 * (t + 273.15) ** 2;
    for (const [temperature, value] of table.points) expect(value).toBeCloseTo(exact(temperature), 9);
    const [first, last] = [table.points[0], table.points[table.points.length - 1]];
    expect([first?.[0], last?.[0]]).toEqual([-30, 130]);
    expect(table.modelId).toBe('k_quad');
    expect(table.coefficientsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(table.unverifiedReasons).toEqual([]);
    const between = (t: number): number => {
      const upper = table.points.findIndex(([x]) => x >= t);
      const [x0 = 0, y0 = 0] = table.points[upper - 1] ?? [];
      const [x1 = 0, y1 = 0] = table.points[upper] ?? [];
      return y0 + ((y1 - y0) * (t - x0)) / (x1 - x0);
    };
    for (const t of [-10, 12.5, 33, 77, 120]) expect(Math.abs(between(t) - exact(t)) / exact(t)).toBeLessThan(1.1e-3);
  });

  it('clamps the margin to the model equation range and uses the data range when the case names no temperature', () => {
    const material = materialWith({
      ...quadratic(),
      validity: [{ variable: 'T', unit: 'K', data: [280, 340], equation: [273.15, 353.15] }],
    });
    const clamped = propertyTable(base(material, 'k'));
    if ('code' in clamped) throw new Error(clamped.message);
    expect(clamped.range?.[0]).toBeCloseTo(0, 9);
    expect(clamped.range?.[1]).toBeCloseTo(80, 9);
    const fromData = propertyTable(base(material, 'k', { required: null }));
    if ('code' in fromData) throw new Error(fromData.message);
    expect(fromData.range?.[0]).toBeCloseTo(6.85, 9);
    expect(fromData.range?.[1]).toBeCloseTo(66.85, 9);
  });

  it('converts to the unit system: N-mm-t-s conductivity, specific heat 1e6, density 1e-12', () => {
    const doc = must(thermalFixture({ k: 15, cp: 500, density: 8000 }).doc, 'set_units', { units: 'mm' }).document;
    const material = doc.materials['steel'] as Material;
    const request = (property: PropertyRequest['property']): PropertyRequest =>
      base(material, property, { unitSystem: 'N-mm-t-s', documentUnit: 'mm' });
    expect(propertyTable(request('k'))).toMatchObject({ constant: 15, range: null, points: [] });
    expect(propertyTable(request('cp'))).toMatchObject({ constant: 5e8 });
    const density = propertyTable(request('density'));
    expect('code' in density ? Number.NaN : (density.constant ?? 0) / 8e-9).toBeCloseTo(1, 12);
  });

  it('refuses a missing property, ambiguous candidates, other variables, a range outside the model and oversized tables', () => {
    const noModels = propertyTable(base({ name: 'steel', density: 0, color: '#fff', metalness: 0, roughness: 0 }, 'cp'));
    expect(noModels).toMatchObject({ code: 'THM_MATERIAL_NO_CP' });
    expect(propertyTable(base({ name: 'steel', density: 0, color: '#fff', metalness: 0, roughness: 0 }, 'k'))).toMatchObject({
      code: 'THM_MATERIAL_NO_K',
    });
    const twoK = materialWith(quadratic('a'));
    const both = { ...twoK, propertyModels: [...(twoK.propertyModels ?? []), { ...(twoK.propertyModels ?? [])[0]!, id: 'b' }] } as Material;
    expect(propertyTable(base(both, 'k'))).toMatchObject({ code: 'PROP_NO_MODEL_FOR_PROPERTY' });
    const pressure = materialWith({
      id: 'k_p',
      property: 'k',
      unit: 'W/(m*K)',
      variables: [{ variable: 'pressure', unit: 'Pa' }],
      validity: [{ variable: 'pressure', unit: 'Pa', data: [1, 10] }],
      form: { kind: 'powerLaw', variable: 'pressure', coefficient: 1, exponent: 1, reference: 1 },
    });
    expect(propertyTable(base(pressure, 'k'))).toMatchObject({ code: 'PROP_VARIABLE_MISSING' });
    expect(propertyTable(base(materialWith(quadratic()), 'k', { required: [20, 400] }))).toMatchObject({ code: 'PROP_OUT_OF_RANGE' });
    const points = Array.from({ length: 700 }, (_, i) => [200 + i, 10 + (i % 2) * 5]);
    const jagged = materialWith({
      id: 'k_jagged',
      property: 'k',
      unit: 'W/(m*K)',
      validity: [{ variable: 'T', unit: 'K', data: [200, 899] }],
      form: { kind: 'table1d', variable: 'T', points, interpolation: 'step' },
    });
    expect(propertyTable(base(jagged, 'k', { required: [-50, 500] }))).toMatchObject({ code: 'THM_TABLE_POINTS' });
  });

  it('reports unverified bases and evaluation outside the data range', () => {
    const unverified = materialWith({
      ...quadratic(),
      basis: 'typical',
      validity: [{ variable: 'T', unit: 'K', data: [300, 330], equation: [200, 600] }],
    });
    const flagged = propertyTable(base(unverified, 'k'));
    if ('code' in flagged) throw new Error(flagged.message);
    expect(flagged.unverifiedReasons).toEqual(['basis typical', 'outside data range']);
  });
});

describe('case helpers', () => {
  it('caseTemperatureRange spans the initial temperature, prescribed temperatures and film sinks with their amplitude extremes', () => {
    const fixture = thermalFixture({ type: 'heat_transient' });
    const amp = must(fixture.doc, 'define_amplitude', {
      analysisId: fixture.analysisId,
      name: 'a',
      kind: 'table',
      points: [
        [0, -1],
        [10, 0.5],
      ],
    });
    const given = { ...fixture, doc: amp.document };
    expect(caseTemperatureRange(caseOf(given.doc, given.analysisId).thermal!)).toBeNull();
    const t = addBc(given, {
      name: 'T',
      kind: 'temperature',
      value: 100,
      unit: 'degC',
      amplitude: 'a',
      target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
    });
    const film = addBc(
      { ...given, doc: t.doc },
      {
        name: 'f',
        kind: 'film',
        filmCoefficient: { value: 10, unit: 'W/(m^2*K)' },
        sinkTemperature: { value: 300, unit: 'K' },
        source: SOURCE,
        target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
      },
    );
    const rad = addBc(
      { ...given, doc: film.doc },
      {
        name: 'r',
        kind: 'radiation',
        emissivity: 1,
        sinkTemperature: { value: 3, unit: 'K' },
        source: SOURCE,
        target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
      },
    );
    const started = execute(rad.doc, 'set_initial_temperature', { analysisId: given.analysisId, value: 20, unit: 'degC' }).document;
    const range = caseTemperatureRange(caseOf(started, given.analysisId).thermal!);
    expect(range?.[0]).toBeCloseTo(-100, 9);
    expect(range?.[1]).toBeCloseTo(50, 9);
    const doc = started;
    expect(partMaterials(doc, caseOf(doc, given.analysisId)).map((part) => [part.entityId, part.materialId])).toEqual([
      [fixture.boxId, 'steel'],
    ]);
    expect(propertiesNeeded(caseOf(doc, given.analysisId))).toEqual(['k', 'cp', 'density']);
    expect(propertiesNeeded(caseOf(thermalFixture().doc, thermalFixture().analysisId))).toEqual(['k']);
  });

  it('enthalpyFunction integrates rho * cp(T) exactly over piecewise-linear tables and holds the end values outside', () => {
    const constant = (value: number): Parameters<typeof enthalpyFunction>[0] => ({
      property: 'density',
      origin: '',
      modelId: null,
      coefficientsSha256: null,
      maxRelError: 0,
      constant: value,
      points: [],
      range: null,
      unverifiedReasons: [],
    });
    const table = (points: [number, number][]): Parameters<typeof enthalpyFunction>[1] => ({
      ...constant(0),
      property: 'cp',
      constant: null,
      points,
      range: [0, 100],
    });
    expect(enthalpyFunction(constant(2), constant(3))(10)).toBe(60);
    const enthalpy = enthalpyFunction(
      constant(2),
      table([
        [0, 10],
        [100, 20],
      ]),
    );
    // cp = 10 + 0.1 T: integral 0..50 = 500 + 125 = 625; times rho 2
    expect(enthalpy(50)).toBeCloseTo(1250, 9);
    expect(enthalpy(0)).toBe(0);
    expect(enthalpy(-10)).toBeCloseTo(-200, 9);
    expect(enthalpy(110)).toBeCloseTo(2 * 1500 + 2 * 20 * 10, 9);
    const product = enthalpyFunction(
      table([
        [0, 1],
        [10, 3],
      ]),
      table([
        [0, 4],
        [10, 2],
      ]),
    );
    // rho = 1 + 0.2 T, cp = 4 - 0.2 T: product 4 + 0.6 T - 0.04 T^2; integral 0..10 = 40 + 30 - 13.333
    expect(product(10)).toBeCloseTo(40 + 30 - 40 / 3, 9);
    expect(product(5)).toBeCloseTo(20 + 7.5 - (0.04 * 125) / 3, 9);
  });
});
