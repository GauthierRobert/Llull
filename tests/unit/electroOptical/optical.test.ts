import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { STEFAN_BOLTZMANN, bulkResistance, equilibriumTemperature } from '@cae/electroOptical/physics';
import { expected, oracle, run, runPlan } from './fixtures';

const SRC = { citation: 'test input (not a property claim)' };
const FLUX = { value: 1361, unit: 'W/m^2' };

interface Balance {
  alpha: number;
  eps: number;
  alphaOverEps: number;
  temperatureK: number;
  temperatureDegC: number;
  solarFluxW_m2: number;
  incidenceAngleDeg: number;
  radiatingFaces: number;
  state: string;
  sigma: { value: number; defaulted: boolean };
  provenance: string[];
  unverified: boolean;
  unverifiedReasons: string[];
  reviewRequired: boolean;
}

const balance = (doc: CadDocument, params: Record<string, unknown>): CommandResult => execute(doc, 'optical_balance', params);
const data = (doc: CadDocument, params: Record<string, unknown>): Balance => balance(doc, params).data as Balance;

const model = (
  id: string,
  property: string,
  form: unknown,
  condition: Record<string, string>,
  basis = 'company',
  variables: unknown[] = [],
): Record<string, unknown> => ({
  id,
  property,
  unit: '1',
  variables,
  form,
  validity: variables.length === 0 ? [] : [{ variable: 'T', unit: 'K', data: [150, 500] }],
  basis,
  condition,
  source: SRC,
  preferred: true,
});

describe('physics: closed forms', () => {
  it('sigma from the exact SI constants equals the generator value', () => {
    expect(Math.abs(STEFAN_BOLTZMANN - expected.constants['sigma_SB_W_m2K4']!) / STEFAN_BOLTZMANN).toBeLessThan(1e-12);
  });

  it('equilibrium temperature matches the generator for one and two faces (VC-EOP-08)', () => {
    expect(equilibriumTemperature(0.2, 1361, 0, 0.9, 1)).toBeCloseTo(oracle('VC-EOP-08.a'), 6);
    expect(equilibriumTemperature(0.2, 1361, 0, 0.9, 2)).toBeCloseTo(oracle('VC-EOP-08.b'), 6);
  });

  it('R = rho L / A matches VC-EOP-02', () => {
    expect(bulkResistance(1.7241e-8, 1, 1e-6)).toBeCloseTo(oracle('VC-EOP-02.a'), 12);
  });
});

