import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { caseOf } from '@cae/shared/access';
import { barDocument, mustRun } from '../deckFixtures';
import { nonlinearBar, step } from './support';

const LOAD_CONTROL = { kind: 'load', initialIncrement: 0.1, minIncrement: 0.001, maxIncrement: 0.2, maxIncrements: 40 } as const;

const codeOf = (doc: CadDocument, command: string, params: Record<string, unknown>): string => {
  const result = execute(doc, command, params);
  expect(result.rejected, `${command}: ${result.summary}`).toBe(true);
  expect(result.document).toBe(doc);
  expect(result.affected).toEqual([]);
  return result.error?.code ?? '';
};

describe('create_analysis nonlinear_static', () => {
  it('creates a case without nonlinear settings until set_nonlinear_controls', () => {
    const bar = nonlinearBar();
    const analysis = caseOf(bar.doc, bar.analysisId);
    expect(analysis?.type).toBe('nonlinear_static');
    expect(analysis?.nonlinear).toBeUndefined();
  });
});

describe('set_nonlinear_controls', () => {
  it('creates the settings, states nlgeom and keeps steps on a second call', () => {
    const bar = nonlinearBar();
    const first = execute(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: false });
    expect(first.affected).toEqual([bar.analysisId]);
    expect(first.summary).toContain('nlgeom false, convergence ccx_default, output increments all');
    expect(caseOf(first.document, bar.analysisId)?.nonlinear).toMatchObject({ nlgeom: false, stepOrder: [], outputIncrements: 'all' });
    const stepped = step(first.document, 'add_analysis_step', {
      analysisId: bar.analysisId,
      name: 's',
      multipliers: {},
      control: LOAD_CONTROL,
    });
    const second = execute(stepped.doc, 'set_nonlinear_controls', {
      analysisId: bar.analysisId,
      nlgeom: true,
      convergence: { name: 'custom', field: { Rn: 0.01 }, timeIncrementation: { IA: 8 } },
      outputIncrements: { every: 3 },
    });
    expect(caseOf(second.document, bar.analysisId)?.nonlinear).toMatchObject({
      nlgeom: true,
      stepOrder: [stepped.id],
      convergence: { name: 'custom', field: { Rn: 0.01 }, timeIncrementation: { IA: 8 } },
      outputIncrements: { every: 3 },
    });
  });

  it('is pure', () => {
    const bar = nonlinearBar();
    const before = JSON.stringify(bar.doc);
    execute(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: true });
    expect(JSON.stringify(bar.doc)).toBe(before);
  });

  it('refuses unknown analyses, linear cases and invalid controls with stable codes', () => {
    const bar = nonlinearBar();
    expect(codeOf(bar.doc, 'set_nonlinear_controls', { analysisId: 'an-0.0', nlgeom: true })).toBe('FEA_ANALYSIS_NOT_FOUND');
    const linear = barDocument();
    expect(codeOf(linear.doc, 'set_nonlinear_controls', { analysisId: linear.analysisId, nlgeom: true })).toBe('NLS_CASE_NOT_NONLINEAR');
    const base = { analysisId: bar.analysisId, nlgeom: true };
    expect(codeOf(bar.doc, 'set_nonlinear_controls', { ...base, convergence: { name: 'custom' } })).toBe('NLS_CONTROL_INVALID');
    expect(codeOf(bar.doc, 'set_nonlinear_controls', { ...base, convergence: { name: 'custom', field: { Rn: -1 } } })).toBe(
      'NLS_CONTROL_INVALID',
    );
    expect(codeOf(bar.doc, 'set_nonlinear_controls', { ...base, convergence: { name: 'ccx_default', field: { Rn: 0.1 } } })).toBe(
      'NLS_CONTROL_INVALID',
    );
    expect(codeOf(bar.doc, 'set_nonlinear_controls', { ...base, outputIncrements: { every: 0 } })).toBe('NLS_CONTROL_INVALID');
    expect(codeOf(bar.doc, 'set_nonlinear_controls', { ...base, convergence: { name: 'custom', field: { Rx: 0.1 } } })).toBe(
      'NLS_CONTROL_INVALID',
    );
    expect(codeOf(bar.doc, 'set_nonlinear_controls', { ...base, convergence: { name: 'custom', timeIncrementation: { IZ: 3 } } })).toBe(
      'NLS_CONTROL_INVALID',
    );
  });

  it('rejects params without nlgeom (no default)', () => {
    const bar = nonlinearBar();
    const result = execute(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId });
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(bar.doc);
  });
});

