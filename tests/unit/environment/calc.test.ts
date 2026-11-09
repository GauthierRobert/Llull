import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { close, emptyMm, pinned, run } from './fixtures';

interface Uptake {
  tau?: number;
  fraction?: number;
  moisturePercent?: number;
  timesToFraction: { fraction: number; tau: number; time: { value: number; unit: string } }[];
  curve: { t: number; fraction: number; moisturePercent: number }[];
  defaults: string[];
  unverified: boolean;
  inputs: Record<string, { value: number; unit: string; source?: string; unverified: boolean }>;
  items: { code: string }[];
}

const plate = {
  thickness: { value: 2, unit: 'mm' },
  diffusivity: { value: 1e-6, unit: 'mm^2/s', source: 'synthetic (PHY-14 VC-ENV-04)' },
  saturation: { value: 1.5, unit: '%', source: 'synthetic (PHY-14 VC-ENV-04)' },
  exposure: { value: 7, unit: 'd' },
  faces: 'both',
  targets: [0.5, 0.9, 0.99],
};

const frozen = (doc: CadDocument): string => JSON.stringify(doc);

describe('moisture_uptake (FR-ENV-06, 07; VC-ENV-01, 04, 16)', () => {
  it('reproduces the synthetic plate and the pinned times to 50 / 90 / 99 % (the validation plan)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'moisture_uptake', plate);
    const data = result.data as Uptake;
    const wanted = pinned('VC-ENV-04') as { tau: number; moisturePercent: number; t50Days: number };
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([]);
    expect(close(data.tau ?? NaN, wanted.tau)).toBe(true);
    expect(close(data.moisturePercent ?? NaN, wanted.moisturePercent)).toBe(true);
    expect(close(data.timesToFraction[0]?.time.value ?? NaN, wanted.t50Days)).toBe(true);
    expect(data.timesToFraction[0]?.time.unit).toBe('d');
    expect(close(data.timesToFraction[0]?.tau ?? NaN, 0.0491826848809)).toBe(true);
    expect(close(data.timesToFraction[1]?.tau ?? NaN, 0.212021352012)).toBe(true);
    expect(close(data.timesToFraction[2]?.tau ?? NaN, 0.445321998467)).toBe(true);
    expect(result.summary).toContain('1.22660471');
    expect(data.unverified).toBe(false);
    expect(data.items.map((item) => item.code)).toEqual(['ENV_MODEL_ASSUMPTION']);
  });

  it('is pure: the input document is not modified', () => {
    const doc = createEmptyDocument();
    const before = frozen(doc);
    const result = execute(doc, 'moisture_uptake', plate);
    expect(frozen(doc)).toBe(before);
    expect(result.document).toBe(doc);
  });

  it('one sealed face behaves as a plate twice as thick (VC-ENV-16)', () => {
    const wanted = pinned('VC-ENV-16') as { tauEquivalent: number; moisturePercent: number };
    const data = execute(createEmptyDocument(), 'moisture_uptake', { ...plate, faces: 'one' }).data as Uptake;
    expect(close(data.tau ?? NaN, wanted.tauEquivalent)).toBe(true);
    expect(close(data.moisturePercent ?? NaN, wanted.moisturePercent)).toBe(true);
    const both = execute(createEmptyDocument(), 'moisture_uptake', { ...plate, thickness: { value: 4, unit: 'mm' } }).data as Uptake;
    expect(both.moisturePercent).toBe(data.moisturePercent);
  });

  it('returns a 50-point log-spaced curve ending at the exposure, in the requested time unit', () => {
    const data = execute(createEmptyDocument(), 'moisture_uptake', { ...plate, timeUnit: 'h' }).data as Uptake;
    expect(data.curve).toHaveLength(50);
    expect(close(data.curve[49]?.t ?? NaN, 168)).toBe(true);
    expect(close(data.curve[49]?.moisturePercent ?? NaN, data.moisturePercent ?? NaN)).toBe(true);
    expect(data.curve[0]?.t).toBeLessThan(data.curve[1]?.t ?? 0);
    expect(data.timesToFraction[0]?.time.unit).toBe('h');
  });

  it('without an exposure the curve spans to the 99 % time and no content at a time is reported', () => {
    const data = execute(createEmptyDocument(), 'moisture_uptake', { ...plate, exposure: undefined, timeUnit: 's' }).data as Uptake;
    expect(data.tau).toBeUndefined();
    expect(data.moisturePercent).toBeUndefined();
    expect(close(data.curve[49]?.t ?? NaN, data.timesToFraction[2]?.time.value ?? NaN)).toBe(true);
  });

  it('desorption starts at `initial` and dries toward 0 (named default), absorption defaults to dry (named default)', () => {
    const dry = execute(createEmptyDocument(), 'moisture_uptake', {
      ...plate,
      mode: 'desorption',
      saturation: undefined,
      initial: { value: 1.5, unit: '%', source: 'synthetic' },
    });
    const data = dry.data as Uptake;
    expect(close(data.moisturePercent ?? NaN, 1.5 - 1.22660470969)).toBe(true);
    expect(data.defaults).toEqual(['saturation = 0 % (dry boundary)']);
    expect(execute(createEmptyDocument(), 'moisture_uptake', plate).data as Uptake).toMatchObject({
      defaults: ['initial = 0 % (dry start)'],
    });
  });

  it('M_inf from relative humidity: a RH^b, flagged unverified without a source', () => {
    const result = execute(createEmptyDocument(), 'moisture_uptake', {
      ...plate,
      saturation: undefined,
      saturationLaw: { a: 0.02, b: 1.5, relativeHumidity: 50 },
    });
    const data = result.data as Uptake;
    expect(close(data.inputs['saturation']?.value ?? NaN, 0.02 * 50 ** 1.5)).toBe(true);
    expect(data.unverified).toBe(true);
    expect(data.items.map((item) => item.code)).toContain('ENV_VALUE_UNVERIFIED');
    expect(result.summary).toContain('Unverified inputs: saturation');
    const sourced = execute(createEmptyDocument(), 'moisture_uptake', {
      ...plate,
      saturation: undefined,
      saturationLaw: { a: 0.02, b: 1.5, relativeHumidity: 50, source: 'synthetic' },
    }).data as Uptake;
    expect(sourced.inputs['saturation']?.unverified).toBe(false);
  });

  it('flags a caller value without a source as unverified', () => {
    const data = execute(createEmptyDocument(), 'moisture_uptake', { ...plate, diffusivity: { value: 1e-6, unit: 'mm^2/s' } })
      .data as Uptake;
    expect(data.unverified).toBe(true);
    expect(data.inputs['diffusivity']?.unverified).toBe(true);
  });

  it('reads D and M_inf from the material record through PHY-01 and carries the record basis', () => {
    let doc = run(emptyMm(), 'create_material', {
      name: 'laminate',
      density: 0.0016,
      color: '#333333',
      metalness: 0,
      roughness: 0.5,
    }).document;
    const source = { citation: 'synthetic test value' };
    doc = run(doc, 'set_material_property', {
      material: 'laminate',
      property: 'moistureDiffusivity',
      value: 1e-6,
      unit: 'mm^2/s',
      basis: 'typical',
      source,
    }).document;
    doc = run(doc, 'set_material_property', {
      material: 'laminate',
      property: 'moistureSaturation',
      value: 1.5,
      unit: '%',
      basis: 'B',
      source,
    }).document;
    const result = execute(doc, 'moisture_uptake', {
      thickness: plate.thickness,
      faces: 'both',
      exposure: plate.exposure,
      material: 'laminate',
    });
    const data = result.data as Uptake;
    expect(close(data.moisturePercent ?? NaN, 1.22660470969)).toBe(true);
    expect(data.inputs['diffusivity']?.unverified).toBe(true);
    expect(data.inputs['saturation']?.unverified).toBe(false);
    expect(data.inputs['diffusivity']?.source).toContain('synthetic test value');
  });

  it('a temperature-dependent D is evaluated at the operating point and refused outside its range (PHY-01 code forwarded)', () => {
    let doc = run(emptyMm(), 'create_material', {
      name: 'resin',
      density: 0.0012,
      color: '#333333',
      metalness: 0,
      roughness: 0.5,
    }).document;
    doc = run(doc, 'set_material_property', {
      material: 'resin',
      property: 'moistureDiffusivity',
      unit: 'mm^2/s',
      basis: 'company',
      source: { citation: 'synthetic' },
      temperature: {
        mode: 'absolute',
        temperatureUnit: 'degC',
        points: [
          [20, 1e-6],
          [80, 5e-6],
        ],
      },
    }).document;
    const params = { thickness: plate.thickness, faces: 'both', exposure: plate.exposure, material: 'resin', saturation: plate.saturation };
    const warm = execute(doc, 'moisture_uptake', { ...params, temperature: { value: 20, unit: 'degC' } });
    expect(close((warm.data as Uptake).moisturePercent ?? NaN, 1.22660470969)).toBe(true);
    const hot = execute(doc, 'moisture_uptake', { ...params, temperature: { value: 150, unit: 'degC' } });
    expect(hot.error?.code).toBe('PROP_OUT_OF_RANGE');
    expect(hot.document).toBe(doc);
  });

  it.each([
    ['thickness 0', { thickness: { value: 0, unit: 'mm' } }, 'ENV_PARAM_INVALID', 'thickness'],
    ['thickness unit of another dimension', { thickness: { value: 2, unit: 's' } }, 'ENV_PARAM_INVALID', 'thickness.unit'],
    ['diffusivity <= 0', { diffusivity: { value: -1e-6, unit: 'mm^2/s' } }, 'ENV_PARAM_INVALID', 'diffusivity'],
    ['target 1.5', { targets: [1.5] }, 'ENV_PARAM_INVALID', 'targets.0'],
    ['target 0', { targets: [0] }, 'ENV_PARAM_INVALID', 'targets.0'],
    ['no exposure and no targets', { exposure: undefined, targets: undefined }, 'ENV_PARAM_INVALID', 'exposure'],
    ['exposure unit that is not a time', { exposure: { value: 7, unit: 'mm' } }, 'ENV_PARAM_INVALID', 'exposure'],
    ['negative exposure', { exposure: { value: -1, unit: 'd' } }, 'ENV_PARAM_INVALID', 'exposure'],
    ['timeUnit that is not a time', { timeUnit: 'kg' }, 'ENV_PARAM_INVALID', 'timeUnit'],
    ['no faces', { faces: undefined }, 'ENV_PARAM_INVALID', 'faces'],
    ['no diffusivity and no material', { diffusivity: undefined }, 'ENV_PROPERTY_MISSING', 'diffusivity'],
    ['no saturation', { saturation: undefined }, 'ENV_PROPERTY_MISSING', 'saturation'],
    ['desorption without initial', { mode: 'desorption', saturation: undefined }, 'ENV_PARAM_INVALID', 'initial'],
    [
      'law without humidity',
      { saturation: undefined, saturationLaw: { a: 1, b: 1 } },
      'ENV_PARAM_INVALID',
      'saturationLaw.relativeHumidity',
    ],
    [
      'law with humidity above 100',
      { saturation: undefined, saturationLaw: { a: 1, b: 1, relativeHumidity: 120 } },
      'ENV_PARAM_INVALID',
      'saturationLaw.relativeHumidity',
    ],
    ['unknown material', { diffusivity: undefined, material: 'nothing' }, 'MAT_RECORD_NOT_FOUND', 'material'],
    ['mission exposure requested but absent', { useMissionExposure: true }, 'ENV_PARAM_INVALID', 'useMissionExposure'],
  ])('refuses %s with %s and leaves the document unchanged', (_name, override, code, path) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'moisture_uptake', { ...plate, ...override });
    expect(result.error?.code).toBe(code);
    expect(result.error?.paths).toContain(path);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain(code);
  });

  it('takes duration, faces, temperature and humidity from the mission exposure on request', () => {
    const doc = run(createEmptyDocument(), 'set_mission_environment', {
      humidityExposure: {
        relativeHumidity: 50,
        temperature: { value: 20, unit: 'degC' },
        duration: { value: 7, unit: 'd' },
        faces: 'one',
        source: 'storage specification (synthetic)',
      },
    }).document;
    const data = execute(doc, 'moisture_uptake', {
      thickness: plate.thickness,
      diffusivity: plate.diffusivity,
      saturationLaw: { a: 0.02, b: 1.5, source: 'synthetic' },
      useMissionExposure: true,
    }).data as Uptake;
    const sealed = pinned('VC-ENV-16') as { tauEquivalent: number };
    expect(close(data.tau ?? NaN, sealed.tauEquivalent)).toBe(true);
    expect(close(data.inputs['saturation']?.value ?? NaN, 0.02 * 50 ** 1.5)).toBe(true);
  });
});

