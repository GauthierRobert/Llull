/** PHY-04 coupled temperature-displacement (TR-TMC-22): set-up commands, shared thermal BC commands, check, deck. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { analysisErrors } from '@cae/model/validate';
import { buildDeckContext } from '@cae/decks/context';
import { writeInp } from '@cae/decks/inpWriter';
import { coupledMaterialCards, coupledOf, coupledSections } from '@cae/thermomech/coupledDeck';
import { mustRun } from '../deckFixtures';
import { thermoFixture } from './fixtures';
import { cteModel, withModel } from '../../physics/thermomech/thermomechFixtures';

const REF = { value: 20, unit: 'degC' };
const constant = (id: string, property: string, unit: string, value: number): Record<string, unknown> => ({
  id,
  property,
  unit,
  variables: [],
  validity: [],
  form: { kind: 'constant', value },
  basis: 'company',
  source: { citation: 'synthetic test fixture' },
});

/** Box with material `mat` (alpha 1.2e-5 thermalStrain, k 50) in a coupled case with a fixed face and a 120 degC BC on a face of node 5. */
interface CoupledFixture {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly mesh: FeMeshArtifact;
  readonly boxId: string;
  readonly bcId: string;
  readonly fixId: string;
}

function coupledFixture(
  options: { bc?: boolean; withK?: boolean; eTable?: { points: number[][]; validity: number[] } } = {},
): CoupledFixture {
  const base = thermoFixture({ field: null });
  let doc: CadDocument = base.doc;
  const eModel =
    options.eTable === undefined
      ? constant('E', 'E', 'GPa', 210)
      : {
          id: 'E.tab',
          property: 'E',
          unit: 'MPa',
          variables: [{ variable: 'T', unit: 'K' }],
          form: { kind: 'table1d', variable: 'T', points: options.eTable.points, interpolation: 'linear' },
          validity: [{ variable: 'T', unit: 'K', data: options.eTable.validity }],
          basis: 'company',
          source: { citation: 'synthetic test fixture' },
        };
  doc = mustRun(doc, 'define_property_model', { material: 'mat', model: eModel });
  doc = mustRun(doc, 'define_property_model', { material: 'mat', model: constant('nu', 'nu', '1', 0.3) });
  if (options.withK !== false) doc = mustRun(doc, 'define_property_model', { material: 'mat', model: constant('k', 'k', 'W/(m*K)', 50) });
  const created = execute(doc, 'create_analysis', {
    name: 'C',
    analysisType: 'coupled_temperature_displacement',
    referenceTemperature: REF,
  });
  const analysisId = created.affected[0] ?? '';
  doc = mustRun(created.document, 'set_part_idealization', { analysisId, entityId: base.boxId });
  doc = mustRun(doc, 'add_fea_load', {
    analysisId,
    name: 'thermal load case',
    kind: 'gravity',
    loadCase: 'thermal',
    category: 'limit',
    vector: [0, 0, -1],
  });
  const fix = execute(doc, 'add_fea_constraint', {
    analysisId,
    name: 'fix',
    kind: 'fixed',
    target: { entityId: base.boxId, facesNear: [[0, 5, 5]] },
  });
  doc = fix.document;
  let bcId = '';
  if (options.bc !== false) {
    const bc = execute(doc, 'add_thermal_bc', {
      analysisId,
      name: 'hot',
      kind: 'temperature',
      value: 120,
      unit: 'degC',
      target: { entityId: base.boxId, facesNear: [[10, 5, 5]] },
    });
    doc = bc.document;
    bcId = bc.affected[0] ?? '';
  }
  const mesh = {
    ...base.mesh,
    inputHash: analysisInputHash(doc, analysisId, 'mesh'),
    nodeSets: { [`C_${fix.affected[0]}`]: [1, 3, 4], ...(bcId === '' ? {} : { [`B_${bcId}`]: [2, 5] }) },
  };
  return { doc, analysisId, mesh, boxId: base.boxId, bcId, fixId: fix.affected[0] ?? '' };
}