describe('add_analysis_step', () => {
  const withControls = (): ReturnType<typeof nonlinearBar> & { readonly controlled: CadDocument } => {
    const bar = nonlinearBar();
    return { ...bar, controlled: mustRun(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: true }) };
  };

  it('appends steps with deterministic ids and carries the displacement target', () => {
    const bar = withControls();
    const first = step(bar.controlled, 'add_analysis_step', {
      analysisId: bar.analysisId,
      name: 'push',
      multipliers: {},
      control: LOAD_CONTROL,
    });
    const second = step(first.doc, 'add_analysis_step', {
      analysisId: bar.analysisId,
      name: 'drive',
      multipliers: {},
      amplitude: 'step',
      control: {
        ...LOAD_CONTROL,
        kind: 'displacement',
        dof: 'ux',
        value: 0.5,
        target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
      },
    });
    const nonlinear = caseOf(second.doc, bar.analysisId)?.nonlinear;
    expect(first.id).toMatch(/^stp-\d+\.\d+$/);
    expect(nonlinear?.stepOrder).toEqual([first.id, second.id]);
    expect(nonlinear?.steps[first.id]).toMatchObject({ name: 'push', amplitude: 'ramp', control: LOAD_CONTROL });
    expect(nonlinear?.steps[second.id]).toMatchObject({
      amplitude: 'step',
      control: { kind: 'displacement', dof: 'ux', value: 0.5, target: { entityId: bar.boxId } },
    });
    expect(
      execute(first.doc, 'add_analysis_step', { analysisId: bar.analysisId, name: 'again', multipliers: {}, control: LOAD_CONTROL })
        .summary,
    ).toContain('is step 2 of');
  });

  it('accepts multipliers for load cases that have loads and refuses others', () => {
    const bar = withControls();
    const loaded = mustRun(bar.controlled, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'p',
      kind: 'pressure',
      loadCase: 'LC1',
      magnitude: 1,
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const ok = execute(loaded, 'add_analysis_step', {
      analysisId: bar.analysisId,
      name: 's',
      multipliers: { LC1: 50 },
      control: LOAD_CONTROL,
    });
    expect(ok.affected).toHaveLength(1);
    expect(
      codeOf(loaded, 'add_analysis_step', { analysisId: bar.analysisId, name: 's', multipliers: { LC9: 1 }, control: LOAD_CONTROL }),
    ).toBe('NLS_LOAD_CASE_UNKNOWN');
  });

  it('refuses every invalid request without touching the document', () => {
    const bar = withControls();
    const base = { analysisId: bar.analysisId, name: 's', multipliers: {}, control: LOAD_CONTROL };
    expect(codeOf(bar.doc, 'add_analysis_step', base)).toBe('NLS_CONTROLS_UNSET');
    expect(codeOf(bar.controlled, 'add_analysis_step', { ...base, analysisId: 'an-0.0' })).toBe('FEA_ANALYSIS_NOT_FOUND');
    const linear = barDocument();
    expect(codeOf(linear.doc, 'add_analysis_step', { ...base, analysisId: linear.analysisId })).toBe('NLS_CASE_NOT_NONLINEAR');
    expect(
      codeOf(bar.controlled, 'add_analysis_step', { ...base, control: { kind: 'arc_length', initialArcLength: 1, maxSteps: 10 } }),
    ).toBe('NLS_ARC_LENGTH_UNSUPPORTED');
    expect(codeOf(bar.controlled, 'add_analysis_step', { ...base, control: { ...LOAD_CONTROL, minIncrement: 0.5 } })).toBe(
      'NLS_CONTROL_INVALID',
    );
    expect(codeOf(bar.controlled, 'add_analysis_step', { ...base, control: { ...LOAD_CONTROL, maxIncrement: 2 } })).toBe(
      'NLS_CONTROL_INVALID',
    );
    expect(codeOf(bar.controlled, 'add_analysis_step', { ...base, control: { ...LOAD_CONTROL, maxIncrements: 0 } })).toBe(
      'NLS_CONTROL_INVALID',
    );
    const displacement = { ...LOAD_CONTROL, kind: 'displacement', dof: 'ux', value: 1 };
    expect(
      codeOf(bar.controlled, 'add_analysis_step', {
        ...base,
        control: { ...displacement, target: { entityId: 'nope', facesNear: [[0, 0, 0]] } },
      }),
    ).toBe('FEA_TARGET_UNRESOLVED');
    expect(codeOf(bar.controlled, 'add_analysis_step', { ...base, control: { ...displacement, target: { entityId: bar.boxId } } })).toBe(
      'FEA_TARGET_UNRESOLVED',
    );
  });

  it('refuses a displacement target that is not a part of the case', () => {
    const bar = withControls();
    const other = mustRun(bar.controlled, 'add_box', { size: [1, 1, 1] });
    const otherId = Object.keys(other.entities).find((id) => id !== bar.boxId) ?? '';
    const displacement = {
      ...LOAD_CONTROL,
      kind: 'displacement',
      dof: 'ux',
      value: 1,
      target: { entityId: otherId, facesNear: [[0, 0, 0]] },
    };
    expect(codeOf(other, 'add_analysis_step', { analysisId: bar.analysisId, name: 's', multipliers: {}, control: displacement })).toBe(
      'FEA_PART_NOT_IN_ANALYSIS',
    );
  });
});

