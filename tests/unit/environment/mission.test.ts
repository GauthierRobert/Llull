import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { environmentPlugin } from '@cae/index';
import { close, emptyMm, pinned, pinnedOutgassing, run, withMaterial, withPanel } from './fixtures';

interface Check {
  status: string;
  profile: { id: string; testMethod: string; status: string };
  items: {
    material: string;
    quantity: string;
    status: string;
    code?: string;
    value: number | null;
    derived: boolean;
    unverified: boolean;
    reviewRequired: boolean;
    ruleSource: string;
    valueSource: string;
  }[];
  findings: { code: string; material?: string; message: string }[];
  materials: { material: string; status: string }[];
  budget: {
    perPart: { entityId: string; massG: number | null; maxMassLossG: number | null; maxCondensableG: number | null; note?: string }[];
    totalMassLossG: number;
    totalCondensableG: number;
    counted: number;
    uncounted: number;
    label: string;
  };
  ao?: { items: { material: string; status: string; code?: string; recessionUm: number | null; unverified: boolean }[] };
  notes: string[];
  reviewRequired: boolean;
}

const SYNTHETIC: Record<string, Record<string, number>> = {
  syn_low: { TML: 0.95, CVCM: 0.05, WVR: 0.3 },
  syn_water: { TML: 1.2, CVCM: 0.02, WVR: 0.4 },
  syn_cvcm: { TML: 0.6, CVCM: 0.12, WVR: 0.1 },
  syn_edge: { TML: 1.0, CVCM: 0.1, WVR: 0.0 },
};

/** One panel of each synthetic material of the validation pack. */
function syntheticDocument(): { document: CadDocument; panels: Record<string, string> } {
  let document = emptyMm();
  const panels: Record<string, string> = {};
  for (const [name, values] of Object.entries(SYNTHETIC)) {
    document = withMaterial(document, name, values);
    const panel = withPanel(document, name);
    document = panel.document;
    panels[name] = panel.id;
  }
  return { document, panels };
}

const check = (doc: CadDocument, params: Record<string, unknown> = {}): CommandResult => execute(doc, 'check_space_environment', params);
const dataOf = (doc: CadDocument, params: Record<string, unknown> = {}): Check => check(doc, params).data as Check;
const statusOf = (data: Check, material: string, quantity?: string): string[] =>
  data.items
    .filter((item) => item.material === material && (quantity === undefined || item.quantity === quantity))
    .map((item) => item.status);

describe('plugin physics-environment (TR-ENV, toolset environment)', () => {
  it('registers the six PHY-14 commands in the environment toolset with a document slice', () => {
    expect(environmentPlugin.name).toBe('physics-environment');
    expect(environmentPlugin.toolset).toBe('environment');
    expect(environmentPlugin.commands.map((command) => command.name).sort()).toEqual([
      'ao_erosion',
      'approve_environment_deviation',
      'check_space_environment',
      'hygro_strain',
      'moisture_uptake',
      'set_mission_environment',
    ]);
    expect(environmentPlugin.document).toBeDefined();
  });
});