const textOf = (result: { text: string } | { code: string; message: string }): string =>
  'text' in result ? result.text : JSON.stringify(result);

describe('coupled_temperature_displacement set-up', () => {
  it('create_analysis builds a thermomech set-up with an empty thermal set-up and requires the reference temperature', () => {
    const { doc, analysisId } = coupledFixture({ bc: false });
    const analysisCase = doc.analysis?.cases[analysisId];
    expect(analysisCase?.type).toBe('coupled_temperature_displacement');
    expect(analysisCase?.thermal).toBeUndefined();
    expect(analysisCase?.thermomech).toMatchObject({
      referenceTemperature: REF,
      temperatureScale: 'degC',
      loadCaseName: 'thermal',
      thermal: { temperatureScale: 'degC', bcs: {}, bcOrder: [] },
    });
    const missing = execute(doc, 'create_analysis', { name: 'x', analysisType: 'coupled_temperature_displacement' });
    expect(missing.error?.code).toBe('TMC_REFERENCE_TEMPERATURE_MISSING');
    expect(missing.document).toBe(doc);
    const named = execute(doc, 'create_analysis', {
      name: 'x',
      analysisType: 'coupled_temperature_displacement',
      referenceTemperature: REF,
      loadCaseName: 'cold_soak',
      temperatureScale: 'K',
    });
    const id = named.affected[0] ?? '';
    expect(named.document.analysis?.cases[id]?.thermomech).toMatchObject({ loadCaseName: 'cold_soak', temperatureScale: 'K' });
    expect(execute(doc, 'create_analysis', { name: 'x', analysisType: 'static', referenceTemperature: REF }).error?.code).toBe(
      'FEA_PARAM_NOT_APPLICABLE',
    );
  });

  it('the thermal BC commands write into thermomech.thermal and set_reference_temperature applies', () => {
    const { doc, analysisId, bcId } = coupledFixture();
    const thermal = doc.analysis?.cases[analysisId]?.thermomech?.thermal;
    expect(thermal?.bcOrder).toEqual([bcId]);
    expect(thermal?.bcs[bcId]?.bc).toMatchObject({ kind: 'temperature', value: { value: 120, unit: 'degC' } });
    expect(doc.analysis?.cases[analysisId]?.thermal).toBeUndefined();
    const updated = execute(doc, 'update_thermal_bc', { analysisId, bcId, value: 90 });
    expect(updated.document.analysis?.cases[analysisId]?.thermomech?.thermal?.bcs[bcId]?.bc).toMatchObject({ value: { value: 90 } });
    const reference = execute(doc, 'set_reference_temperature', { analysisId, value: 25, unit: 'degC' });
    expect(reference.document.analysis?.cases[analysisId]?.thermomech).toMatchObject({ referenceTemperature: { value: 25 } });
    expect(reference.document.analysis?.cases[analysisId]?.thermomech?.thermal?.bcOrder).toEqual([bcId]);
    const removed = execute(doc, 'delete_analysis_item', { analysisId, itemId: bcId });
    expect(removed.document.analysis?.cases[analysisId]?.thermomech?.thermal?.bcOrder).toEqual([]);
  });

  it('set_temperature_field takes cteBasis only on a coupled case and needs a source or a cteBasis', () => {
    const { doc, analysisId } = coupledFixture();
    const source = execute(doc, 'set_temperature_field', { analysisId, source: { kind: 'uniform', value: REF } });
    expect(source.error?.code).toBe('THM_CASE_TYPE');
    expect(source.document).toBe(doc);
    expect(execute(doc, 'set_temperature_field', { analysisId }).error?.code).toBe('FEA_PARAM_INVALID');
    const basis = execute(doc, 'set_temperature_field', { analysisId, cteBasis: { mat: { kind: 'secant', referenceTemperature: REF } } });
    expect(basis.rejected).not.toBe(true);
    expect(basis.document.analysis?.cases[analysisId]?.thermomech?.cteBasis).toEqual({
      mat: { kind: 'secant', referenceTemperature: REF },
    });
    expect(basis.document.analysis?.cases[analysisId]?.thermomech?.field).toBeUndefined();
    expect(basis.summary).toContain('field unchanged');
  });

  it('cteBasis-only keeps the field of a thermo_static case', () => {
    const fixture = thermoFixture();
    const result = execute(fixture.doc, 'set_temperature_field', {
      analysisId: fixture.analysisId,
      cteBasis: { mat: { kind: 'instantaneous' } },
    });
    const setup = result.document.analysis?.cases[fixture.analysisId]?.thermomech;
    expect(setup?.field).toEqual({ kind: 'uniform', value: { value: 120, unit: 'degC' } });
    expect(setup?.cteBasis).toEqual({ mat: { kind: 'instantaneous' } });
  });

  it('check_thermo_mechanical and check_analysis read the thermal set-up of a coupled case', () => {
    const open = coupledFixture({ bc: false });
    const check = execute(open.doc, 'check_thermo_mechanical', { analysisId: open.analysisId });
    const items = (check.data as { verdict: string; items: { code: string }[] }).items.map((item) => item.code);
    expect(items).toContain('THM_NO_HEAT_PATH');
    expect((check.data as { verdict: string }).verdict).toBe('fail');
    const full = coupledFixture();
    const clean = execute(full.doc, 'check_thermo_mechanical', { analysisId: full.analysisId }).data as {
      verdict: string;
      items: unknown[];
    };
    expect(clean.items).toEqual([]);
    expect(clean.verdict).toBe('pass');
    const analysis = execute(full.doc, 'check_analysis', { analysisId: full.analysisId }).data as { items: { code: string }[] };
    expect(analysis.items.map((item) => item.code)).not.toContain('FEA_NO_CONSTRAINTS');
    expect(execute(full.doc, 'check_thermo_mechanical', { analysisId: 'nope' }).error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    const staticCase = execute(full.doc, 'create_analysis', { name: 'S', analysisType: 'static' });
    expect(execute(staticCase.document, 'check_thermo_mechanical', { analysisId: staticCase.affected[0] ?? '' }).error?.code).toBe(
      'THM_CASE_TYPE',
    );
  });

  it('the document validates and survives a save / load round trip', () => {
    const { doc, analysisId } = coupledFixture();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.analysis).toEqual(doc.analysis);
    const broken = JSON.parse(JSON.stringify(doc)) as { analysis: { cases: Record<string, { thermomech?: { thermal?: unknown } }> } };
    expect(analysisErrors(broken as never)).toEqual([]);
    const first = broken.analysis.cases[analysisId];
    if (first?.thermomech !== undefined) delete first.thermomech.thermal;
    expect(analysisErrors(broken as never).join('; ')).toContain('thermomech.thermal is required for coupled cases');
    const plain = JSON.parse(JSON.stringify(doc)) as typeof broken;
    const second = plain.analysis.cases[analysisId];
    if (second !== undefined) delete second.thermomech;
    expect(analysisErrors(plain as never).join('; ')).toContain('thermomech set-up is required for thermo_static and coupled cases');
  });
});

