/** ENG-1 review fixes: load-time value validation, deck defence in depth, displacement-drive reset, hyperelastic vs nlgeom, hash names. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { analysisErrors } from '@cae/model/validate';
import { caseOf, withCase } from '@cae/shared/access';
import { X2_NODES, barDocument, barMesh, facesOn, mustRun } from '../deckFixtures';
import { MPa, NL1_VALIDITY, addModel, defineSet } from '../../physics/materials/materialFixtures';
import { nonlinearBar, pressureBar, pulledBar, step } from './support';

type Json = Record<string, unknown>;

/** The saved form of a pulled bar, mutated by `change` on its nonlinear slice, and the errors the loader reports. */
function loadErrors(change: (nonlinear: Json, stepId: string, probeId: string) => void): string[] {
  const bar = pulledBar();
  const document = JSON.parse(JSON.stringify(bar.doc)) as Json;
  const cases = (document['analysis'] as { cases: Record<string, { nonlinear: Json }> }).cases;
  change(cases[bar.analysisId]!.nonlinear, bar.stepId, bar.probeId);
  return analysisErrors(document);
}

const stepOf = (nonlinear: Json, id: string): Json => (nonlinear['steps'] as Record<string, Json>)[id]!;
const controlOf = (nonlinear: Json, id: string): Json => stepOf(nonlinear, id)['control'] as Json;
const probeOf = (nonlinear: Json, id: string): Json => (nonlinear['probes'] as Record<string, Json>)[id]!;

const INJECTION = '100\n*INCLUDE,INPUT=/etc/passwd';