interface Hygro {
  strain: number | number[];
  strains: number[];
  equivalentDeltaT?: { value: number; unit: string };
  handOff: string;
  items: { code: string }[];
  unverified: boolean;
}

describe('hygro_strain (FR-ENV-08; VC-ENV-05, 13)', () => {
  const sourced = (value: number, unit: string): { value: number; unit: string; source: string } => ({ value, unit, source: 'synthetic' });

  it('strain and equivalent temperature of the validation plan, handed to PHY-04', () => {
    const wanted = pinned('VC-ENV-05') as { strain: number; equivalentDeltaTK: number };
    const doc = createEmptyDocument();
    const result = execute(doc, 'hygro_strain', {
      beta: sourced(0.001, '1/%'),
      deltaMoisture: sourced(1.22660470969, '%'),
      alpha: sourced(30e-6, '1/K'),
    });
    const data = result.data as Hygro;
    expect(close(data.strain as number, wanted.strain)).toBe(true);
    expect(close(data.equivalentDeltaT?.value ?? NaN, wanted.equivalentDeltaTK)).toBe(true);
    expect(data.equivalentDeltaT?.unit).toBe('K');
    expect(data.handOff).toBe('phy04_equivalent_temperature');
    expect(data.unverified).toBe(false);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('beta per unit mass fraction gives the same strain; no alpha means no hand-off', () => {
    const data = execute(createEmptyDocument(), 'hygro_strain', { beta: sourced(0.1, '1'), deltaMoisture: sourced(0.0122660470969, '1') })
      .data as Hygro;
    expect(close(data.strain as number, 1.22660470969e-3)).toBe(true);
    expect(data.equivalentDeltaT).toBeUndefined();
    expect(data.handOff).toBe('none');
  });

  it('non-proportional beta/alpha: strain returned, no equivalent temperature, ENV_EQUIVALENT_TEMPERATURE_INVALID (VC-ENV-13)', () => {
    const result = execute(createEmptyDocument(), 'hygro_strain', {
      beta: [sourced(0.0001, '1/%'), sourced(0.003, '1/%')],
      alpha: [sourced(2e-6, '1/K'), sourced(30e-6, '1/K')],
      deltaMoisture: sourced(1, '%'),
    });
    const data = result.data as Hygro;
    expect(result.error).toBeUndefined();
    expect(data.items.map((item) => item.code)).toContain('ENV_EQUIVALENT_TEMPERATURE_INVALID');
    expect(data.equivalentDeltaT).toBeUndefined();
    expect(data.handOff).toBe('cmp06_laminate');
    expect(data.strains).toHaveLength(2);
    expect(close(data.strains[1] ?? NaN, 0.003 * 100 * 0.01)).toBe(true);
    expect(result.summary).toContain('ENV_EQUIVALENT_TEMPERATURE_INVALID');
  });

  it('proportional orthotropic values still give one equivalent temperature', () => {
    const data = execute(createEmptyDocument(), 'hygro_strain', {
      beta: [sourced(0.001, '1/%'), sourced(0.003, '1/%')],
      alpha: [sourced(10e-6, '1/K'), sourced(30e-6, '1/K')],
      deltaMoisture: sourced(1, '%'),
    }).data as Hygro;
    expect(data.handOff).toBe('phy04_equivalent_temperature');
    expect(close(data.equivalentDeltaT?.value ?? NaN, 100)).toBe(true);
  });

  it('reads cme and cte from the material record', () => {
    let doc = run(emptyMm(), 'create_material', {
      name: 'adhesive',
      density: 0.0012,
      color: '#333333',
      metalness: 0,
      roughness: 0.5,
    }).document;
    const source = { citation: 'synthetic test value' };
    doc = run(doc, 'set_material_property', {
      material: 'adhesive',
      property: 'cme',
      value: 0.001,
      unit: '1/%',
      basis: 'typical',
      source,
    }).document;
    doc = run(doc, 'set_material_property', {
      material: 'adhesive',
      property: 'cte',
      value: 30e-6,
      unit: '1/K',
      basis: 'B',
      source,
    }).document;
    const data = execute(doc, 'hygro_strain', { material: 'adhesive', deltaMoisture: sourced(1.22660470969, '%') }).data as Hygro;
    expect(close(data.strain as number, 1.22660470969e-3)).toBe(true);
    expect(close(data.equivalentDeltaT?.value ?? NaN, 40.8868236562)).toBe(true);
    expect(data.unverified).toBe(true);
    expect(data.items.map((item) => item.code)).toContain('ENV_VALUE_UNVERIFIED');
  });

  it.each([
    ['no beta', { beta: undefined }, 'ENV_PROPERTY_MISSING'],
    ['unknown material', { beta: undefined, material: 'nothing' }, 'MAT_RECORD_NOT_FOUND'],
    ['alpha 0', { alpha: sourced(0, '1/K') }, 'ENV_PARAM_INVALID'],
    ['alpha length differs', { alpha: [sourced(1e-5, '1/K'), sourced(1e-5, '1/K')] }, 'ENV_PARAM_INVALID'],
    ['beta unit of another dimension', { beta: sourced(1, 'mm') }, 'ENV_PARAM_INVALID'],
    ['dM not finite (schema)', { deltaMoisture: { value: Number.POSITIVE_INFINITY, unit: '%' } }, 'CMD_INVALID_PARAMS'],
  ])('refuses %s with %s', (_name, override, code) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'hygro_strain', {
      beta: sourced(0.001, '1/%'),
      alpha: sourced(30e-6, '1/K'),
      deltaMoisture: sourced(1, '%'),
      ...override,
    });
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
  });
});

