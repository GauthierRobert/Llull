/** PHY-04 M4b: orthotropic CTE (*EXPANSION, TYPE=ORTHO) with material orientation (*ORIENTATION). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { orthonormalAxes } from '@cae/thermomech/orientation';
import { mustRun } from '../deckFixtures';
import { cteModel, strainModel, withModel } from '../../physics/thermomech/thermomechFixtures';
import { constant, coupledFixture, REF, textOf, type CoupledFixture } from './coupledSupport';
import { thermoFixture } from './fixtures';

const SECANT_20 = { mat: { kind: 'secant', referenceTemperature: REF } };

/** The coupled fixture with the cte basis stated, so the cte models of `orthotropic` can be read. */
function ortho(alphas: readonly number[]): CoupledFixture {
  const base = coupledFixture({ orthotropic: alphas });
  const doc = mustRun(base.doc, 'set_temperature_field', { analysisId: base.analysisId, cteBasis: SECANT_20 });
  return { ...base, doc, mesh: { ...base.mesh, inputHash: analysisInputHash(doc, base.analysisId, 'mesh') } };
}

const rotated = (fixture: CoupledFixture): { doc: CadDocument; mesh: FeMeshArtifact } => {
  const doc = mustRun(fixture.doc, 'rotate_entity', { id: fixture.boxId, delta: [0, 0, 0.5] });
  return { doc, mesh: { ...fixture.mesh, inputHash: analysisInputHash(doc, fixture.analysisId, 'mesh') } };
};

describe('orthotropic expansion cards', () => {
  it('writes *EXPANSION, TYPE=ORTHO with the three constant secant coefficients and per-direction provenance', () => {
    const { doc, analysisId, mesh } = ortho([1e-5, 2e-5, 3e-5]);
    const text = textOf(writeInp(doc, analysisId, mesh));
    expect(text).toContain('*EXPANSION, TYPE=ORTHO, ZERO=20\n0.00001, 0.00002, 0.00003\n');
    expect(text).toContain("** orthotropic thermal expansion of 'mat'");
    expect(text).toMatch(/\*\* direction 1: source mat\/cte1 \(cte model\); basis secant, reference 293.15 K; model sha256 [0-9a-f]{64}/);
    expect(text).toMatch(/\*\* direction 3: source mat\/cte3/);
    expect(text).not.toContain('*ORIENTATION');
    expect(text).toContain('*SOLID SECTION, ELSET=P_box_1_1, MATERIAL=M_1\n');
  });

  it('writes rows a1, a2, a3, T on one grid when a direction depends on temperature, repeating the constant ones', () => {
    const base = coupledFixture({ orthotropic: [1e-5, 2e-5] });
    const withThird = withModel(base.doc, 'mat', {
      ...cteModel({
        kind: 'table1d',
        variable: 'T',
        points: [
          [200, 1e-5],
          [400, 3e-5],
        ],
        interpolation: 'linear',
      }),
      id: 'cte3',
      direction: '3',
    });
    const doc = mustRun(withThird, 'set_temperature_field', { analysisId: base.analysisId, cteBasis: SECANT_20 });
    const mesh = { ...base.mesh, inputHash: analysisInputHash(doc, base.analysisId, 'mesh') };
    const text = textOf(writeInp(doc, base.analysisId, mesh));
    const block = text
      .slice(text.indexOf('*EXPANSION, TYPE=ORTHO'), text.indexOf('*SOLID SECTION'))
      .split('\n')
      .slice(1)
      .filter((line) => line !== '');
    const rows = block.map((line) => line.split(', ').map(Number));
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((row) => row.length === 4 && row[0] === 1e-5 && row[1] === 2e-5)).toBe(true);
    expect(rows[0]?.[3]).toBe(20);
    expect(rows.at(-1)?.[3]).toBe(120);
    expect(rows.at(-1)?.[2]).toBeGreaterThan(rows[0]?.[2] ?? 1);
  });

  it('accepts thermalStrain models per direction and refuses a missing direction (TMC_CTE_ORTHO_INCOMPLETE)', () => {
    const missing = coupledFixture({ orthotropic: [1e-5, 2e-5] });
    const refused = writeInp(missing.doc, missing.analysisId, missing.mesh);
    expect(refused).toMatchObject({ code: 'TMC_CTE_ORTHO_INCOMPLETE' });
    const strain = coupledFixture({ orthotropic: [] });
    let strained = strain.doc;
    for (const direction of ['1', '2', '3'])
      strained = withModel(strained, 'mat', { ...strainModel(1.2e-5), id: `s${direction}`, direction });
    const mesh = { ...strain.mesh, inputHash: analysisInputHash(strained, strain.analysisId, 'mesh') };
    const text = textOf(writeInp(strained, strain.analysisId, mesh));
    expect(text).toContain('*EXPANSION, TYPE=ORTHO, ZERO=20\n0.000012, 0.000012, 0.000012\n');
    expect(text).toContain('(thermalStrain model)');
  });

  it('refuses an unstated cte basis (TMC_CTE_BASIS_UNKNOWN) naming the direction', () => {
    const { doc, analysisId, mesh } = coupledFixture({ orthotropic: [1e-5, 2e-5, 3e-5] });
    expect(writeInp(doc, analysisId, mesh)).toMatchObject({ code: 'TMC_CTE_BASIS_UNKNOWN' });
  });

  it('thermo_static cases write the same card', () => {
    const base = thermoFixture({ model: null });
    let doc = mustRun(base.doc, 'define_property_model', { material: 'mat', model: constant('E', 'E', 'GPa', 210) });
    doc = mustRun(doc, 'define_property_model', { material: 'mat', model: constant('nu', 'nu', '1', 0.3) });
    [1e-5, 2e-5, 3e-5].forEach((alpha, i) => {
      doc = withModel(doc, 'mat', {
        ...cteModel({ kind: 'constant', value: alpha }),
        id: `c${i}`,
        direction: String(i + 1),
        validity: [],
        variables: [],
      });
    });
    doc = mustRun(doc, 'set_temperature_field', { analysisId: base.analysisId, cteBasis: SECANT_20 });
    const fix = execute(doc, 'add_fea_constraint', {
      analysisId: base.analysisId,
      name: 'fix',
      kind: 'fixed',
      target: { entityId: base.boxId, facesNear: [[0, 5, 5]] },
    });
    doc = fix.document;
    const mesh = {
      ...base.mesh,
      inputHash: analysisInputHash(doc, base.analysisId, 'mesh'),
      nodeSets: { [`C_${fix.affected[0]}`]: [1, 3, 4] },
    };
    const text = textOf(writeInp(doc, base.analysisId, mesh));
    expect(text).toContain('*EXPANSION, TYPE=ORTHO, ZERO=20\n0.00001, 0.00002, 0.00003\n');
  });
});