describe('coupled deck *ELASTIC follows E(T)', () => {
  const eTable = {
    points: [
      [250, 215000],
      [293.15, 210000],
      [450, 190000],
    ],
    validity: [250, 450],
  };
  it('writes E, nu, T rows over the T_ref .. BC temperature range (20 .. 120 degC) for an E(T) table', () => {
    const { doc, analysisId, mesh } = coupledFixture({ eTable });
    const text = textOf(writeInp(doc, analysisId, mesh));
    const block = text.slice(text.indexOf('*ELASTIC'), text.indexOf('*DENSITY')).split('\n');
    const rows = block
      .slice(1)
      .filter((line) => line !== '')
      .map((line) => line.split(', ').map(Number));
    expect(block[0]).toBe('*ELASTIC');
    expect(rows[0]).toEqual([210000, 0.3, 20]);
    expect(rows.at(-1)?.[2]).toBe(120);
    expect(rows.at(-1)?.[0]).toBeCloseTo(210000 - (20000 * (393.15 - 293.15)) / (450 - 293.15), 3);
    expect(rows.every((row) => row.length === 3)).toBe(true);
    expect(text).toContain('E, nu tabulated against temperature (degC)');
  });
  it('keeps a constant *ELASTIC row for a temperature-independent E', () => {
    const { doc, analysisId, mesh } = coupledFixture();
    expect(textOf(writeInp(doc, analysisId, mesh))).toContain('*ELASTIC\n210000, 0.3\n');
  });
  it('refuses PROP_OUT_OF_RANGE when the BC temperature leaves the validity range of E(T)', () => {
    const { doc, analysisId, mesh } = coupledFixture({ eTable: { ...eTable, validity: [250, 350] } });
    const written = writeInp(doc, analysisId, mesh);
    expect(written).toMatchObject({ code: 'PROP_OUT_OF_RANGE' });
  });
});

