/** set_adiabatic_heating and the 05 supports of an explicit job (RS-8; constants are synthetic validation-pack test inputs, Q7). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { buildExplicitJob } from '@cae/index';
import { explicitErrors } from '@cae/explicit/model';
import { barModel, code, must } from './support';

/** The test material gains a constant specific heat model: 460 J/(kg K) (synthetic, not a material claim). */
function withSpecificHeat(doc: CadDocument): CadDocument {
  return must(doc, 'define_property_model', {
    material: 'steel_like',
    model: {
      id: 'cp_const',
      property: 'cp',
      unit: 'J/(kg*K)',
      variables: [],
      validity: [],
      form: { kind: 'constant', value: 460 },
      basis: 'company',
      source: { citation: 'synthetic test input of the PHY-19 validation pack (not a material claim)' },
    },
  }).document;
}

describe('set_adiabatic_heating', () => {
  const plastic = barModel({ plastic: true, size: 10 });

  it('stores beta 0.9 as a named default, purely, keeps it across set_explicit_controls and passes c_p in the case units to the job', () => {
    const doc = withSpecificHeat(plastic.doc);
    const before = structuredClone(doc);
    const set = must(doc, 'set_adiabatic_heating', { analysisId: plastic.analysisId, material: 'steel_like' });
    expect(doc).toEqual(before);
    const heating = set.document.analysis?.cases[plastic.analysisId]?.explicit?.heating;
    expect(heating?.['steel_like']?.taylorQuinney).toMatchObject({ value: 0.9, defaulted: true });
    expect(heating?.['steel_like']?.taylorQuinney.source).toContain('*MAT_107');
    expect(set.summary).toContain('beta 0.9, default');
    const controls = must(set.document, 'set_explicit_controls', {
      analysisId: plastic.analysisId,
      endTime: { value: 1e-4, unit: 's' },
      historyInterval: { value: 1e-6, unit: 's' },
      mesh: { kind: 'structured_hex', size: 10 },
    });
    expect(controls.document.analysis?.cases[plastic.analysisId]?.explicit?.heating).toBeDefined();
    expect(explicitErrors(JSON.parse(JSON.stringify(controls.document)) as Record<string, unknown>)).toEqual([]);
    const built = buildExplicitJob(controls.document, plastic.analysisId, null);
    if (!built.ok) throw new Error(built.message);
    // N-mm-t-s: 1 J/(kg K) = 1 m^2/(s^2 K) = 1e6 mm^2/(s^2 K) = 1e6 mJ/(t K).
    expect(built.job.materialHeating[0]?.taylorQuinney).toBe(0.9);
    expect(built.job.materialHeating[0]?.specificHeat).toBeCloseTo(4.6e8, 0);
    const custom = must(set.document, 'set_adiabatic_heating', {
      analysisId: plastic.analysisId,
      material: 'steel_like',
      taylorQuinney: 1,
    });
    expect(custom.document.analysis?.cases[plastic.analysisId]?.explicit?.heating?.['steel_like']?.taylorQuinney).toMatchObject({
      value: 1,
      defaulted: false,
    });
    const off = must(set.document, 'set_adiabatic_heating', { analysisId: plastic.analysisId, material: 'steel_like', enabled: false });
    expect(off.document.analysis?.cases[plastic.analysisId]?.explicit?.heating).toBeUndefined();
  });

  it('refuses beta outside [0, 1], unused materials, missing controls, and jobs without c_p or a Johnson-Cook law', () => {
    const params = { analysisId: plastic.analysisId, material: 'steel_like' };
    expect(code(execute(plastic.doc, 'set_adiabatic_heating', { ...params, taylorQuinney: 1.2 }))).toBe('EXP_PARAM_INVALID');
    expect(code(execute(plastic.doc, 'set_adiabatic_heating', { ...params, material: 'nope' }))).toBe('EXP_TARGET_NOT_IN_CASE');
    const fresh = must(plastic.doc, 'create_analysis', { name: 'b', analysisType: 'explicit_dynamics' });
    expect(code(execute(fresh.document, 'set_adiabatic_heating', { ...params, analysisId: fresh.affected[0] }))).toBe(
      'EXP_CONTROLS_MISSING',
    );
    const noCp = must(plastic.doc, 'set_adiabatic_heating', params).document;
    const refused = buildExplicitJob(noCp, plastic.analysisId, null);
    expect(refused.ok ? null : refused.code).toBe('EXP_MATERIAL_NO_CP');
    const elastic = barModel({ size: 10 });
    const heatedElastic = must(withSpecificHeat(elastic.doc), 'set_adiabatic_heating', {
      ...params,
      analysisId: elastic.analysisId,
    }).document;
    const incomplete = buildExplicitJob(heatedElastic, elastic.analysisId, null);
    expect(incomplete.ok ? null : incomplete.code).toBe('EXP_MATERIAL_INCOMPLETE');
  });
});