describe('set_material_orientation and *ORIENTATION', () => {
  it('stores orthonormal axes, writes *ORIENTATION and the section parameter, and removes it with no axes', () => {
    const fixture = ortho([1e-5, 2e-5, 3e-5]);
    const { analysisId, boxId } = fixture;
    const set = execute(fixture.doc, 'set_material_orientation', { analysisId, entityId: boxId, axis1: [0, 3, 0], axis2: [1, 1, 0] });
    expect(set.rejected).not.toBe(true);
    expect(set.affected).toEqual([analysisId]);
    expect(set.document.analysis?.cases[analysisId]?.thermomech?.orientations).toEqual({ [boxId]: { axis1: [0, 1, 0], axis2: [1, 0, 0] } });
    const mesh = { ...fixture.mesh, inputHash: analysisInputHash(set.document, analysisId, 'mesh') };
    const text = textOf(writeInp(set.document, analysisId, mesh));
    expect(text).toContain('*ORIENTATION, NAME=OR_box_1_1, SYSTEM=RECTANGULAR\n0, 1, 0, 1, 0, 0\n');
    expect(text.indexOf('*ORIENTATION')).toBeLessThan(text.indexOf('*SOLID SECTION'));
    expect(text).toContain('*SOLID SECTION, ELSET=P_box_1_1, MATERIAL=M_1, ORIENTATION=OR_box_1_1');
    const cleared = execute(set.document, 'set_material_orientation', { analysisId, entityId: boxId });
    expect(cleared.document.analysis?.cases[analysisId]?.thermomech?.orientations).toEqual({});
    expect(cleared.summary).toContain('document axes');
    expect(execute(cleared.document, 'set_material_orientation', { analysisId, entityId: boxId }).summary).toContain('already did');
    expect(
      execute(set.document, 'set_material_orientation', { analysisId, entityId: boxId, axis1: [0, 3, 0], axis2: [1, 1, 0] }).document,
    ).toMatchObject({ analysis: set.document.analysis });
  });

  it('is pure and refuses bad input with the unchanged document', () => {
    const { doc, analysisId, boxId } = ortho([1e-5, 2e-5, 3e-5]);
    const before = JSON.stringify(doc);
    const cases: [Record<string, unknown>, string][] = [
      [{ analysisId: 'nope', entityId: boxId }, 'FEA_ANALYSIS_NOT_FOUND'],
      [{ analysisId, entityId: 'nope', axis1: [1, 0, 0], axis2: [0, 1, 0] }, 'TMC_ORIENTATION_INVALID'],
      [{ analysisId, entityId: boxId, axis1: [1, 0, 0] }, 'TMC_ORIENTATION_INVALID'],
      [{ analysisId, entityId: boxId, axis1: [0, 0, 0], axis2: [0, 1, 0] }, 'TMC_ORIENTATION_INVALID'],
      [{ analysisId, entityId: boxId, axis1: [1, 0, 0], axis2: [2, 0, 0] }, 'TMC_ORIENTATION_INVALID'],
    ];
    for (const [params, code] of cases) {
      const result = execute(doc, 'set_material_orientation', params);
      expect(result.error?.code).toBe(code);
      expect(result.document).toBe(doc);
    }
    const staticCase = execute(doc, 'create_analysis', { name: 'S', analysisType: 'static' });
    const refused = execute(staticCase.document, 'set_material_orientation', { analysisId: staticCase.affected[0], entityId: boxId });
    expect(refused.error?.code).toBe('THM_CASE_TYPE');
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('orthonormalAxes projects axis2 off axis1 and refuses non-finite or parallel axes', () => {
    expect(orthonormalAxes([2, 0, 0], [1, 5, 0])).toEqual({ axis1: [1, 0, 0], axis2: [0, 1, 0] });
    expect(orthonormalAxes([1, 0, 0], [1, 1e-12, 0])).toBe('axis2 must be a finite vector not parallel to axis1');
    expect(orthonormalAxes([Number.NaN, 0, 0], [0, 1, 0])).toBe('axis1 must be a finite non-zero vector');
  });

  it('a rotated part with an orthotropic CTE needs an orientation (TMC_ORIENTATION_REQUIRED); an isotropic one does not', () => {
    const fixture = ortho([1e-5, 2e-5, 3e-5]);
    const turned = rotated(fixture);
    expect(writeInp(turned.doc, fixture.analysisId, turned.mesh)).toMatchObject({ code: 'TMC_ORIENTATION_REQUIRED', ids: [fixture.boxId] });
    const set = mustRun(turned.doc, 'set_material_orientation', {
      analysisId: fixture.analysisId,
      entityId: fixture.boxId,
      axis1: [Math.cos(0.5), Math.sin(0.5), 0],
      axis2: [-Math.sin(0.5), Math.cos(0.5), 0],
    });
    const mesh = { ...turned.mesh, inputHash: analysisInputHash(set, fixture.analysisId, 'mesh') };
    expect(textOf(writeInp(set, fixture.analysisId, mesh))).toContain('*ORIENTATION, NAME=OR_box_1_1');
    const iso = coupledFixture();
    const isoTurned = rotated(iso);
    expect('text' in writeInp(isoTurned.doc, iso.analysisId, isoTurned.mesh)).toBe(true);
  });

  it('check_thermo_mechanical reports the orthotropic readiness items', () => {
    const items = (fixture: { doc: CadDocument; analysisId: string }): string[] =>
      (execute(fixture.doc, 'check_thermo_mechanical', { analysisId: fixture.analysisId }).data as { items: { code: string }[] }).items.map(
        (item) => item.code,
      );
    const good = ortho([1e-5, 2e-5, 3e-5]);
    expect(items(good)).toEqual(['TMC_CTE_ORTHO_ELASTIC_ISOTROPIC']);
    const turned = rotated(good);
    expect(items({ doc: turned.doc, analysisId: good.analysisId })).toEqual([
      'TMC_ORIENTATION_REQUIRED',
      'TMC_CTE_ORTHO_ELASTIC_ISOTROPIC',
    ]);
    const missing = coupledFixture({ orthotropic: [1e-5, 2e-5] });
    expect(items(missing)).toEqual(['TMC_CTE_ORTHO_INCOMPLETE']);
    const unstated = coupledFixture({ orthotropic: [1e-5, 2e-5, 3e-5] });
    expect(items(unstated)).toEqual([
      'TMC_CTE_BASIS_UNKNOWN',
      'TMC_CTE_BASIS_UNKNOWN',
      'TMC_CTE_BASIS_UNKNOWN',
      'TMC_CTE_ORTHO_ELASTIC_ISOTROPIC',
    ]);
  });

  it('the input hash moves with the orientation', () => {
    const fixture = ortho([1e-5, 2e-5, 3e-5]);
    const set = mustRun(fixture.doc, 'set_material_orientation', {
      analysisId: fixture.analysisId,
      entityId: fixture.boxId,
      axis1: [0, 1, 0],
      axis2: [1, 0, 0],
    });
    expect(analysisInputHash(set, fixture.analysisId, 'full')).not.toBe(analysisInputHash(fixture.doc, fixture.analysisId, 'full'));
  });
});