describe('coupled deck', () => {
  it('writes conductivity and secant expansion inside the material and the coupled steady step with mechanical lines before thermal ones', () => {
    const { doc, analysisId, mesh, fixId, bcId } = coupledFixture();
    const written = writeInp(doc, analysisId, mesh);
    const text = textOf(written);
    expect(text).toContain('*MATERIAL, NAME=M_1\n*ELASTIC');
    expect(text).toMatch(/\*CONDUCTIVITY\n50\n/);
    expect(text).toMatch(/\*EXPANSION, ZERO=20\n0\.000012\n/);
    const step = text.slice(text.indexOf('** coupled temperature-displacement analysis'));
    expect(step.split('\n')).toEqual([
      `** coupled temperature-displacement analysis ${analysisId}: steady state, T_ref 20 degC`,
      '*INITIAL CONDITIONS, TYPE=TEMPERATURE',
      '1, 20',
      '2, 20',
      '3, 20',
      '4, 20',
      '5, 20',
      '*STEP, INC=200',
      '*COUPLED TEMPERATURE-DISPLACEMENT, STEADY STATE',
      '1, 1',
      '*BOUNDARY, OP=NEW',
      `C_${fixId.replace(/[^A-Za-z0-9_]/g, '_')}, 1, 3`,
      '*CLOAD, OP=NEW',
      '*DLOAD, OP=NEW',
      'EALL, GRAV, 1, 0, 0, -1',
      `** ${bcId} hot (temperature)`,
      '*BOUNDARY',
      `B_${bcId.replace(/[^A-Za-z0-9_]/g, '_')}, 11, 11, 120`,
      '*NODE FILE',
      'U, NT',
      '*EL FILE',
      'S, HFL',
      '*END STEP',
      '',
    ]);
    expect(textOf(writeInp(doc, analysisId, mesh))).toBe(text);
  });

  it('refuses a missing heat path, a missing conductivity and the thermal features the step does not write', () => {
    const open = coupledFixture({ bc: false });
    expect(writeInp(open.doc, open.analysisId, open.mesh)).toMatchObject({ code: 'THM_NO_HEAT_PATH' });
    const noK = coupledFixture({ withK: false });
    expect(writeInp(noK.doc, noK.analysisId, noK.mesh)).toMatchObject({ code: 'THM_MATERIAL_NO_K' });
    const base = coupledFixture();
    const amplitude = mustRun(base.doc, 'define_amplitude', { analysisId: base.analysisId, name: 'ramp', kind: 'ramp', durationS: 10 });
    const ampId = Object.keys(amplitude.analysis?.cases[base.analysisId]?.thermomech?.thermal?.amplitudes ?? {})[0] ?? '';
    const withAmplitude = mustRun(amplitude, 'update_thermal_bc', { analysisId: base.analysisId, bcId: base.bcId, amplitude: ampId });
    const stepped = { ...base.mesh, inputHash: analysisInputHash(withAmplitude, base.analysisId, 'mesh') };
    expect(writeInp(withAmplitude, base.analysisId, stepped)).toMatchObject({ code: 'TMC_COUPLED_UNSUPPORTED' });
    const missingFaces = { ...base.mesh, nodeSets: { [Object.keys(base.mesh.nodeSets)[0] ?? '']: [1] } };
    expect(writeInp(base.doc, base.analysisId, missingFaces)).toMatchObject({ code: expect.stringMatching(/FEA_TARGET_UNRESOLVED/) });
  });

  it('refuses two different temperatures on shared nodes with THM_BC_CONFLICT, and accepts equal ones', () => {
    const base = coupledFixture();
    const second = (value: number): { doc: CadDocument; mesh: FeMeshArtifact; id: string } => {
      const added = execute(base.doc, 'add_thermal_bc', {
        analysisId: base.analysisId,
        name: 'other',
        kind: 'temperature',
        value,
        unit: 'degC',
        target: { entityId: base.boxId, facesNear: [[10, 5, 5]] },
      });
      const id = added.affected[0] ?? '';
      const mesh = {
        ...base.mesh,
        inputHash: analysisInputHash(added.document, base.analysisId, 'mesh'),
        nodeSets: { ...base.mesh.nodeSets, [`B_${id}`]: [2, 5] },
      };
      return { doc: added.document, mesh, id };
    };
    const conflicting = second(80);
    const refused = writeInp(conflicting.doc, base.analysisId, conflicting.mesh);
    expect(refused).toMatchObject({ code: 'THM_BC_CONFLICT', ids: [base.bcId, conflicting.id] });
    expect('message' in refused && refused.message).toContain('delete_analysis_item');
    const equal = second(120);
    expect(writeInp(equal.doc, base.analysisId, equal.mesh)).toHaveProperty('text');
  });

  it('the coupled functions refuse other analysis types', () => {
    const fixture = thermoFixture();
    const ctx = buildDeckContext(fixture.doc, fixture.analysisId, fixture.mesh);
    if (ctx === null) throw new Error('no context');
    expect(coupledOf(ctx.analysis)).toBeUndefined();
    expect(coupledSections(ctx)).toMatchObject({ code: 'THM_CASE_TYPE' });
    expect(coupledMaterialCards(ctx, fixture.boxId)).toMatchObject({ code: 'THM_CASE_TYPE' });
  });

  it('writes a temperature-dependent secant table over the BC range for a cte model once its basis is stated', () => {
    const base = coupledFixture();
    const cte = cteModel({ kind: 'polynomial', variable: 'T', coefficients: [1e-5, 1e-8], origin: 293.15 });
    const props = [
      ['alt', cte],
      ['alt', constant('E', 'E', 'GPa', 210)],
      ['alt', constant('nu', 'nu', '1', 0.3)],
      ['alt', constant('k', 'k', 'W/(m*K)', 50)],
    ] as const;
    let doc = props.reduce((current, [material, model]) => withModel(current, material, model), base.doc);
    doc = mustRun(doc, 'assign_material', { materialName: 'alt', entityIds: [base.boxId] });
    const mesh = { ...base.mesh, inputHash: analysisInputHash(doc, base.analysisId, 'mesh') };
    expect(writeInp(doc, base.analysisId, mesh)).toMatchObject({ code: 'TMC_CTE_BASIS_UNKNOWN' });
    doc = mustRun(doc, 'set_temperature_field', { analysisId: base.analysisId, cteBasis: { alt: { kind: 'instantaneous' } } });
    const table =
      textOf(writeInp(doc, base.analysisId, mesh))
        .split('*EXPANSION, ZERO=20\n')[1]
        ?.split('\n*')[0]
        ?.split('\n') ?? [];
    expect(table).toHaveLength(11);
    expect(Number(table[0]?.split(', ')[0])).toBeCloseTo(1e-5, 8);
    expect(table[0]?.endsWith(', 20')).toBe(true);
    // secant about 20 degC of alpha_inst = 1e-5 + 1e-8 (T - 293.15 K): 1e-5 + 0.5e-8 (T - 20 degC) = 1.05e-5 at 120 degC
    expect(Number(table[10]?.split(', ')[0])).toBeCloseTo(1.05e-5, 8);
    expect(table[10]?.endsWith(', 120')).toBe(true);
  });
});