describe('add_curve_probe', () => {
  const stepped = (): ReturnType<typeof nonlinearBar> & { readonly doc2: CadDocument } => {
    const bar = nonlinearBar();
    return { ...bar, doc2: mustRun(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: true }) };
  };

  it('records a reaction probe by constraint name and a load probe by id', () => {
    const bar = stepped();
    const loaded = step(bar.doc2, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'p',
      kind: 'pressure',
      loadCase: 'LC1',
      magnitude: 1,
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const reaction = step(loaded.doc, 'add_curve_probe', {
      analysisId: bar.analysisId,
      name: 'r',
      load: { kind: 'reaction', constraintId: 'x0', component: 'x' },
      displacement: { point: [2, 0, 0], dof: 'ux' },
    });
    const load = step(reaction.doc, 'add_curve_probe', {
      analysisId: bar.analysisId,
      name: 'l',
      load: { kind: 'load', loadId: loaded.id },
      displacement: { point: [2, 0, 0], dof: 'magnitude' },
    });
    const nonlinear = caseOf(load.doc, bar.analysisId)?.nonlinear;
    expect(nonlinear?.probeOrder).toEqual([reaction.id, load.id]);
    expect(nonlinear?.probes[reaction.id]?.load).toEqual({ kind: 'reaction', constraintId: bar.constraints['x0'], component: 'x' });
    expect(nonlinear?.probes[load.id]?.load).toEqual({ kind: 'load', loadId: loaded.id });
    expect(reaction.id).toMatch(/^prb-\d+\.\d+$/);
  });

  it('refuses unknown references, bad points and non-nonlinear cases', () => {
    const bar = stepped();
    const base = { analysisId: bar.analysisId, name: 'p', displacement: { point: [2, 0, 0], dof: 'ux' } };
    expect(codeOf(bar.doc2, 'add_curve_probe', { ...base, load: { kind: 'reaction', constraintId: 'ghost', component: 'x' } })).toBe(
      'NLS_PROBE_REFERENCE_UNKNOWN',
    );
    expect(codeOf(bar.doc2, 'add_curve_probe', { ...base, load: { kind: 'load', loadId: 'ghost' } })).toBe('NLS_PROBE_REFERENCE_UNKNOWN');
    const good = { kind: 'reaction', constraintId: 'x0', component: 'x' };
    expect(
      codeOf(bar.doc2, 'add_curve_probe', { ...base, load: good, displacement: { point: [Number.POSITIVE_INFINITY, 0, 0], dof: 'ux' } }),
    ).toMatch(/NLS_CONTROL_INVALID|CMD_/);
    const linear = barDocument();
    expect(codeOf(linear.doc, 'add_curve_probe', { ...base, analysisId: linear.analysisId, load: good })).toBe('NLS_CASE_NOT_NONLINEAR');
    expect(codeOf(bar.doc2, 'add_curve_probe', { ...base, analysisId: 'an-0.0', load: good })).toBe('FEA_ANALYSIS_NOT_FOUND');
  });

  it('refuses an ambiguous constraint name', () => {
    const bar = stepped();
    const twin = mustRun(bar.doc2, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'x0',
      kind: 'fixed',
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    expect(
      codeOf(twin, 'add_curve_probe', {
        analysisId: bar.analysisId,
        name: 'p',
        load: { kind: 'reaction', constraintId: 'x0', component: 'x' },
        displacement: { point: [2, 0, 0], dof: 'ux' },
      }),
    ).toBe('NLS_PROBE_REFERENCE_UNKNOWN');
  });
});

describe('set_part_constitutive_set', () => {
  it('selects a set, resolves the default and names it', () => {
    const bar = nonlinearBar();
    const explicit = execute(bar.doc, 'set_part_constitutive_set', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      constitutiveSetId: 'soft',
    });
    expect(explicit.affected).toEqual([bar.analysisId]);
    expect(explicit.summary).toContain("set 'soft'");
    expect(caseOf(explicit.document, bar.analysisId)?.nonlinear?.constitutiveSets).toEqual({ [bar.boxId]: 'soft' });
    const implicit = execute(bar.doc, 'set_part_constitutive_set', { analysisId: bar.analysisId, entityId: bar.boxId });
    expect(implicit.summary).toContain("set 'nl'");
    expect(implicit.summary).toContain('the material default');
    expect(caseOf(implicit.document, bar.analysisId)?.nonlinear?.constitutiveSets).toEqual({ [bar.boxId]: 'nl' });
  });

  it('is pure and idempotent', () => {
    const bar = nonlinearBar();
    const before = JSON.stringify(bar.doc);
    const once = execute(bar.doc, 'set_part_constitutive_set', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      constitutiveSetId: 'soft',
    });
    expect(JSON.stringify(bar.doc)).toBe(before);
    const twice = execute(once.document, 'set_part_constitutive_set', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      constitutiveSetId: 'soft',
    });
    expect(caseOf(twice.document, bar.analysisId)?.nonlinear).toEqual(caseOf(once.document, bar.analysisId)?.nonlinear);
  });

  it('refuses missing sets, creep laws, non-parts and other case types', () => {
    const bar = nonlinearBar();
    const base = { analysisId: bar.analysisId, entityId: bar.boxId };
    expect(codeOf(bar.doc, 'set_part_constitutive_set', { ...base, constitutiveSetId: 'ghost' })).toBe('NLS_MATERIAL_MODEL_MISSING');
    expect(codeOf(bar.doc, 'set_part_constitutive_set', { ...base, entityId: 'ghost' })).toBe('FEA_PART_NOT_IN_ANALYSIS');
    expect(codeOf(bar.doc, 'set_part_constitutive_set', { ...base, analysisId: 'an-0.0' })).toBe('FEA_ANALYSIS_NOT_FOUND');
    const linear = barDocument();
    expect(codeOf(linear.doc, 'set_part_constitutive_set', { analysisId: linear.analysisId, entityId: linear.boxId })).toBe(
      'NLS_CASE_NOT_NONLINEAR',
    );
    const creep = mustRun(bar.doc, 'add_material_model', {
      material: 'steel',
      id: 'norton',
      model: { kind: 'creep_norton', A: 1e-10, n: 5, m: 0, stressUnit: 'MPa', timeUnit: 'h', hardening: 'time' },
      basis: 'unspecified',
      source: { citation: 'test' },
    });
    const withCreep = mustRun(creep, 'define_constitutive_set', {
      material: 'steel',
      set: { id: 'cr', elastic: 'elasticv', creep: 'norton' },
    });
    expect(codeOf(withCreep, 'set_part_constitutive_set', { ...base, constitutiveSetId: 'cr' })).toBe('NLS_MATERIAL_MODEL_UNSUPPORTED');
  });

  it('refuses a part without material and a material without a default set', () => {
    const bare = barDocument({ material: 'none', analysisType: 'nonlinear_static' });
    expect(codeOf(bare.doc, 'set_part_constitutive_set', { analysisId: bare.analysisId, entityId: bare.boxId })).toBe(
      'NLS_MATERIAL_MODEL_MISSING',
    );
    const noDefault = barDocument({ material: 'models', analysisType: 'nonlinear_static' });
    expect(codeOf(noDefault.doc, 'set_part_constitutive_set', { analysisId: noDefault.analysisId, entityId: noDefault.boxId })).toBe(
      'NLS_MATERIAL_MODEL_MISSING',
    );
  });
});