describe('set_mission_environment (FR-ENV-09)', () => {
  it('stores a shipped profile id, replaces only the keys given, and returns affected spaceEnvironment', () => {
    const doc = createEmptyDocument();
    const first = run(doc, 'set_mission_environment', { outgassingProfile: 'nasa_gsfc_screening' });
    expect(first.affected).toEqual(['spaceEnvironment']);
    expect(first.document.spaceEnvironment).toEqual({ outgassingProfile: 'nasa_gsfc_screening' });
    const second = run(first.document, 'set_mission_environment', {
      aoFluence: { value: 1e21, unit: 'atoms/cm^2', source: 'mission analysis rev B' },
    });
    expect(second.document.spaceEnvironment).toEqual({
      outgassingProfile: 'nasa_gsfc_screening',
      aoFluence: { value: 1e21, unit: 'atoms/cm^2', source: 'mission analysis rev B' },
    });
    expect(doc.spaceEnvironment).toBeUndefined();
  });

  it('is pure: the argument is not modified', () => {
    const { document } = syntheticDocument();
    const before = JSON.stringify(document);
    execute(document, 'set_mission_environment', { outgassingProfile: 'ecss_q_st_70_02' });
    expect(JSON.stringify(document)).toBe(before);
  });

  it('stores a custom profile whole with status company', () => {
    const result = run(createEmptyDocument(), 'set_mission_environment', {
      outgassingProfile: {
        id: 'program_x',
        label: 'Program X contamination plan',
        limits: [{ quantity: 'TML', op: '<', value: 0.5, unit: '%' }],
        testMethod: 'ASTM_E595',
        source: 'Program X CCP rev B section 4',
      },
      humidityExposure: {
        relativeHumidity: 50,
        temperature: { value: 20, unit: 'degC' },
        duration: { value: 7, unit: 'd' },
        faces: 'both',
        source: 'storage specification',
      },
    });
    expect(result.document.spaceEnvironment?.outgassingProfile).toMatchObject({ id: 'program_x', status: 'company' });
    expect(result.document.spaceEnvironment?.humidityExposure?.relativeHumidity).toBe(50);
    expect(result.summary).toContain('custom outgassing profile program_x');
  });

  const profile = {
    id: 'program_x',
    label: 'Program X',
    limits: [{ quantity: 'TML', op: '<', value: 0.5, unit: '%' }],
    testMethod: 'ASTM_E595',
    source: 'Program X CCP',
  };
  const exposure = {
    relativeHumidity: 50,
    temperature: { value: 20, unit: 'degC' },
    duration: { value: 7, unit: 'd' },
    faces: 'both',
    source: 'storage specification',
  };
  it.each([
    ['nothing given', {}, 'ENV_PARAM_INVALID'],
    ['unknown profile id', { outgassingProfile: 'nasa' }, 'ENV_PROFILE_UNKNOWN'],
    ['custom profile without source', { outgassingProfile: { ...profile, source: '  ' } }, 'ENV_SOURCE_MISSING'],
    ['custom profile reusing a shipped id', { outgassingProfile: { ...profile, id: 'nasa_gsfc_screening' } }, 'ENV_PARAM_INVALID'],
    ['custom profile with an invalid id', { outgassingProfile: { ...profile, id: '1 bad id' } }, 'ENV_PARAM_INVALID'],
    ['custom profile without a label', { outgassingProfile: { ...profile, label: ' ' } }, 'ENV_PARAM_INVALID'],
    ['custom profile without limits', { outgassingProfile: { ...profile, limits: [] } }, 'ENV_PARAM_INVALID'],
    [
      'limit above 100 %',
      { outgassingProfile: { ...profile, limits: [{ quantity: 'TML', op: '<', value: 101, unit: '%' }] } },
      'ENV_PARAM_INVALID',
    ],
    [
      'the same quantity twice',
      {
        outgassingProfile: {
          ...profile,
          limits: [
            { quantity: 'TML', op: '<', value: 1, unit: '%' },
            { quantity: 'TML', op: '<=', value: 2, unit: '%' },
          ],
        },
      },
      'ENV_PARAM_INVALID',
    ],
    ['exposure without source', { humidityExposure: { ...exposure, source: '' } }, 'ENV_SOURCE_MISSING'],
    ['RH above 100', { humidityExposure: { ...exposure, relativeHumidity: 101 } }, 'ENV_PARAM_INVALID'],
    ['temperature that is not one', { humidityExposure: { ...exposure, temperature: { value: 1, unit: 'kg' } } }, 'ENV_PARAM_INVALID'],
    [
      'temperature below absolute zero',
      { humidityExposure: { ...exposure, temperature: { value: -300, unit: 'degC' } } },
      'ENV_PARAM_INVALID',
    ],
    ['negative duration', { humidityExposure: { ...exposure, duration: { value: -1, unit: 'd' } } }, 'ENV_PARAM_INVALID'],
    ['fluence without source', { aoFluence: { value: 1e21, unit: 'atoms/cm^2', source: '' } }, 'ENV_SOURCE_MISSING'],
    ['negative fluence', { aoFluence: { value: -1, unit: 'atoms/cm^2', source: 'x' } }, 'ENV_PARAM_INVALID'],
  ])('refuses %s (%s)', (_name, params, code) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'set_mission_environment', params);
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });
});