describe('05 supports in the explicit job', () => {
  const bar = barModel({ size: 10 });
  const support = (kind: string, target: Record<string, unknown>, dofs?: Record<string, number>): CadDocument =>
    must(bar.doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: kind,
      kind,
      target: { entityId: bar.barId, ...target },
      ...(dofs !== undefined ? { dofs } : {}),
    }).document;
  const job = (doc: CadDocument): NonNullable<Extract<ReturnType<typeof buildExplicitJob>, { ok: true }>['job']> => {
    const built = buildExplicitJob(doc, bar.analysisId, null);
    if (!built.ok) throw new Error(built.message);
    return built.job;
  };
  const heldNodes = (fixed: readonly number[], axis: number): number[] =>
    fixed.flatMap((value, k) => (value === 1 && k % 3 === axis ? [Math.floor(k / 3)] : []));

  it('holds the nodes of the box face nearest the target point, purely; pinned and zero displacements hold their dofs', () => {
    const doc = support('fixed', { facesNear: [[5, 5, 200]] });
    const before = structuredClone(doc);
    const built = job(doc);
    expect(doc).toEqual(before);
    const top = built.mesh.nodes.flatMap((_, k) => (k % 3 === 2 && built.mesh.nodes[k] === 200 ? [Math.floor(k / 3)] : []));
    expect(top.length).toBe(4);
    for (const axis of [0, 1, 2]) expect(heldNodes(built.fixed, axis)).toEqual(top);
    expect(built.fixedRotation).toEqual([]);
    const pinned = job(support('pinned', { facesNear: [[5, 5, 200]] }));
    expect(heldNodes(pinned.fixed, 2)).toEqual(top);
    const axial = job(support('displacement', { facesNear: [[5, 5, 200]] }, { uz: 0 }));
    expect(heldNodes(axial.fixed, 2)).toEqual(top);
    expect(heldNodes(axial.fixed, 0)).toEqual([]);
    const corner = job(support('fixed', { pointsNear: [[0, 0, 0]] }));
    expect(heldNodes(corner.fixed, 0)).toEqual([0]);
    expect(job(bar.doc).fixed).toEqual([]);
  });

  it('refuses supports it cannot hold: symmetry, prescribed motion and edge targets', () => {
    const refusedCode = (doc: CadDocument): string | null => {
      const built = buildExplicitJob(doc, bar.analysisId, null);
      return built.ok ? null : built.code;
    };
    expect(refusedCode(support('symmetry', { facesNear: [[5, 5, 200]] }))).toBe('EXP_CONSTRAINT_UNSUPPORTED');
    expect(refusedCode(support('displacement', { facesNear: [[5, 5, 200]] }, { uz: 0.1 }))).toBe('EXP_CONSTRAINT_UNSUPPORTED');
    expect(refusedCode(support('fixed', { edgesNear: [[0, 0, 100]] }))).toBe('EXP_CONSTRAINT_UNSUPPORTED');
  });

  it('reads the node set the mesher resolved on a fea_mesh mesh and refuses an empty one', () => {
    const doc = support('fixed', { facesNear: [[5, 5, 0]] });
    const tetCase = must(doc, 'set_explicit_controls', {
      analysisId: bar.analysisId,
      endTime: { value: 1e-4, unit: 's' },
      historyInterval: { value: 1e-6, unit: 's' },
    }).document;
    const constraintId = tetCase.analysis?.cases[bar.analysisId]?.constraintOrder[0] ?? '';
    const mesh: FeMeshArtifact = {
      kind: 'fe_mesh',
      unitSystem: 'N-mm-t-s',
      mesher: 'test',
      mesherVersion: '1',
      inputHash: 'x',
      nodes: [
        [11, 0, 0, 0],
        [12, 1, 0, 0],
        [13, 0, 1, 0],
        [14, 0, 0, 1],
      ],
      blocks: [{ type: 'C3D4', entityId: bar.barId, elements: [[1, 11, 12, 13, 14]] }],
      nodeSets: { [`C_${constraintId}`]: [12, 13, 99] },
      faceSets: {},
      targets: {},
    };
    const built = buildExplicitJob(tetCase, bar.analysisId, mesh);
    if (!built.ok) throw new Error(built.message);
    expect(built.job.fixed).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
    const empty = buildExplicitJob(tetCase, bar.analysisId, { ...mesh, nodeSets: {} });
    expect(empty.ok ? null : empty.code).toBe('EXP_CONSTRAINT_UNSUPPORTED');
  });
});

describe('adiabatic heating with a temperature-dependent c_p', () => {
  it('passes the c_p(T) table in K to the solver', () => {
    const plastic = barModel({ plastic: true, size: 10 });
    // Synthetic table: 400 J/(kg K) at 200 K, 600 at 400 K and 2000 K.
    const doc = must(plastic.doc, 'define_property_model', {
      material: 'steel_like',
      model: {
        id: 'cp_table',
        property: 'cp',
        unit: 'J/(kg*K)',
        variables: [{ variable: 'T', unit: 'K' }],
        validity: [{ variable: 'T', unit: 'K', data: [200, 2000] }],
        form: {
          kind: 'table1d',
          variable: 'T',
          points: [
            [200, 400],
            [400, 600],
            [2000, 600],
          ],
          interpolation: 'linear',
        },
        basis: 'company',
        source: { citation: 'synthetic test input of the PHY-19 validation pack (not a material claim)' },
      },
    }).document;
    const heated = must(doc, 'set_adiabatic_heating', { analysisId: plastic.analysisId, material: 'steel_like' }).document;
    const built = buildExplicitJob(heated, plastic.analysisId, null);
    if (!built.ok) throw new Error(built.message);
    const table = built.job.materialHeating[0]?.specificHeatTable ?? [];
    expect(table.length).toBeGreaterThan(1);
    // Linear in [200, 400] K: c_p(293.15 K) = 493.15 J/(kg K) = 493.15e6 mJ/(t K); the table is in K, increasing.
    const above = table.findIndex(([temperature]) => temperature > 293.15);
    const [t0, c0] = table[above - 1] ?? [0, 0];
    const [t1, c1] = table[above] ?? [1, 0];
    expect(c0 + ((c1 - c0) * (293.15 - t0)) / (t1 - t0)).toBeCloseTo(493.15e6, -3);
    expect(table.every(([temperature], k) => k === 0 || temperature > (table[k - 1]?.[0] ?? 0))).toBe(true);
  });
});
