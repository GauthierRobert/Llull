import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { marginConditions, rescaleMargin } from '@cae/selection/marginRescale';
import { caseOf, withCase } from '@cae/shared/access';
import { blockMesh } from '../cae/adequacyFixtures';
import { marginBar } from '../cae/marginsFixtures';
import { dataOf, expectedCase, pinned, withMaterial, withinCase } from './fixtures';

interface Row {
  readonly msFrom: number | null;
  readonly msTo: number | null;
  readonly statusTo: string;
  readonly method: string;
  readonly reviewRequired: boolean;
  readonly unverified: boolean;
  readonly allowable: { property: string; from: { valueMPa: number; basis: string }; to: { valueMPa: number; basis: string } };
}

interface Margins {
  readonly code?: string;
  readonly method?: string;
  readonly failedConditions?: string[];
  readonly conditions: { condition: string; ok: boolean; blocking: boolean; detail: string }[];
  readonly resolvePlan?: { command: string; params: Record<string, unknown> }[];
  readonly rows: Row[];
  readonly nuTolerance: { value: number; defaulted: boolean; source: string };
  readonly minMs: { from: number | null; to: number | null };
  readonly reviewRequired: boolean;
}

const SOURCE = 'test: second material of the margin bar';
/** The 2 x 1 x 1 bar on a measured lattice (4 layers through the depth: adequate), so compute_margins gives numeric rows without an opt-in. */
const lattice = (boxId: string): ReturnType<typeof blockMesh> => blockMesh([8, 4, 4], [2, 1, 1], { entityId: boxId });
const alloy = (nu: number, ftuBasis = 'company'): CadDocument => {
  const bar = marginBar({ category: 'ultimate', pullDisplacement: 0, lattice });
  return withMaterial(bar.recorded, 'alt', [
    { property: 'density', value: 7.85, unit: 'g/cm^3', basis: 'company', citation: SOURCE },
    { property: 'E', value: 70, unit: 'GPa', basis: 'company', citation: SOURCE },
    { property: 'nu', value: nu, unit: '1', basis: 'company', citation: SOURCE },
    { property: 'Ftu', value: 600, unit: 'MPa', basis: ftuBasis, citation: SOURCE },
    { property: 'Fty', value: 500, unit: 'MPa', basis: 'company', citation: SOURCE },
  ]);
};
const bar = marginBar({ category: 'ultimate', pullDisplacement: 0, lattice });
const swap = (doc: CadDocument, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(
    doc,
    'substitute_material',
    { entityIds: [bar.boxId], from: 'steel', to: 'alt', designRule: 'same_geometry', include: ['margins'], ...extra },
    bar.ctx,
  );
const marginsOf = (result: ReturnType<typeof execute>): Margins => dataOf(result)['margins'] as Margins;

describe('rescaleMargin (VC-SEL-08)', () => {
  it('MS 0.25 with allowable 500 -> 900 gives 1.25 (syn_a -> syn_b)', () => {
    const value = Number(expectedCase('VC-SEL-08').value);
    const syn = pinned<{ syn_a_to_syn_b: { marginFrom0p25: number } }>('substitution').syn_a_to_syn_b;
    expect(withinCase(rescaleMargin(0.25, 500, 900), value, 'VC-SEL-08')).toBe(true);
    expect(syn.marginFrom0p25).toBe(value);
    expect(rescaleMargin(0.25, 500, 500)).toBeCloseTo(0.25, 14);
  });
});

describe('substitute_material include margins (single material, no prescribed displacement)', () => {
  const doc = alloy(0.3);
  const result = swap(doc);
  const margins = marginsOf(result);

  it('rescales every compute_margins row as (1 + MS1) A2 / A1 - 1, labelled rescaled and review-required', () => {
    expect(result.rejected).toBeUndefined();
    expect(result.document).toBe(doc);
    expect(margins.method).toBe('rescaled');
    expect(margins.code).toBeUndefined();
    expect(margins.rows.length).toBeGreaterThan(0);
    for (const row of margins.rows) {
      expect(row.method).toBe('rescaled');
      expect(row.allowable).toMatchObject({ property: 'Ftu', from: { valueMPa: 300 }, to: { valueMPa: 600 } });
      expect(row.msFrom).toBeCloseTo(300 / 210 - 1, 9);
      expect(row.msTo).toBeCloseTo((1 + (row.msFrom ?? Number.NaN)) * 2 - 1, 12);
      expect(row.statusTo).toBe('PASS');
      expect(row.reviewRequired).toBe(true);
    }
    expect(margins.minMs.to).toBeCloseTo((300 / 210) * 2 - 1, 9);
    expect(margins.reviewRequired).toBe(true);
    expect(result.summary).toContain('rescaled');
  });

  it('VC-SEL-22: the Poisson tolerance is a named default (0), every blocking condition is reported one by one', () => {
    expect(margins.nuTolerance).toMatchObject({ value: 0, defaulted: true });
    expect(margins.nuTolerance.source).toContain('Poisson');
    expect(margins.conditions.map((entry) => entry.condition)).toEqual([
      'single_material',
      'same_poisson',
      'no_body_force',
      'no_thermal_load',
      'no_prescribed_displacement',
      'results_current',
      'same_allowable_basis',
    ]);
    expect(margins.conditions.every((entry) => entry.ok)).toBe(true);
  });

  it('a different allowable basis does not block but is reported: SEL_BASIS_MIXED and unverified', () => {
    const typical = swap(alloy(0.3, 'typical'));
    const data = marginsOf(typical);
    expect(data.method).toBe('rescaled');
    expect(data.conditions.find((entry) => entry.condition === 'same_allowable_basis')).toMatchObject({ ok: false, blocking: false });
    expect(data.rows[0]?.allowable.to.basis).toBe('typical');
    expect(data.rows.every((row) => row.unverified)).toBe(true);
    expect((dataOf(typical)['warnings'] as { code: string }[]).map((entry) => entry.code)).toContain('SEL_BASIS_MIXED');
    expect(dataOf(typical)['unverified']).toBe(true);
  });

  it('is pure', () => {
    const before = structuredClone(doc);
    swap(doc);
    expect(doc).toEqual(before);
  });
});

describe('SEL_MARGINS_NEED_RESOLVE (VC-SEL-09, AC-6)', () => {
  it('a different Poisson ratio fails same_poisson and no margin is guessed; a named tolerance admits it', () => {
    const doc = alloy(0.33);
    const refused = marginsOf(swap(doc));
    expect(refused.code).toBe('SEL_MARGINS_NEED_RESOLVE');
    expect(refused.failedConditions).toEqual(['same_poisson']);
    expect(refused.rows).toBeUndefined();
    expect(refused.resolvePlan?.map((entry) => entry.command)).toEqual(['assign_material', 'fea_mesh', 'fea_solve', 'compute_margins']);
    expect(refused.resolvePlan?.[0]?.params).toEqual({ materialName: 'alt', entityIds: [bar.boxId] });
    expect(refused.resolvePlan?.[3]?.params).toEqual({ analysisId: bar.analysisId });
    const admitted = marginsOf(swap(doc, { nuTolerance: 0.05 }));
    expect(admitted.method).toBe('rescaled');
    expect(admitted.nuTolerance).toMatchObject({ value: 0.05, defaulted: false });
  });

  it('a non-zero prescribed displacement fails no_prescribed_displacement (stress then scales with E)', () => {
    const pulled = marginBar({ category: 'ultimate', lattice });
    const doc = withMaterial(pulled.recorded, 'alt', [
      { property: 'density', value: 7.85, unit: 'g/cm^3', basis: 'company', citation: SOURCE },
      { property: 'E', value: 70, unit: 'GPa', basis: 'company', citation: SOURCE },
      { property: 'nu', value: 0.3, unit: '1', basis: 'company', citation: SOURCE },
      { property: 'Ftu', value: 600, unit: 'MPa', basis: 'company', citation: SOURCE },
    ]);
    const result = execute(
      doc,
      'substitute_material',
      { entityIds: [pulled.boxId], from: 'steel', to: 'alt', designRule: 'same_geometry', include: ['margins'] },
      pulled.ctx,
    );
    const data = marginsOf(result);
    expect(data.code).toBe('SEL_MARGINS_NEED_RESOLVE');
    expect(data.failedConditions).toEqual(['no_prescribed_displacement']);
    expect(result.summary).toContain('NOT rescaled');
  });

  it('gravity and a stale result each fail their condition (conditions evaluated one by one)', () => {
    const base = alloy(0.3);
    const gravity = execute(base, 'add_fea_load', { analysisId: bar.analysisId, name: 'g', kind: 'gravity', vector: [0, 0, -9810] });
    expect(gravity.rejected).toBeUndefined();
    const analysis = caseOf(gravity.document, bar.analysisId);
    expect(analysis).toBeDefined();
    const conditions = marginConditions(gravity.document, analysis ?? ({} as never), { from: 'steel', to: 'alt', nuTolerance: 0 });
    const failing = conditions.filter((entry) => !entry.ok).map((entry) => entry.condition);
    expect(failing).toEqual(['no_body_force', 'results_current']);
    expect(conditions.find((entry) => entry.condition === 'results_current')?.detail).toContain('stale');
  });

  it('single_material fails when a part of the analysis is made of another material (VC-SEL-09: load sharing follows the stiffness ratio)', () => {
    const base = alloy(0.3);
    const second = execute(base, 'add_box', { size: [1, 1, 1] });
    const secondId = second.affected[0] ?? '';
    const mixed = execute(second.document, 'assign_material', { materialName: 'alt', entityIds: [secondId] }).document;
    const analysis = caseOf(mixed, bar.analysisId);
    const withPart = withCase(mixed, {
      ...(analysis as NonNullable<typeof analysis>),
      parts: { ...analysis?.parts, [secondId]: { kind: 'solid' } },
    });
    const conditions = marginConditions(withPart, caseOf(withPart, bar.analysisId) as NonNullable<typeof analysis>, {
      from: 'steel',
      to: 'alt',
      nuTolerance: 0,
    });
    expect(conditions.find((entry) => entry.condition === 'single_material')).toMatchObject({ ok: false, blocking: true });
    expect(conditions.find((entry) => entry.condition === 'single_material')?.detail).toContain("'alt', 'steel'");
    // the pinned two-bar load sharing: equal for any single material, different once one bar changes (k = E A / L)
    const share = (k1: number, k2: number): number[] => [k1 / (k1 + k2), k2 / (k1 + k2)].map((part) => part * 1000);
    const pin = expectedCase('VC-SEL-09').value as { bothAluminium: number[]; bothSteel: number[]; mixed: number[] };
    const forces = (e1: number, e2: number): number[] => share(e1 * 2, e2 * 1);
    forces(70, 70).forEach((force, k) => expect(force).toBeCloseTo(pin.bothAluminium[k] ?? Number.NaN, 9));
    forces(200, 200).forEach((force, k) => expect(force).toBeCloseTo(pin.bothSteel[k] ?? Number.NaN, 9));
    forces(70, 210).forEach((force, k) => expect(force).not.toBeCloseTo(pin.bothAluminium[k] ?? Number.NaN, 3));
    expect(pin.mixed).toHaveLength(2);
  });
});

describe('substitute_material margins: no analysis and refusals', () => {
  it('SEL_NO_ANALYSIS (info) when no analysis has the entities; a refusal for an unknown or ambiguous analysisId', () => {
    const doc = alloy(0.3);
    const none = execute(doc, 'substitute_material', {
      entityIds: [bar.boxId],
      from: 'steel',
      to: 'alt',
      designRule: 'same_geometry',
      include: ['margins'],
      analysisId: bar.analysisId,
    });
    expect(none.rejected).toBeUndefined();
    const noCase = withMaterial(execute(doc, 'add_box', { size: [1, 1, 1] }).document, 'other', [
      { property: 'density', value: 1, unit: 'g/cm^3', basis: 'company', citation: SOURCE },
    ]);
    const unknown = execute(noCase, 'substitute_material', {
      entityIds: [bar.boxId],
      from: 'steel',
      to: 'alt',
      designRule: 'same_geometry',
      include: ['margins'],
      analysisId: 'ghost',
    });
    expect(unknown.error).toMatchObject({ code: 'SEL_PARAMS_INVALID', paths: ['analysisId'] });
    const cleared = { ...doc, analysis: undefined } as unknown as CadDocument;
    const noAnalysis = execute(cleared, 'substitute_material', {
      entityIds: [bar.boxId],
      from: 'steel',
      to: 'alt',
      designRule: 'same_geometry',
      include: ['margins'],
    });
    expect(marginsOf(noAnalysis)).toMatchObject({ code: 'SEL_NO_ANALYSIS' });
    expect(
      (dataOf(noAnalysis)['warnings'] as { code: string; severity: string }[]).find((entry) => entry.code === 'SEL_NO_ANALYSIS'),
    ).toMatchObject({ severity: 'info' });
  });

  it('margins need designRule same_geometry (the analysed geometry must not change)', () => {
    const refused = swap(alloy(0.3), { designRule: 'equal_stiffness_beam' });
    expect(refused.error).toMatchObject({ code: 'SEL_PARAMS_INVALID', paths: ['include'] });
  });

  it('the kernel / results port is needed: without verified artifacts compute_margins gives no rows and SEL_NO_ANALYSIS is reported', () => {
    const result = execute(alloy(0.3), 'substitute_material', {
      entityIds: [bar.boxId],
      from: 'steel',
      to: 'alt',
      designRule: 'same_geometry',
      include: ['margins'],
    });
    expect(marginsOf(result)).toMatchObject({ code: 'SEL_NO_ANALYSIS' });
  });
});