describe('load-time validation of every nonlinear value (deck injection)', () => {
  it('accepts a saved case unchanged', () => {
    expect(loadErrors(() => undefined)).toEqual([]);
  });

  const cases: [string, (nonlinear: Json, stepId: string, probeId: string) => void, string][] = [
    ['maxIncrements text', (n, s) => (controlOf(n, s)['maxIncrements'] = INJECTION), 'maxIncrements'],
    ['maxIncrements 0', (n, s) => (controlOf(n, s)['maxIncrements'] = 0), 'maxIncrements'],
    ['maxIncrements 1.5', (n, s) => (controlOf(n, s)['maxIncrements'] = 1.5), 'maxIncrements'],
    ['initialIncrement text', (n, s) => (controlOf(n, s)['initialIncrement'] = '0.1\n*X'), 'increments'],
    ['minIncrement above initial', (n, s) => (controlOf(n, s)['minIncrement'] = 0.5), 'increments'],
    ['maxIncrement above 1', (n, s) => (controlOf(n, s)['maxIncrement'] = 2), 'increments'],
    ['maxIncrement text', (n, s) => (controlOf(n, s)['maxIncrement'] = '1'), 'increments'],
    ['dof', (n, s) => (controlOf(n, s)['dof'] = 'ux\n*X'), 'dof must be'],
    ['displacement value text', (n, s) => (controlOf(n, s)['value'] = '1\n*X'), 'value must be finite'],
    ['control kind', (n, s) => (controlOf(n, s)['kind'] = 'riks'), 'control kind'],
    ['amplitude', (n, s) => (stepOf(n, s)['amplitude'] = 'ramp\n*X'), 'amplitude'],
    ['multiplier text', (n, s) => (stepOf(n, s)['multipliers'] = { LC1: '5\n*X' }), 'multiplier'],
    ['step name', (n, s) => (stepOf(n, s)['name'] = 7), 'name must be text'],
    ['probe name', (n, _s, p) => (probeOf(n, p)['name'] = 7), 'name must be text'],
    ['probe load kind', (n, _s, p) => (probeOf(n, p)['load'] = { kind: 'x' }), 'load kind'],
    ['probe component', (n, _s, p) => ((probeOf(n, p)['load'] as Json)['component'] = 'w'), 'component'],
    ['probe constraint id', (n, _s, p) => ((probeOf(n, p)['load'] as Json)['constraintId'] = 3), 'constraintId'],
    ['probe dof', (n, _s, p) => ((probeOf(n, p)['displacement'] as Json)['dof'] = 'q'), 'displacement dof'],
    ['probe point', (n, _s, p) => ((probeOf(n, p)['displacement'] as Json)['point'] = ['1', 0, 0]), 'point'],
    ['nlgeom', (n) => (n['nlgeom'] = 'yes'), 'nlgeom'],
    ['output every text', (n) => (n['outputIncrements'] = { every: '4\n*X' }), 'outputIncrements'],
    ['output every 0', (n) => (n['outputIncrements'] = { every: 0 }), 'outputIncrements'],
    ['output keyword', (n) => (n['outputIncrements'] = 'some'), 'outputIncrements'],
    ['convergence name', (n) => (n['convergence'] = { name: 'fast' }), 'name must be'],
    ['convergence field key', (n) => (n['convergence'] = { name: 'custom', field: { Zz: 1 } }), 'unknown key'],
    ['convergence field text', (n) => (n['convergence'] = { name: 'custom', field: { Rn: '1\n*X' } }), 'finite number'],
    ['convergence field negative', (n) => (n['convergence'] = { name: 'custom', field: { Rn: -1 } }), 'finite number'],
    ['time incrementation fraction', (n) => (n['convergence'] = { name: 'custom', timeIncrementation: { IA: 2.5 } }), '(integer)'],
    ['values on ccx_default', (n) => (n['convergence'] = { name: 'ccx_default', field: { Rn: 1 } }), 'takes no values'],
  ];
  it.each(cases)('rejects %s', (_label, change, expected) => {
    const errors = loadErrors(change);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain(expected);
  });

  it('makes the deck writer refuse the same values even when they got past the loader', () => {
    const bar = pulledBar();
    const analysis = caseOf(bar.doc, bar.analysisId)!;
    const nonlinear = analysis.nonlinear!;
    const original = nonlinear.steps[bar.stepId]!;
    const forged = withCase(bar.doc, {
      ...analysis,
      nonlinear: {
        ...nonlinear,
        steps: { [bar.stepId]: { ...original, control: { ...original.control, maxIncrements: INJECTION } as never } },
      },
    });
    const written = writeInp(forged, bar.analysisId, barMesh(forged, bar.analysisId, bar.boxId, bar.meshSets));
    expect('code' in written && written.code).toBe('NLS_CONTROL_INVALID');
    const output = withCase(bar.doc, { ...analysis, nonlinear: { ...nonlinear, outputIncrements: { every: '3\n*X' } as never } });
    expect(writeInp(output, bar.analysisId, barMesh(output, bar.analysisId, bar.boxId, bar.meshSets))).toMatchObject({
      code: 'NLS_CONTROL_INVALID',
    });
  });
});

describe('displacement drive and later steps (the drive persists in CalculiX)', () => {
  /** step 1 drives the x = 2 face, step 2 is a load step with nothing driven, step 3 drives it again. */
  function mixed(): { doc: CadDocument; text: string } {
    const bar = nonlinearBar();
    let doc = mustRun(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: false });
    const load = step(doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'p',
      kind: 'pressure',
      loadCase: 'LC1',
      magnitude: 1,
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const increments = { initialIncrement: 0.5, minIncrement: 0.1, maxIncrement: 0.5, maxIncrements: 10 };
    const drive = (value: number): Json => ({
      kind: 'displacement',
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
      dof: 'ux',
      value,
      ...increments,
    });
    const first = step(load.doc, 'add_analysis_step', { analysisId: bar.analysisId, name: 'drive', multipliers: {}, control: drive(0.01) });
    const second = step(first.doc, 'add_analysis_step', {
      analysisId: bar.analysisId,
      name: 'release',
      multipliers: { LC1: 0 },
      control: { kind: 'load', ...increments },
    });
    const third = step(second.doc, 'add_analysis_step', {
      analysisId: bar.analysisId,
      name: 'again',
      multipliers: {},
      control: drive(0.02),
    });
    doc = third.doc;
    const mesh = barMesh(
      doc,
      bar.analysisId,
      bar.boxId,
      { ...bar.sets, [`S_${first.id}`]: X2_NODES, [`S_${third.id}`]: X2_NODES },
      { [`L_${load.id}`]: facesOn(X2_NODES) },
    );
    const written = writeInp(doc, bar.analysisId, mesh);
    if (!('text' in written)) throw new Error(written.message);
    return { doc, text: written.text };
  }

  it('restates the constraints with OP=NEW in a step that stops driving, and not where the same drive continues', () => {
    const { text } = mixed();
    const steps = text.split('** step ').slice(1);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain('*BOUNDARY, OP=NEW');
    expect(steps[1]).toContain('*BOUNDARY, OP=NEW\nC_fc_8_1, 1, 1');
    expect(steps[1]).not.toMatch(/S_stp/);
    expect(steps[2]).not.toContain('OP=NEW');
    expect(steps[2]).toMatch(/\*BOUNDARY\nS_stp_\d+_\d+, 1, 1, 0.02/);
  });
});