describe('optical_balance: the validation plan (AC-4, VC-EOP-08)', () => {
  const { doc, aliases } = runPlan('eop_radiator_coating.plan.json', 'optical_balance');
  const panel = aliases['panel'] ?? '';

  it('gives 270.2455 K and alpha/eps 0.2222 from the assigned coating, with provenance and the exact sigma', () => {
    const result = data(doc, { entityId: panel, solarFlux: FLUX, radiatingFaces: 1 });
    expect(result.temperatureK).toBeCloseTo(oracle('VC-EOP-08.a'), 6);
    expect(result.temperatureDegC).toBeCloseTo(oracle('VC-EOP-08.a') - 273.15, 6);
    expect(result.alphaOverEps).toBeCloseTo(oracle('VC-EOP-08.c'), 12);
    expect(result).toMatchObject({ alpha: 0.2, eps: 0.9, state: 'BOL', incidenceAngleDeg: 0, solarFluxW_m2: 1361, reviewRequired: true });
    expect(result.sigma).toMatchObject({ value: STEFAN_BOLTZMANN, defaulted: true });
    expect(result.provenance).toHaveLength(2);
    expect(result.provenance[0]).toContain('absorptivitySolar');
    expect(result.unverified).toBe(false);
  });

  it('two radiating faces give 227.2485 K', () => {
    expect(data(doc, { entityId: panel, solarFlux: FLUX, radiatingFaces: 2 }).temperatureK).toBeCloseTo(oracle('VC-EOP-08.b'), 6);
  });

  it('converts the flux unit and applies cos(theta)', () => {
    const wattsPerCm2 = data(doc, { coating: 'white_paint_test', solarFlux: { value: 0.1361, unit: 'W/cm^2' }, radiatingFaces: 1 });
    expect(wattsPerCm2.temperatureK).toBeCloseTo(oracle('VC-EOP-08.a'), 6);
    const tilted = data(doc, {
      coating: 'white_paint_test',
      solarFlux: FLUX,
      radiatingFaces: 1,
      incidenceAngle: { value: 60, unit: 'deg' },
    });
    expect(tilted.temperatureK).toBeCloseTo(oracle('VC-EOP-08.a') * 0.5 ** 0.25, 6);
    expect(tilted.incidenceAngleDeg).toBeCloseTo(60, 9);
  });

  it('selects alpha by life state: an EOL model is used for EOL and BOL is not substituted', () => {
    const eol = run(doc, 'define_property_model', {
      material: 'white_paint_test',
      model: model('abs_eol', 'absorptivitySolar', { kind: 'constant', value: 0.4 }, { lifeState: 'EOL' }),
    });
    expect(data(eol, { entityId: panel, solarFlux: FLUX, radiatingFaces: 1, state: 'EOL' })).toMatchObject({ alpha: 0.4, state: 'EOL' });
    expect(data(eol, { entityId: panel, solarFlux: FLUX, radiatingFaces: 1 }).alpha).toBe(0.2);
    const onlyBol = balance(doc, { entityId: panel, solarFlux: FLUX, radiatingFaces: 1, state: 'EOL' });
    expect(onlyBol.error?.code).toBe('EOP_SURFACE_PROPERTY_MISSING');
    expect(onlyBol.document).toBe(doc);
  });

  it('solves a temperature-dependent emissivity as a fixed point: alpha S = eps(T) sigma T^4', () => {
    const material = run(doc, 'define_material_record', {
      id: 'tcoat',
      designation: 't',
      productForm: 'coating',
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    });
    let withT = run(material, 'define_property_model', {
      material: 'tcoat',
      model: model('a', 'absorptivitySolar', { kind: 'constant', value: 0.3 }, { lifeState: 'BOL' }),
    });
    withT = run(withT, 'define_property_model', {
      material: 'tcoat',
      model: model(
        'e',
        'emissivityIr',
        {
          kind: 'table1d',
          variable: 'T',
          points: [
            [150, 0.7],
            [500, 0.9],
          ],
          interpolation: 'linear',
        },
        { opticalKind: 'hemispherical_total' },
        'company',
        [{ variable: 'T', unit: 'K' }],
      ),
    });
    const result = data(withT, { coating: 'tcoat', solarFlux: FLUX, radiatingFaces: 1 });
    const epsAt = 0.7 + ((result.temperatureK - 150) / 350) * 0.2;
    expect(result.eps).toBeCloseTo(epsAt, 6);
    expect(0.3 * 1361).toBeCloseTo(result.eps * STEFAN_BOLTZMANN * result.temperatureK ** 4, 6);
  });

  it('is pure and read-only', () => {
    const before = structuredClone(doc);
    const result = balance(doc, { entityId: panel, solarFlux: FLUX, radiatingFaces: 1 });
    expect(doc).toEqual(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });
});

describe('optical_balance: never a silent value', () => {
  const { doc, aliases } = runPlan('eop_radiator_coating.plan.json', 'optical_balance');
  const panel = aliases['panel'] ?? '';
  const refuse = (params: Record<string, unknown>, target: CadDocument = doc): string | undefined => {
    const result = balance(target, params);
    expect(result.document).toBe(target);
    expect(result.affected).toEqual([]);
    return result.error?.code;
  };

  it('refuses a missing flux, a non-positive flux and a wrong flux unit', () => {
    expect(refuse({ entityId: panel, radiatingFaces: 1 })).toBe('EOP_SOLAR_FLUX_MISSING');
    expect(refuse({ entityId: panel, solarFlux: { value: 0, unit: 'W/m^2' }, radiatingFaces: 1 })).toBe('EOP_PARAMS_INVALID');
    expect(refuse({ entityId: panel, solarFlux: { value: 1361, unit: 'kg' }, radiatingFaces: 1 })).toBe('EOP_PARAMS_INVALID');
  });

  it('refuses a grazing or non-angle incidence', () => {
    expect(refuse({ entityId: panel, solarFlux: FLUX, radiatingFaces: 1, incidenceAngle: { value: 90, unit: 'deg' } })).toBe(
      'EOP_PARAMS_INVALID',
    );
    expect(refuse({ entityId: panel, solarFlux: FLUX, radiatingFaces: 1, incidenceAngle: { value: 5, unit: 'm' } })).toBe(
      'EOP_PARAMS_INVALID',
    );
  });

  it('refuses when no coating is assigned, none is named, or the material is unknown', () => {
    const other = execute(doc, 'add_box', { size: [1, 1, 1] });
    expect(refuse({ entityId: other.affected[0], solarFlux: FLUX, radiatingFaces: 1 }, other.document)).toBe('EOP_COATING_NOT_ASSIGNED');
    expect(refuse({ solarFlux: FLUX, radiatingFaces: 1 })).toBe('EOP_COATING_NOT_ASSIGNED');
    expect(refuse({ coating: 'ghost', solarFlux: FLUX, radiatingFaces: 1 })).toBe('EOP_COATING_NOT_FOUND');
  });

  it('refuses an entity with two exposed coatings', () => {
    const second = run(
      run(doc, 'define_material_record', {
        id: 'p2',
        designation: 't',
        productForm: 'coating',
        specs: [],
        licence: 'company-proprietary',
        exportMarking: { regime: 'none' },
      }),
      'assign_surface_coating',
      { entityId: panel, coating: 'p2', location: 'bonded_interface' },
    );
    const bad = {
      ...second,
      electroOptical: {
        ...second.electroOptical!,
        coatings: {
          ...second.electroOptical!.coatings,
          'sc-x.1': { id: 'sc-x.1', entityId: panel, coating: 'p2', location: 'exposed' as const, electrical: 'unknown' as const },
        },
      },
    };
    expect(refuse({ entityId: panel, solarFlux: FLUX, radiatingFaces: 1 }, bad)).toBe('EOP_COATING_AMBIGUOUS');
  });

  it('a coating without emissivity or absorptivity is EOP_SURFACE_PROPERTY_MISSING, not a default', () => {
    const empty = run(doc, 'define_material_record', {
      id: 'bare',
      designation: 't',
      productForm: 'coating',
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    });
    expect(refuse({ coating: 'bare', solarFlux: FLUX, radiatingFaces: 1 }, empty)).toBe('EOP_SURFACE_PROPERTY_MISSING');
  });

  it('refuses impossible values in the record or the parameters (EOP_PROPERTY_RANGE)', () => {
    const wild = run(doc, 'define_property_model', {
      material: 'white_paint_test',
      model: model('abs_eol', 'absorptivitySolar', { kind: 'constant', value: 1.4 }, { lifeState: 'EOL' }),
    });
    expect(refuse({ coating: 'white_paint_test', solarFlux: FLUX, radiatingFaces: 1, state: 'EOL' }, wild)).toBe('EOP_PROPERTY_RANGE');
    expect(refuse({ alpha: -0.1, eps: 0.9, solarFlux: FLUX, radiatingFaces: 1 })).toBe('EOP_PROPERTY_RANGE');
    expect(refuse({ alpha: 0.2, eps: 0, solarFlux: FLUX, radiatingFaces: 1 })).toBe('EOP_PROPERTY_RANGE');
    expect(refuse({ alpha: 0.2, eps: 1.05, solarFlux: FLUX, radiatingFaces: 1 })).toBe('EOP_PROPERTY_RANGE');
  });

  it('caller-supplied alpha and eps work without a coating and are reported unverified', () => {
    const result = data(doc, { alpha: 0.2, eps: 0.9, solarFlux: FLUX, radiatingFaces: 1 });
    expect(result.temperatureK).toBeCloseTo(oracle('VC-EOP-08.a'), 6);
    expect(result.unverified).toBe(true);
    expect(result.unverifiedReasons).toHaveLength(2);
  });

  it('an unverified-basis coating value makes the result unverified', () => {
    const typical = run(doc, 'define_property_model', {
      material: 'white_paint_test',
      model: model('abs_eol', 'absorptivitySolar', { kind: 'constant', value: 0.3 }, { lifeState: 'EOL' }, 'typical'),
    });
    const result = data(typical, { entityId: panel, solarFlux: FLUX, radiatingFaces: 1, state: 'EOL' });
    expect(result.unverified).toBe(true);
    expect(result.unverifiedReasons.some((reason) => reason.startsWith('alpha'))).toBe(true);
  });
});
