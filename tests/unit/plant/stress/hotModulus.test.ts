/** 07 PST `set_hot_modulus`: OPE cases use E(T) of a document material (rows are test fixture values, not code data); all displacements of a gravity cantilever scale with 1 / E. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply, expectRefusal } from '../../../helpers/commandAssertions';
import { analyzed, anchorAt, baseDoc, cases, conditioned, DN100, withModel, withPipe } from './m3Fixtures';
import { expectRel } from './stressFixtures';
import { E_ROWS, withEModulus } from './nozzleFixtures';

const STATED_E = 200000;
const E_AT_100C = 195000;

const withMaterial = (doc: CadDocument): CadDocument => withEModulus(doc);

function cantilever(tempC: number): { doc: CadDocument; id: string } {
  const pipe = withPipe(
    withMaterial(baseDoc()),
    [
      [0, 0, 0],
      [3000, 0, 0],
    ],
    DN100.odMm,
  );
  const model = withModel(pipe.doc, [pipe.id]);
  let doc = conditioned(model.doc, model.id, { temperatures: [{ name: 'T1', tempC }] });
  doc = anchorAt(doc, model.id, pipe.id, 0);
  doc = cases(doc, model.id, [
    { name: 'SUS', type: 'SUS', basic: ['W'] },
    { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
  ]);
  return { doc, id: model.id };
}

const tipUz = (doc: CadDocument, id: string, name: string): number => {
  const data = analyzed(doc, id, { include: ['displacements'] });
  const own = (data.details?.displacements ?? []).filter((entry) => entry.case === name);
  return Math.max(...own.map((entry) => Math.abs(entry.uMm[2] as number)));
};

describe('set_hot_modulus', () => {
  it('OPE displacement scales with stated E / E(T); SUS is unchanged; PST_HOT_MODULUS is reported', () => {
    const { doc, id } = cantilever(100);
    const before = tipUz(doc, id, 'OPE') / tipUz(doc, id, 'SUS');
    expectRel(before, 1, 1e-9, 'same E in both cases');
    const set = execute(doc, 'set_hot_modulus', { modelId: id, materialId: 'FIX' });
    expect(set.rejected).toBeUndefined();
    expect(set.affected).toEqual([id]);
    expect(set.document.plant?.stress?.models[id]?.hotModulus).toEqual({ materialId: 'FIX' });
    const ratio = tipUz(set.document, id, 'OPE') / tipUz(set.document, id, 'SUS');
    expectRel(ratio, STATED_E / E_AT_100C, 1e-9, 'u_OPE / u_SUS');
    expect(analyzed(set.document, id).findings.map((finding) => finding.code)).toContain('PST_HOT_MODULUS');
  });

  it('interpolates between rows (150 degC: 192.5 GPa) and clears back to the stated E', () => {
    const { doc, id } = cantilever(150);
    const set = apply(doc, 'set_hot_modulus', { modelId: id, materialId: 'FIX' });
    expectRel(tipUz(set, id, 'OPE') / tipUz(set, id, 'SUS'), STATED_E / 192500, 1e-9);
    const cleared = apply(set, 'set_hot_modulus', { modelId: id });
    expect(cleared.plant?.stress?.models[id]?.hotModulus).toBeUndefined();
    expectRel(tipUz(cleared, id, 'OPE') / tipUz(cleared, id, 'SUS'), 1, 1e-9);
  });

  it('refuses the analysis outside the E table, never extrapolating', () => {
    const { doc, id } = cantilever(250);
    const set = apply(doc, 'set_hot_modulus', { modelId: id, materialId: 'FIX' });
    expectRefusal(set, 'analyze_pipe_stress', { modelId: id }, 'PST_TEMPERATURE_OUT_OF_TABLE');
  });

  it('refuses unknown model, unknown material and a material without an E model; is pure', () => {
    const { doc, id } = cantilever(100);
    expectRefusal(doc, 'set_hot_modulus', { modelId: 'nope', materialId: 'FIX' }, 'PST_MODEL_NOT_FOUND');
    expectRefusal(doc, 'set_hot_modulus', { modelId: id, materialId: 'GHOST' }, 'PST_MATERIAL_NOT_FOUND');
    const bare = apply(doc, 'create_material', { name: 'BARE', density: 7850, densityUnit: 'kg/m^3' });
    expectRefusal(bare, 'set_hot_modulus', { modelId: id, materialId: 'BARE' }, 'PST_MATERIAL_NO_DATA');
    const before = JSON.stringify(doc);
    execute(doc, 'set_hot_modulus', { modelId: id, materialId: 'FIX' });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('a model without T primitive in its OPE case keeps the stated E; a deleted material is refused at analysis', () => {
    const { doc, id } = cantilever(100);
    const noT = apply(doc, 'set_stress_load_cases', { modelId: id, cases: [{ name: 'OPE', type: 'OPE', basic: ['W'] }] });
    const set = apply(noT, 'set_hot_modulus', { modelId: id, materialId: 'FIX' });
    expect(analyzed(set, id).findings.map((finding) => finding.code)).not.toContain('PST_HOT_MODULUS');
    const missing = structuredClone(doc);
    const model = missing.plant?.stress?.models[id];
    if (model !== undefined) model.hotModulus = { materialId: 'GONE' };
    expectRefusal(missing, 'analyze_pipe_stress', { modelId: id }, 'PST_MATERIAL_NOT_FOUND');
  });
});

describe('hot modulus: ranges, staleness', () => {
  /** An L-shaped pipe between two anchors: its thermal reactions and S_E are proportional to E. */
  function frame(hot: boolean): { doc: CadDocument; id: string } {
    const pipe = withPipe(
      withMaterial(baseDoc()),
      [
        [0, 0, 0],
        [3000, 0, 0],
        [3000, 3000, 0],
      ],
      DN100.odMm,
    );
    const model = withModel(pipe.doc, [pipe.id]);
    let doc = conditioned(model.doc, model.id, { temperatures: [{ name: 'T1', tempC: 200 }] });
    doc = anchorAt(anchorAt(doc, model.id, pipe.id, 0), model.id, pipe.id, 6000);
    doc = cases(doc, model.id, [
      { name: 'SUS', type: 'SUS', basic: ['W'] },
      { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
      {
        name: 'EXP',
        type: 'EXP',
        combine: [
          { case: 'OPE', factor: 1 },
          { case: 'SUS', factor: -1 },
        ],
      },
    ]);
    return { doc: hot ? apply(doc, 'set_hot_modulus', { modelId: model.id, materialId: 'FIX' }) : doc, id: model.id };
  }
  const maxStress = (doc: CadDocument, id: string, name: string): number =>
    Math.max(
      ...(analyzed(doc, id, { include: ['stresses'] }).details?.stresses ?? [])
        .filter((row) => row.case === name)
        .map((row) => row.stressMPa),
    );
  const opeReactionX = (doc: CadDocument, id: string): number =>
    Math.abs(
      (analyzed(doc, id, { include: ['reactions'] }).details?.reactions ?? []).find((row) => row.case === 'OPE')?.forceN[0] as number,
    );

  it('S_E is computed with the stated E (B31.3 E_a) with or without the hot modulus; OPE reactions keep the hot E', () => {
    const cold = frame(false);
    const hot = frame(true);
    expectRel(maxStress(hot.doc, hot.id, 'EXP'), maxStress(cold.doc, cold.id, 'EXP'), 1e-9, 'S_E');
    const ratio = opeReactionX(hot.doc, hot.id) / opeReactionX(cold.doc, cold.id);
    expect(ratio).toBeLessThan(0.99);
    expect(ratio).toBeGreaterThan(0.9);
  });

  it('re-importing the E rows after recording makes the results stale', () => {
    const { doc, id } = frame(true);
    const recorded = apply(doc, 'record_pipe_stress_results', { modelId: id });
    expect(execute(recorded, 'analyze_pipe_stress', { modelId: id }).data).toMatchObject({ recorded: { stale: false } });
    const changed = withEModulus(
      recorded,
      E_ROWS.map((row) => ({ ...row, EGPa: row.EGPa * 0.9 })),
    );
    expect(execute(changed, 'analyze_pipe_stress', { modelId: id }).data).toMatchObject({ recorded: { stale: true } });
  });
});