describe('hyperelastic parts need nlgeom', () => {
  function rubberBar(): ReturnType<typeof nonlinearBar> {
    const bar = nonlinearBar();
    let doc = addModel(
      bar.doc,
      'steel',
      'hyper',
      { kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: { value: 0, unit: '1/MPa' } },
      { validity: NL1_VALIDITY, basis: 'A' },
    );
    doc = defineSet(doc, 'steel', { id: 'rubber', hyperelastic: 'hyper' });
    return { ...bar, doc };
  }
  const params = (bar: { analysisId: string }, nlgeom: boolean): Json => ({ analysisId: bar.analysisId, nlgeom });

  it('refuses nlgeom false for a selected hyperelastic set and the selection while nlgeom is false', () => {
    const bar = rubberBar();
    const selected = mustRun(bar.doc, 'set_part_constitutive_set', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      constitutiveSetId: 'rubber',
    });
    const refused = execute(selected, 'set_nonlinear_controls', params(bar, false));
    expect(refused.error?.code).toBe('NLS_CONTROL_INVALID');
    expect(refused.document).toBe(selected);
    expect(execute(selected, 'set_nonlinear_controls', params(bar, true)).rejected).toBeUndefined();
    const small = mustRun(bar.doc, 'set_nonlinear_controls', params(bar, false));
    const late = execute(small, 'set_part_constitutive_set', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      constitutiveSetId: 'rubber',
    });
    expect(late.error?.code).toBe('NLS_CONTROL_INVALID');
  });

  it('is caught by the deck and by check_analysis when the combination arrives from a loaded document', () => {
    const bar = rubberBar();
    let doc = mustRun(bar.doc, 'set_nonlinear_controls', params(bar, true));
    doc = mustRun(doc, 'set_part_constitutive_set', { analysisId: bar.analysisId, entityId: bar.boxId, constitutiveSetId: 'rubber' });
    doc = step(doc, 'add_analysis_step', {
      analysisId: bar.analysisId,
      name: 's',
      multipliers: {},
      control: { kind: 'load', initialIncrement: 0.5, minIncrement: 0.1, maxIncrement: 0.5, maxIncrements: 5 },
    }).doc;
    const analysis = caseOf(doc, bar.analysisId)!;
    const forged = withCase(doc, { ...analysis, nonlinear: { ...analysis.nonlinear!, nlgeom: false } });
    const written = writeInp(forged, bar.analysisId, barMesh(forged, bar.analysisId, bar.boxId, bar.sets));
    expect('code' in written && written.code).toBe('NLS_CONTROL_INVALID');
    const items = (execute(forged, 'check_analysis', { analysisId: bar.analysisId }).data as { items: { code: string }[] }).items;
    expect(items.map((item) => item.code)).toContain('NLS_CONTROL_INVALID');
  });
});