describe('check_space_environment (FR-ENV-03..05, 12, 13; VC-ENV-06, 07, 11, 12)', () => {
  it.each(Object.keys(SYNTHETIC))('%s: pass / fail per quantity matches the pinned verdicts under both profiles (VC-ENV-06)', (name) => {
    const { document } = syntheticDocument();
    const pins = pinnedOutgassing[name] as Record<string, { pass: boolean; failed: string[] }>;
    for (const profile of ['nasa_gsfc_screening', 'ecss_q_st_70_02']) {
      const data = dataOf(document, { profile });
      const pin = pins[profile];
      expect(data.materials.find((entry) => entry.material === name)?.status === 'pass').toBe(pin?.pass);
      const own = data.items.filter((item) => item.material === name);
      expect(own.filter((item) => item.status === 'fail').map((item) => item.quantity)).toEqual(pin?.failed);
      expect(own.every((item) => item.status !== 'unknown')).toBe(true);
    }
  });

  it('judges each material against the stored operators: syn_edge passes NASA (<=) and fails ECSS (<) (VC-ENV-06.4)', () => {
    const { document } = syntheticDocument();
    const nasa = dataOf(document, { profile: 'nasa_gsfc_screening' });
    expect(statusOf(nasa, 'syn_edge')).toEqual(['pass', 'pass']);
    expect(statusOf(nasa, 'syn_water', 'TML')).toEqual(['fail']);
    const ecss = dataOf(document, { profile: 'ecss_q_st_70_02' });
    expect(statusOf(ecss, 'syn_edge')).toEqual(['fail', 'fail']);
    expect(statusOf(ecss, 'syn_water')).toEqual(['pass', 'pass']);
    expect(ecss.status).toBe('fail');
    expect(ecss.profile).toMatchObject({ id: 'ecss_q_st_70_02', testMethod: 'ECSS_Q_ST_70_02', status: 'secondary' });
  });

  it('every item carries code, values, rule source and reviewRequired; RML is derived as TML - WVR with an info finding', () => {
    const { document } = syntheticDocument();
    const data = dataOf(document, { profile: 'ecss_q_st_70_02' });
    const rml = data.items.find((item) => item.material === 'syn_low' && item.quantity === 'RML');
    expect(rml?.derived).toBe(true);
    expect(close(rml?.value ?? NaN, (pinnedOutgassing['syn_low'] as { RML: number }).RML)).toBe(true);
    expect(
      data.items.every((item) => item.reviewRequired && item.ruleSource.includes('ecss_q_st_70_02') && item.valueSource.length > 0),
    ).toBe(true);
    expect(data.items.filter((item) => item.status === 'fail').every((item) => item.code === 'ENV_OUTGASSING_FAIL')).toBe(true);
    expect(data.findings.some((finding) => finding.code === 'ENV_RML_DERIVED' && finding.message.includes('syn_low'))).toBe(true);
    expect(data.reviewRequired).toBe(true);
    expect(data.notes[0]).toContain('not a contamination analysis');
  });

  it('a measured RML takes priority over TML - WVR and is not labelled derived', () => {
    let document = withMaterial(emptyMm(), 'measured', { TML: 1.5, CVCM: 0.05, WVR: 0.1, RML: 0.7 });
    document = withPanel(document, 'measured').document;
    const data = dataOf(document, { profile: 'ecss_q_st_70_02' });
    const rml = data.items.find((item) => item.quantity === 'RML');
    expect(rml?.derived).toBe(false);
    expect(close(rml?.value ?? NaN, 0.7)).toBe(true);
    expect(rml?.status).toBe('pass');
    expect(data.findings.some((finding) => finding.code === 'ENV_RML_DERIVED')).toBe(false);
  });

  it('computes the screening budget of a 200 g part: 1.9 g mass loss, 0.1 g condensables (VC-ENV-07)', () => {
    const { document, panels } = syntheticDocument();
    const data = dataOf(document, { profile: 'nasa_gsfc_screening', entityIds: [panels['syn_low'] ?? ''] });
    const wanted = pinned('VC-ENV-07') as { maxMassLossG: number; maxCondensableG: number };
    const part = data.budget.perPart[0];
    expect(data.budget.perPart).toHaveLength(1);
    expect(close(part?.massG ?? NaN, 200)).toBe(true);
    expect(close(part?.maxMassLossG ?? NaN, wanted.maxMassLossG)).toBe(true);
    expect(close(part?.maxCondensableG ?? NaN, wanted.maxCondensableG)).toBe(true);
    expect(close(data.budget.totalMassLossG, wanted.maxMassLossG)).toBe(true);
    expect(close(data.budget.totalCondensableG, wanted.maxCondensableG)).toBe(true);
    expect(data.budget.label).toContain('not a contamination prediction');
    expect(data.status).toBe('pass');
  });

  it('a material without TML / CVCM is unknown (ENV_OUTGASSING_DATA_MISSING), never a pass (VC-ENV-11)', () => {
    let document = withMaterial(emptyMm(), 'bare', {});
    document = withPanel(document, 'bare').document;
    const result = check(document, { profile: 'nasa_gsfc_screening' });
    const data = result.data as Check;
    expect(data.status).toBe('unknown');
    expect(data.items.map((item) => [item.status, item.code])).toEqual([
      ['unknown', 'ENV_OUTGASSING_DATA_MISSING'],
      ['unknown', 'ENV_OUTGASSING_DATA_MISSING'],
    ]);
    expect(result.summary).toContain('ENV_OUTGASSING_DATA_MISSING');
    expect(data.budget.uncounted).toBe(1);
    expect(data.budget.totalMassLossG).toBe(0);
  });

  it('missing data next to a failure still reports fail; partial data (CVCM only) is unknown for the missing limit', () => {
    let document = withMaterial(emptyMm(), 'partial', { CVCM: 0.05 });
    document = withPanel(document, 'partial').document;
    expect(statusOf(dataOf(document, { profile: 'nasa_gsfc_screening' }), 'partial')).toEqual(['unknown', 'pass']);
    document = withPanel(withMaterial(document, 'bad', { TML: 2, CVCM: 0.05 }), 'bad').document;
    expect(dataOf(document, { profile: 'nasa_gsfc_screening' }).status).toBe('fail');
  });

  it('RML underivable (WVR missing) is unknown for the ECSS RML limit', () => {
    let document = withMaterial(emptyMm(), 'nowvr', { TML: 0.5, CVCM: 0.05 });
    document = withPanel(document, 'nowvr').document;
    const data = dataOf(document, { profile: 'ecss_q_st_70_02' });
    expect(statusOf(data, 'nowvr', 'RML')).toEqual(['unknown']);
    expect(data.items.find((item) => item.quantity === 'RML')?.valueSource).toContain('cannot be derived');
  });

  it('flags values on a typical basis as unverified (ENV_VALUE_UNVERIFIED)', () => {
    let document = run(emptyMm(), 'create_material', {
      name: 'typ',
      density: 0.0012,
      color: '#333333',
      metalness: 0,
      roughness: 0.5,
    }).document;
    for (const [property, value] of [
      ['TML', 0.5],
      ['CVCM', 0.05],
    ] as const)
      document = run(document, 'set_material_property', {
        material: 'typ',
        property,
        value,
        unit: '%',
        basis: 'typical',
        source: { citation: 'datasheet' },
      }).document;
    document = withPanel(document, 'typ').document;
    const data = dataOf(document, { profile: 'nasa_gsfc_screening' });
    expect(data.items.every((item) => item.unverified)).toBe(true);
    expect(data.findings.map((finding) => finding.code)).toContain('ENV_VALUE_UNVERIFIED');
    const sourced = dataOf(syntheticDocument().document, { profile: 'nasa_gsfc_screening' });
    expect(sourced.items.some((item) => item.unverified)).toBe(false);
    expect(sourced.findings.map((finding) => finding.code)).not.toContain('ENV_VALUE_UNVERIFIED');
  });

  it('uses the mission profile, and a custom mission profile by id', () => {
    const { document } = syntheticDocument();
    const mission = run(document, 'set_mission_environment', { outgassingProfile: 'nasa_gsfc_screening' }).document;
    expect(dataOf(mission).profile.id).toBe('nasa_gsfc_screening');
    const custom = run(document, 'set_mission_environment', {
      outgassingProfile: {
        id: 'strict',
        label: 'strict',
        limits: [{ quantity: 'TML', op: '<', value: 0.9, unit: '%' }],
        testMethod: 'ASTM_E595',
        source: 'Program CCP',
      },
    }).document;
    const data = dataOf(custom);
    expect(data.profile).toMatchObject({ id: 'strict', status: 'company' });
    expect(statusOf(data, 'syn_low')).toEqual(['fail']);
    expect(statusOf(data, 'syn_cvcm')).toEqual(['pass']);
    expect(dataOf(custom, { profile: 'strict' }).profile.id).toBe('strict');
    expect(dataOf(custom, { profile: 'ecss_q_st_70_02' }).profile.id).toBe('ecss_q_st_70_02');
  });

  it('refuses without a profile (ENV_PROFILE_UNSET, VC-ENV-12), with an unknown profile and with unknown entities', () => {
    const { document } = syntheticDocument();
    const unset = check(document);
    expect(unset.error?.code).toBe('ENV_PROFILE_UNSET');
    expect(unset.document).toBe(document);
    expect(check(document, { profile: 'nasa' }).error?.code).toBe('ENV_PROFILE_UNKNOWN');
    const unknownEntity = check(document, { profile: 'nasa_gsfc_screening', entityIds: ['box-99'] });
    expect(unknownEntity.error?.code).toBe('ENV_PARAM_INVALID');
    expect(unknownEntity.error?.ids).toEqual(['box-99']);
  });

  it('no entity with a material: status unknown, nothing screened', () => {
    const result = check(emptyMm(), { profile: 'nasa_gsfc_screening' });
    expect((result.data as Check).status).toBe('unknown');
    expect(result.summary).toContain('No entity with an assigned material');
  });

  it('is pure: the document is not modified and no entity is affected', () => {
    const { document } = syntheticDocument();
    const before = JSON.stringify(document);
    const result = check(document, { profile: 'nasa_gsfc_screening' });
    expect(JSON.stringify(document)).toBe(before);
    expect(result.document).toBe(document);
    expect(result.affected).toEqual([]);
  });

  it('lists a part whose mass cannot be measured without a figure and does not count it', () => {
    let document = withMaterial(emptyMm(), 'flat', { TML: 0.5, CVCM: 0.05 });
    const drawn = run(document, 'draw_rectangle', { position: [0, 0], width: 10, height: 10 });
    document = run(drawn.document, 'assign_material', { materialName: 'flat', entityIds: drawn.affected }).document;
    const data = dataOf(document, { profile: 'nasa_gsfc_screening' });
    expect(data.budget.perPart[0]?.massG).toBeNull();
    expect(data.budget.perPart[0]?.note).toContain('mass_properties');
    expect(data.budget.uncounted).toBe(1);
  });

  it('screens atomic-oxygen recession of the materials with an aoErosionYield; the others are unknown (ENV_PROPERTY_MISSING)', () => {
    let document = withMaterial(emptyMm(), 'polyimide', { TML: 0.5, CVCM: 0.05 });
    document = run(document, 'set_material_property', {
      material: 'polyimide',
      property: 'aoErosionYield',
      value: 3e-24,
      unit: 'cm^3',
      basis: 'company',
      source: { citation: 'synthetic' },
    }).document;
    document = withPanel(document, 'polyimide').document;
    document = withPanel(withMaterial(document, 'metal', { TML: 0.01, CVCM: 0.0 }), 'metal').document;
    document = run(document, 'set_mission_environment', {
      outgassingProfile: 'nasa_gsfc_screening',
      aoFluence: { value: 1e21, unit: 'atoms/cm^2', source: 'mission analysis rev B' },
      humidityExposure: {
        relativeHumidity: 50,
        temperature: { value: 20, unit: 'degC' },
        duration: { value: 7, unit: 'd' },
        faces: 'both',
        source: 'storage specification',
      },
    }).document;
    const data = dataOf(document);
    const ao = data.ao?.items ?? [];
    expect(ao.find((item) => item.material === 'polyimide')?.status).toBe('info');
    expect(close(ao.find((item) => item.material === 'polyimide')?.recessionUm ?? NaN, 30)).toBe(true);
    expect(ao.find((item) => item.material === 'metal')).toMatchObject({
      status: 'unknown',
      code: 'ENV_PROPERTY_MISSING',
      recessionUm: null,
    });
    expect(data.notes.some((note) => note.includes('moisture_uptake'))).toBe(true);
    expect(data.status).toBe('pass');
  });
});