interface Ao {
  recessionUm: number;
  massLossG?: number;
  inputs: Record<string, { value: number; unit: string; source?: string; unverified: boolean }>;
  items: { code: string }[];
  unverified: boolean;
}

describe('ao_erosion (FR-ENV-10; VC-ENV-08..10)', () => {
  const yieldKapton = { value: 3.0e-24, unit: 'cm^3/atom', source: 'Kapton H reference value (S9, S10)' };
  const fluence = (value: number): { value: number; unit: string; source: string } => ({ value, unit: 'atoms/cm^2', source: 'synthetic' });

  it('recession 30 um and mass loss 0.03 g of the validation plan', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'ao_erosion', {
      erosionYield: yieldKapton,
      fluence: fluence(1e21),
      area: { value: 10, unit: 'cm^2' },
      density: { value: 1.0, unit: 'g/cm^3', source: 'synthetic' },
    });
    const data = result.data as Ao;
    expect(close(data.recessionUm, pinned('VC-ENV-08') as number)).toBe(true);
    expect(close(data.massLossG ?? NaN, pinned('VC-ENV-10') as number)).toBe(true);
    expect(data.unverified).toBe(false);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('the bundled kapton_h reference at the MISSE 2 fluence gives 252.9 um and carries its caveat (VC-ENV-09)', () => {
    const data = execute(createEmptyDocument(), 'ao_erosion', { reference: 'kapton_h', fluence: fluence(8.43e21) }).data as Ao;
    expect(close(data.recessionUm, pinned('VC-ENV-09') as number)).toBe(true);
    expect(data.inputs['erosionYield']?.source).toContain('STS-8');
    expect(data.items.map((item) => item.code)).toContain('ENV_MODEL_ASSUMPTION');
    expect(data.massLossG).toBeUndefined();
  });

  it('units convert: m^3/atom and atoms/m^2 give the same figure; the mission fluence is the default', () => {
    const si = execute(createEmptyDocument(), 'ao_erosion', {
      erosionYield: { value: 3e-30, unit: 'm^3/atom', source: 'synthetic' },
      fluence: { value: 1e25, unit: 'atoms/m^2', source: 'synthetic' },
    }).data as Ao;
    expect(close(si.recessionUm, 30)).toBe(true);
    const doc = run(createEmptyDocument(), 'set_mission_environment', {
      aoFluence: { value: 1e21, unit: 'atoms/cm^2', source: 'mission analysis rev B' },
    }).document;
    const mission = execute(doc, 'ao_erosion', { erosionYield: yieldKapton }).data as Ao;
    expect(close(mission.recessionUm, 30)).toBe(true);
    expect(mission.inputs['fluence']?.source).toBe('mission analysis rev B');
  });

  it('takes Ey and density from the material record, unverified when typical', () => {
    let doc = run(emptyMm(), 'create_material', {
      name: 'polyimide',
      density: 0.00142,
      color: '#aa8800',
      metalness: 0,
      roughness: 0.5,
    }).document;
    doc = run(doc, 'set_material_property', {
      material: 'polyimide',
      property: 'aoErosionYield',
      value: 3e-24,
      unit: 'cm^3',
      basis: 'typical',
      source: { citation: 'synthetic' },
    }).document;
    const data = execute(doc, 'ao_erosion', { material: 'polyimide', fluence: fluence(1e21), area: { value: 1000, unit: 'mm^2' } })
      .data as Ao;
    expect(close(data.recessionUm, 30)).toBe(true);
    expect(close(data.massLossG ?? NaN, 1.42 * 10 * 3e-24 * 1e21)).toBe(true);
    expect(data.unverified).toBe(true);
    expect(data.items.map((item) => item.code)).toContain('ENV_VALUE_UNVERIFIED');
  });

  it.each([
    ['no yield', { erosionYield: undefined }, 'ENV_PROPERTY_MISSING'],
    ['no fluence anywhere', { fluence: undefined }, 'ENV_FLUENCE_UNSET'],
    ['yield without source', { erosionYield: { ...yieldKapton, source: ' ' } }, 'ENV_SOURCE_MISSING'],
    ['fluence without source', { fluence: { value: 1e21, unit: 'atoms/cm^2' } }, 'ENV_SOURCE_MISSING'],
    ['yield <= 0', { erosionYield: { ...yieldKapton, value: 0 } }, 'ENV_PARAM_INVALID'],
    ['fluence negative', { fluence: fluence(-1) }, 'ENV_PARAM_INVALID'],
    ['area without density', { area: { value: 10, unit: 'cm^2' } }, 'ENV_PROPERTY_MISSING'],
    ['density without source', { area: { value: 10, unit: 'cm^2' }, density: { value: 1, unit: 'g/cm^3' } }, 'ENV_SOURCE_MISSING'],
    [
      'area unit of another dimension',
      { area: { value: 10, unit: 'cm' }, density: { value: 1, unit: 'g/cm^3', source: 's' } },
      'ENV_PARAM_INVALID',
    ],
    ['area <= 0', { area: { value: 0, unit: 'cm^2' }, density: { value: 1, unit: 'g/cm^3', source: 's' } }, 'ENV_PARAM_INVALID'],
    ['density <= 0', { area: { value: 1, unit: 'cm^2' }, density: { value: 0, unit: 'g/cm^3', source: 's' } }, 'ENV_PARAM_INVALID'],
    ['material without aoErosionYield', { erosionYield: undefined, material: 'nothing' }, 'MAT_RECORD_NOT_FOUND'],
  ])('refuses %s with %s', (_name, override, code) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'ao_erosion', { erosionYield: yieldKapton, fluence: fluence(1e21), ...override });
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });
});
