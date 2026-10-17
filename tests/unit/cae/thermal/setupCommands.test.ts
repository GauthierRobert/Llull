import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { amplitudeAt, sineAmplitude } from '@cae/thermal/amplitude';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { addBc, caseOf, thermalFixture } from './fixtures';

const run = (doc: CadDocument, command: string, params: Record<string, unknown>): CommandResult => execute(doc, command, params);

function expectRefused(result: CommandResult, doc: CadDocument, code: string): void {
  expectNoOp(result, doc);
  expect(result.rejected).toBe(true);
  expect(result.error?.code).toBe(code);
  expect(result.error?.remediation.length).toBeGreaterThan(5);
}

const face = (boxId: string): Record<string, unknown> => ({ entityId: boxId, facesNear: [[0.5, 0.5, 0]] });

describe('set_initial_temperature', () => {
  it('records the temperature as given and refuses bad units, steady-state mistakes and unknown analyses', () => {
    const { doc, analysisId } = thermalFixture({ type: 'heat_transient' });
    const result = run(doc, 'set_initial_temperature', { analysisId, value: 293.15, unit: 'K' });
    expect(result.affected).toEqual([analysisId]);
    expect(caseOf(result.document, analysisId).thermal?.initialTemperature).toEqual({ value: 293.15, unit: 'K' });
    expectPure(doc, () => run(doc, 'set_initial_temperature', { analysisId, value: 20, unit: 'degC' }));
    expectRefused(run(doc, 'set_initial_temperature', { analysisId, value: 20, unit: 'W' }), doc, 'THM_UNITS_MISMATCH');
    expectRefused(run(doc, 'set_initial_temperature', { analysisId, value: -400, unit: 'degC' }), doc, 'THM_UNITS_MISMATCH');
    expectRefused(run(doc, 'set_initial_temperature', { analysisId: 'ghost', value: 20, unit: 'degC' }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    const mechanical = run(doc, 'create_analysis', { name: 's', analysisType: 'static' });
    expectRefused(
      run(mechanical.document, 'set_initial_temperature', { analysisId: mechanical.affected[0], value: 1, unit: 'K' }),
      mechanical.document,
      'THM_CASE_TYPE',
    );
  });
});

describe('define_amplitude / delete_amplitude', () => {
  it('samples a sine deterministically from 0 to durationS inclusive (NAFEMS T3: 100 sin(pi t / 40))', () => {
    const { doc, analysisId } = thermalFixture({ type: 'heat_transient' });
    const result = run(doc, 'define_amplitude', {
      analysisId,
      name: 'sine40',
      kind: 'sine',
      amplitude: 1,
      periodS: 80,
      sampleStepS: 0.5,
      durationS: 32,
    });
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^am-\d+\.1$/);
    const amplitude = caseOf(result.document, analysisId).thermal?.amplitudes[id];
    expect(amplitude?.points).toHaveLength(65);
    expect(amplitude?.points[0]).toEqual([0, 0]);
    expect(amplitude?.points[64]?.[0]).toBe(32);
    for (const [t, f] of amplitude?.points ?? []) expect(f).toBeCloseTo(Math.sin((Math.PI * t) / 40), 11);
    expect(amplitude?.generatedFrom).toEqual({ kind: 'sine', params: { amplitude: 1, periodS: 80, sampleStepS: 0.5, durationS: 32 } });
    const again = run(doc, 'define_amplitude', {
      analysisId,
      name: 'sine40',
      kind: 'sine',
      amplitude: 1,
      periodS: 80,
      sampleStepS: 0.5,
      durationS: 32,
    });
    expect(again.document).toEqual(result.document);
    expectPure(doc, () => run(doc, 'define_amplitude', { analysisId, name: 'x', kind: 'sine', periodS: 4, sampleStepS: 1, durationS: 4 }));
  });

  it('keeps exact zeros and the last time exactly durationS when the step does not divide it', () => {
    expect(sineAmplitude(1, 4, 1, 4)).toEqual([
      [0, 0],
      [1, 1],
      [2, 0],
      [3, -1],
      [4, 0],
    ]);
    const points = sineAmplitude(2, 10, 3, 10) ?? [];
    expect(points.map(([t]) => t)).toEqual([0, 3, 6, 9, 10]);
  });

  it('samples ramps and stores tables; interpolation holds the end values', () => {
    const { doc, analysisId } = thermalFixture({ type: 'heat_transient' });
    const ramp = run(doc, 'define_amplitude', { analysisId, name: 'r', kind: 'ramp', amplitude: 2, durationS: 10 });
    expect(caseOf(ramp.document, analysisId).thermal?.amplitudes[ramp.affected[0] ?? '']?.points).toEqual([
      [0, 0],
      [10, 2],
    ]);
    const sampled = run(doc, 'define_amplitude', { analysisId, name: 'r2', kind: 'ramp', durationS: 4, sampleStepS: 1 });
    expect(caseOf(sampled.document, analysisId).thermal?.amplitudes[sampled.affected[0] ?? '']?.points).toEqual([
      [0, 0],
      [1, 0.25],
      [2, 0.5],
      [3, 0.75],
      [4, 1],
    ]);
    const table = run(doc, 'define_amplitude', {
      analysisId,
      name: 't',
      kind: 'table',
      points: [
        [0, 1],
        [10, 3],
      ],
    });
    const points = caseOf(table.document, analysisId).thermal?.amplitudes[table.affected[0] ?? '']?.points ?? [];
    expect(amplitudeAt(points, -5)).toBe(1);
    expect(amplitudeAt(points, 5)).toBe(2);
    expect(amplitudeAt(points, 99)).toBe(3);
    expect(amplitudeAt([], 1)).toBe(1);
  });

  it('refuses invalid curves with THM_AMPLITUDE_INVALID and duplicate names', () => {
    const { doc, analysisId } = thermalFixture({ type: 'heat_transient' });
    const base = { analysisId, name: 'a' };
    expectRefused(run(doc, 'define_amplitude', { ...base, kind: 'table' }), doc, 'THM_AMPLITUDE_INVALID');
    expectRefused(run(doc, 'define_amplitude', { ...base, kind: 'table', points: [] }), doc, 'THM_AMPLITUDE_INVALID');
    expectRefused(
      run(doc, 'define_amplitude', {
        ...base,
        kind: 'table',
        points: [
          [0, 1],
          [0, 2],
        ],
      }),
      doc,
      'THM_AMPLITUDE_INVALID',
    );
    expectRefused(
      run(doc, 'define_amplitude', {
        ...base,
        kind: 'table',
        points: [
          [2, 1],
          [1, 2],
        ],
      }),
      doc,
      'THM_AMPLITUDE_INVALID',
    );
    expectRefused(run(doc, 'define_amplitude', { ...base, kind: 'sine', sampleStepS: 1, durationS: 5 }), doc, 'THM_AMPLITUDE_INVALID');
    expectRefused(
      run(doc, 'define_amplitude', { ...base, kind: 'sine', periodS: 4, sampleStepS: 0, durationS: 5 }),
      doc,
      'THM_AMPLITUDE_INVALID',
    );
    expectRefused(
      run(doc, 'define_amplitude', { ...base, kind: 'sine', periodS: 4, sampleStepS: 1e-4, durationS: 5 }),
      doc,
      'THM_AMPLITUDE_INVALID',
    );
    expectRefused(run(doc, 'define_amplitude', { ...base, kind: 'ramp' }), doc, 'THM_AMPLITUDE_INVALID');
    expectRefused(run(doc, 'define_amplitude', { ...base, kind: 'ramp', durationS: 5, sampleStepS: -1 }), doc, 'THM_AMPLITUDE_INVALID');
    expectRefused(
      run(doc, 'define_amplitude', { analysisId: 'ghost', name: 'a', kind: 'ramp', durationS: 5 }),
      doc,
      'FEA_ANALYSIS_NOT_FOUND',
    );
    const first = run(doc, 'define_amplitude', { ...base, kind: 'ramp', durationS: 5 });
    expectRefused(
      run(first.document, 'define_amplitude', { ...base, kind: 'ramp', durationS: 6 }),
      first.document,
      'THM_AMPLITUDE_INVALID',
    );
  });

  it('deletes an amplitude unless a BC still references it', () => {
    const fixture = thermalFixture({ type: 'heat_transient' });
    const { analysisId, boxId } = fixture;
    const made = run(fixture.doc, 'define_amplitude', { analysisId, name: 'a', kind: 'ramp', durationS: 5 });
    const id = made.affected[0] ?? '';
    const used = addBc(
      { ...fixture, doc: made.document },
      { name: 'q', kind: 'surface_flux', value: 1, unit: 'W/m^2', amplitude: id, target: face(boxId) },
    );
    expectRefused(run(used.doc, 'delete_amplitude', { analysisId, amplitudeId: id }), used.doc, 'THM_AMPLITUDE_IN_USE');
    const removed = run(made.document, 'delete_amplitude', { analysisId, amplitudeId: id });
    expect(removed.affected).toEqual([id]);
    expect(caseOf(removed.document, analysisId).thermal?.amplitudes).toEqual({});
    expectRefused(run(made.document, 'delete_amplitude', { analysisId, amplitudeId: 'ghost' }), made.document, 'THM_AMPLITUDE_NOT_FOUND');
    expectRefused(
      run(made.document, 'delete_amplitude', { analysisId: 'ghost', amplitudeId: id }),
      made.document,
      'FEA_ANALYSIS_NOT_FOUND',
    );
  });
});

describe('set_thermal_step', () => {
  const transient = (): { doc: CadDocument; analysisId: string } => thermalFixture({ type: 'heat_transient' });

  it('stores and merges step fields', () => {
    const { doc, analysisId } = transient();
    const first = run(doc, 'set_thermal_step', {
      analysisId,
      endTimeS: 32,
      initialIncrementS: 0.5,
      maxIncrementS: 1,
      outputEveryS: 2,
      maxTemperatureChangePerIncrement: { value: 5, unit: 'K' },
    });
    expect(first.affected).toEqual([analysisId]);
    const second = run(first.document, 'set_thermal_step', { analysisId, endTimeS: 40 });
    expect(caseOf(second.document, analysisId).thermal?.step).toEqual({
      endTimeS: 40,
      initialIncrementS: 0.5,
      maxIncrementS: 1,
      outputEveryS: 2,
      maxTemperatureChangePerIncrement: { value: 5, unit: 'K' },
    });
    const fixed = run(doc, 'set_thermal_step', {
      analysisId,
      endTimeS: 32,
      initialIncrementS: 0.5,
      fixedIncrements: true,
      outputEveryS: 2,
    });
    expect(caseOf(fixed.document, analysisId).thermal?.step.fixedIncrements).toBe(true);
    expectPure(doc, () => run(doc, 'set_thermal_step', { analysisId, endTimeS: 5 }));
  });

  it('refuses inconsistent steps with THM_STEP_INVALID', () => {
    const { doc, analysisId } = transient();
    const bad = (params: Record<string, unknown>): void =>
      expectRefused(run(doc, 'set_thermal_step', { analysisId, ...params }), doc, 'THM_STEP_INVALID');
    bad({});
    bad({ endTimeS: 0 });
    bad({ endTimeS: 10, initialIncrementS: 11 });
    bad({ endTimeS: 10, minIncrementS: 2, maxIncrementS: 1 });
    bad({ endTimeS: 10, initialIncrementS: 3, maxIncrementS: 2 });
    bad({ endTimeS: 10, initialIncrementS: 1, minIncrementS: 2 });
    bad({ endTimeS: 10, outputTimesS: [1, 2], outputEveryS: 1 });
    bad({ endTimeS: 10, outputTimesS: [] });
    bad({ endTimeS: 10, outputTimesS: [2, 1] });
    bad({ endTimeS: 10, outputTimesS: [11] });
    bad({ endTimeS: 10, fixedIncrements: true });
    bad({ endTimeS: 10, fixedIncrements: true, initialIncrementS: 1, outputTimesS: [2] });
    bad({ endTimeS: 10, fixedIncrements: true, initialIncrementS: 1, maxTemperatureChangePerIncrement: { value: 1, unit: 'K' } });
    bad({ endTimeS: 10, fixedIncrements: true, initialIncrementS: 0.4, outputEveryS: 1 });
    bad({ endTimeS: 10, maxTemperatureChangePerIncrement: { value: -1, unit: 'K' } });
    bad({ endTimeS: 10, maxTemperatureChangePerIncrement: { value: 1, unit: 'degC' } });
    expectRefused(run(doc, 'set_thermal_step', { analysisId: 'ghost', endTimeS: 1 }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    const steady = thermalFixture();
    expectRefused(run(steady.doc, 'set_thermal_step', { analysisId: steady.analysisId, endTimeS: 1 }), steady.doc, 'THM_STEP_INVALID');
    const empty = run(steady.doc, 'set_thermal_step', { analysisId: steady.analysisId });
    expect(empty.rejected).toBeUndefined();
  });
});

describe('add_temperature_limit / delete_temperature_limit', () => {
  const source = { citation: 'component datasheet DS-12', locator: 'table 4' };

  it('adds part and target limits with the source, and deletes them with their dispositions', () => {
    const { doc, analysisId, boxId } = thermalFixture();
    const part = run(doc, 'add_temperature_limit', {
      analysisId,
      name: 'board',
      entityId: boxId,
      max: { value: 85, unit: 'degC' },
      source,
    });
    const id = part.affected[0] ?? '';
    expect(id).toMatch(/^tl-\d+\.1$/);
    expect(caseOf(part.document, analysisId).thermal?.limits[id]).toEqual({
      id,
      name: 'board',
      scope: { entityId: boxId },
      max: { value: 85, unit: 'degC' },
      source,
    });
    const target = run(part.document, 'add_temperature_limit', {
      analysisId,
      name: 'face',
      target: { entityId: boxId, facesNear: [[0.5, 0.5, 0]] },
      min: { value: -40, unit: 'degC' },
      max: { value: 358.15, unit: 'K' },
      source: { citation: 'rule' },
    });
    expect(caseOf(target.document, analysisId).thermal?.limitOrder).toEqual([id, target.affected[0]]);
    expectPure(doc, () =>
      run(doc, 'add_temperature_limit', { analysisId, name: 'b', entityId: boxId, max: { value: 1, unit: 'K' }, source }),
    );
    const withDisposition = {
      ...target.document,
      analysis: {
        ...target.document.analysis!,
        cases: {
          ...target.document.analysis!.cases,
          [analysisId]: {
            ...caseOf(target.document, analysisId),
            thermal: {
              ...caseOf(target.document, analysisId).thermal!,
              dispositions: {
                [`${id}:max`]: { decision: 'accepted' as const, justification: 'j', resultsHash: 'h', signer: 's', signatureId: 'x' },
              },
            },
          },
        },
      },
    };
    const removed = run(withDisposition, 'delete_temperature_limit', { analysisId, limitId: id });
    expect(removed.affected).toEqual([id]);
    expect(caseOf(removed.document, analysisId).thermal).toMatchObject({ limitOrder: [target.affected[0]], dispositions: {} });
    expectRefused(run(doc, 'delete_temperature_limit', { analysisId, limitId: 'ghost' }), doc, 'THM_LIMIT_NOT_FOUND');
    expectRefused(run(doc, 'delete_temperature_limit', { analysisId: 'ghost', limitId: id }), doc, 'FEA_ANALYSIS_NOT_FOUND');
  });

  it('refuses a missing source (THM_LIMIT_SOURCE_REQUIRED) and invalid scopes, bounds and units', () => {
    const { doc, analysisId, boxId } = thermalFixture();
    const max = { value: 85, unit: 'degC' };
    const base = { analysisId, name: 'l', entityId: boxId, max, source };
    expectRefused(run(doc, 'add_temperature_limit', { ...base, source: undefined }), doc, 'THM_LIMIT_SOURCE_REQUIRED');
    expectRefused(run(doc, 'add_temperature_limit', { ...base, source: { citation: '  ' } }), doc, 'THM_LIMIT_SOURCE_REQUIRED');
    expectRefused(run(doc, 'add_temperature_limit', { ...base, max: undefined }), doc, 'THM_LIMIT_INVALID');
    expectRefused(run(doc, 'add_temperature_limit', { ...base, entityId: undefined }), doc, 'THM_LIMIT_INVALID');
    expectRefused(
      run(doc, 'add_temperature_limit', { ...base, target: { entityId: boxId, facesNear: [[0, 0, 0]] } }),
      doc,
      'THM_LIMIT_INVALID',
    );
    expectRefused(run(doc, 'add_temperature_limit', { ...base, min: { value: 90, unit: 'degC' } }), doc, 'THM_LIMIT_INVALID');
    expectRefused(run(doc, 'add_temperature_limit', { ...base, max: { value: 5, unit: 'W' } }), doc, 'THM_UNITS_MISMATCH');
    expectRefused(run(doc, 'add_temperature_limit', { ...base, min: { value: 5, unit: 'm' } }), doc, 'THM_UNITS_MISMATCH');
    expectRefused(run(doc, 'add_temperature_limit', { ...base, entityId: 'ghost' }), doc, 'FEA_PART_NOT_IN_ANALYSIS');
    expectRefused(
      run(doc, 'add_temperature_limit', { ...base, entityId: undefined, target: { entityId: 'ghost', facesNear: [[0, 0, 0]] } }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expectRefused(run(doc, 'add_temperature_limit', { ...base, analysisId: 'ghost' }), doc, 'FEA_ANALYSIS_NOT_FOUND');
  });
});

describe('add_cavity_radiation / add_thermal_contact', () => {
  const faces = (boxId: string): Record<string, unknown>[] => [
    { target: { entityId: boxId, facesNear: [[0.5, 0.5, 0]] }, emissivity: 0.9 },
    { target: { entityId: boxId, facesNear: [[0.5, 0.5, 0.05]] }, emissivity: 0.8 },
  ];

  it('records open and closed cavities and refuses bad names, emissivities, faces and units', () => {
    const { doc, analysisId, boxId } = thermalFixture();
    const open = run(doc, 'add_cavity_radiation', {
      analysisId,
      name: 'C1',
      environmentTemperature: { value: 300, unit: 'K' },
      faces: faces(boxId),
    });
    const id = open.affected[0] ?? '';
    expect(id).toMatch(/^cv-\d+\.1$/);
    expect(caseOf(open.document, analysisId).thermal?.cavities[id]).toMatchObject({
      name: 'C1',
      environment: { kind: 'open', temperature: { value: 300 } },
    });
    const closed = run(open.document, 'add_cavity_radiation', { analysisId, name: 'C2', faces: faces(boxId) });
    expect(caseOf(closed.document, analysisId).thermal?.cavities[closed.affected[0] ?? '']?.environment).toEqual({ kind: 'closed' });
    expectPure(doc, () => run(doc, 'add_cavity_radiation', { analysisId, name: 'C1', faces: faces(boxId) }));
    expectRefused(
      run(open.document, 'add_cavity_radiation', { analysisId, name: 'c1', faces: faces(boxId) }),
      open.document,
      'THM_CAVITY_INVALID',
    );
    expectRefused(run(doc, 'add_cavity_radiation', { analysisId, name: 'LONG', faces: faces(boxId) }), doc, 'THM_CAVITY_INVALID');
    expectRefused(run(doc, 'add_cavity_radiation', { analysisId, name: 'C1', faces: faces(boxId).slice(0, 1) }), doc, 'THM_CAVITY_INVALID');
    expectRefused(
      run(doc, 'add_cavity_radiation', { analysisId, name: 'C1', faces: [{ ...faces(boxId)[0], emissivity: 2 }, faces(boxId)[1]] }),
      doc,
      'THM_EMISSIVITY_INVALID',
    );
    expectRefused(
      run(doc, 'add_cavity_radiation', {
        analysisId,
        name: 'C1',
        faces: [{ target: { entityId: boxId, pointsNear: [[0, 0, 0]] }, emissivity: 1 }, faces(boxId)[1]],
      }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expectRefused(
      run(doc, 'add_cavity_radiation', {
        analysisId,
        name: 'C1',
        faces: [{ target: { entityId: 'ghost', facesNear: [[0, 0, 0]] }, emissivity: 1 }, faces(boxId)[1]],
      }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expectRefused(
      run(doc, 'add_cavity_radiation', { analysisId, name: 'C1', environmentTemperature: { value: 1, unit: 'W' }, faces: faces(boxId) }),
      doc,
      'THM_UNITS_MISMATCH',
    );
    expectRefused(
      run(doc, 'add_cavity_radiation', { analysisId: 'ghost', name: 'C1', faces: faces(boxId) }),
      doc,
      'FEA_ANALYSIS_NOT_FOUND',
    );
  });

  it('records contacts between two parts and refuses the same part, bad conductance and units', () => {
    const fixture = thermalFixture();
    const { analysisId, boxId } = fixture;
    const second = run(fixture.doc, 'add_box', { size: [1, 1, 0.05], position: [0, 0, 0.05] });
    const otherId = second.affected[0] ?? '';
    const parted = run(second.document, 'set_part_idealization', { analysisId, entityId: otherId });
    const master = { entityId: boxId, facesNear: [[0.5, 0.5, 0.05]] };
    const slave = { entityId: otherId, facesNear: [[0.5, 0.5, 0.05]] };
    const made = run(parted.document, 'add_thermal_contact', {
      analysisId,
      name: 'iface',
      master,
      slave,
      conductance: { value: 2000, unit: 'W/(m^2*K)' },
    });
    const id = made.affected[0] ?? '';
    expect(id).toMatch(/^tc-\d+\.1$/);
    expect(caseOf(made.document, analysisId).thermal?.contacts[id]).toMatchObject({ name: 'iface', conductance: { value: 2000 } });
    const table = run(parted.document, 'add_thermal_contact', {
      analysisId,
      name: 'iface',
      master,
      slave,
      conductance: {
        points: [
          [1000, 1, 20],
          [2000, 5, 20],
        ],
      },
    });
    expect(table.rejected).toBeUndefined();
    expectPure(parted.document, () =>
      run(parted.document, 'add_thermal_contact', { analysisId, name: 'i', master, slave, conductance: { value: 1, unit: 'W/(m^2*K)' } }),
    );
    const doc = parted.document;
    const bad = (params: Record<string, unknown>, code: string): void =>
      expectRefused(
        run(doc, 'add_thermal_contact', { analysisId, name: 'i', master, slave, conductance: { value: 1, unit: 'W/(m^2*K)' }, ...params }),
        doc,
        code,
      );
    bad({ slave: master }, 'THM_CONTACT_INVALID');
    bad({ conductance: { value: 0, unit: 'W/(m^2*K)' } }, 'THM_CONTACT_INVALID');
    bad({ conductance: { points: [] } }, 'THM_CONTACT_INVALID');
    bad({ conductance: { points: [[-1, 1, 1]] } }, 'THM_CONTACT_INVALID');
    bad({ conductance: { value: 1, unit: 'W' } }, 'THM_UNITS_MISMATCH');
    bad({ master: { entityId: 'ghost', facesNear: [[0, 0, 0]] } }, 'FEA_TARGET_UNRESOLVED');
    bad({ slave: { entityId: otherId, pointsNear: [[0, 0, 0]] } }, 'FEA_TARGET_UNRESOLVED');
    bad({ analysisId: 'ghost' }, 'FEA_ANALYSIS_NOT_FOUND');
  });
});