describe('plain elastic materials', () => {
  it('need no constitutive set: check_analysis is clean and the deck is written from the property models', () => {
    const bar = barDocument({ material: 'models', analysisType: 'nonlinear_static' });
    let doc = mustRun(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: true });
    doc = step(doc, 'add_analysis_step', {
      analysisId: bar.analysisId,
      name: 's',
      multipliers: {},
      control: { kind: 'load', initialIncrement: 0.5, minIncrement: 0.1, maxIncrement: 0.5, maxIncrements: 5 },
    }).doc;
    const items = (execute(doc, 'check_analysis', { analysisId: bar.analysisId }).data as { items: { code: string }[] }).items;
    expect(items.map((item) => item.code)).not.toContain('NLS_MATERIAL_MODEL_MISSING');
    const sets = {
      [`C_${bar.constraints['x0']}`]: [1, 3, 5, 7],
      [`C_${bar.constraints['nodeA']}`]: [1],
      [`C_${bar.constraints['nodeB']}`]: [3],
    };
    const written = writeInp(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, sets));
    expect('text' in written && written.text).toContain('*ELASTIC\n210000');
  });

  it('refuses a selected set that was deleted after the selection', () => {
    const bar = pulledBar();
    const analysis = caseOf(bar.doc, bar.analysisId)!;
    const forged = withCase(bar.doc, { ...analysis, nonlinear: { ...analysis.nonlinear!, constitutiveSets: { [bar.boxId]: 'ghost' } } });
    const written = writeInp(forged, bar.analysisId, barMesh(forged, bar.analysisId, bar.boxId, bar.meshSets));
    expect('code' in written && written.code).toBe('NLS_MATERIAL_MODEL_MISSING');
  });
});

describe('purity and hash of names', () => {
  it('add_analysis_step and add_curve_probe do not touch their input document', () => {
    const bar = pressureBar();
    const before = JSON.stringify(bar.doc);
    execute(bar.doc, 'add_analysis_step', {
      analysisId: bar.analysisId,
      name: 'again',
      multipliers: { LC1: 10 },
      control: { kind: 'load', initialIncrement: 0.5, minIncrement: 0.1, maxIncrement: 0.5, maxIncrements: 5 },
    });
    execute(bar.doc, 'add_curve_probe', {
      analysisId: bar.analysisId,
      name: 'more',
      load: { kind: 'load', loadId: bar.loadId },
      displacement: { point: [2, 0, 0], dof: 'ux' },
    });
    expect(JSON.stringify(bar.doc)).toBe(before);
  });

  it('step and probe names are presentation: renaming keeps the hash, any physical change does not', () => {
    const bar = pressureBar();
    const analysis = caseOf(bar.doc, bar.analysisId)!;
    const nonlinear = analysis.nonlinear!;
    const renamed = withCase(bar.doc, {
      ...analysis,
      nonlinear: {
        ...nonlinear,
        steps: Object.fromEntries(Object.entries(nonlinear.steps).map(([id, entry]) => [id, { ...entry, name: `${entry.name} renamed` }])),
        probes: Object.fromEntries(Object.entries(nonlinear.probes).map(([id, entry]) => [id, { ...entry, name: 'other' }])),
      },
    });
    const hash = (doc: CadDocument): string => analysisInputHash(doc, bar.analysisId, 'full');
    expect(hash(renamed)).toBe(hash(bar.doc));
    const firstStep = nonlinear.stepOrder[0]!;
    const changed = withCase(bar.doc, {
      ...analysis,
      nonlinear: { ...nonlinear, steps: { ...nonlinear.steps, [firstStep]: { ...nonlinear.steps[firstStep]!, multipliers: { LC1: 51 } } } },
    });
    expect(hash(changed)).not.toBe(hash(bar.doc));
  });
});

describe('time incrementation values are integers', () => {
  it('refuses a fractional iteration count at command time', () => {
    const bar = nonlinearBar();
    const result = execute(bar.doc, 'set_nonlinear_controls', {
      analysisId: bar.analysisId,
      nlgeom: true,
      convergence: { name: 'custom', timeIncrementation: { IA: 2.5 } },
    });
    expect(result.error?.code).toBe('NLS_CONTROL_INVALID');
    expect(result.document).toBe(bar.doc);
  });
});
