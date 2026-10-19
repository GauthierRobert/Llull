/** PHY-04 M4b: transient coupled_temperature_displacement step: set-up, deck text, checks, per-increment results. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeResultsArtifact } from '@core/model/analysis';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseFrd } from '@cae/results/frdReader';
import { resultsSummary } from '@cae/results/summary';
import { transientResults, transientSummaryText } from '@cae/thermomech/transientSummary';
import { coupledFixture, textOf } from './coupledSupport';

const STEP = { endTimeS: 100, initialIncrementS: 1, maxIncrementS: 10, minIncrementS: 0.001 };

describe('set_thermal_step on a coupled case', () => {
  it('makes the case transient with its fields, and a steady coupled case keeps an empty step', () => {
    const { doc, analysisId } = coupledFixture();
    expect(doc.analysis?.cases[analysisId]?.thermomech?.thermal?.step).toEqual({});
    const result = execute(doc, 'set_thermal_step', { analysisId, ...STEP, outputEveryS: 10 });
    expect(result.rejected).not.toBe(true);
    expect(result.affected).toEqual([analysisId]);
    expect(result.document.analysis?.cases[analysisId]?.thermomech?.thermal?.step).toMatchObject({ endTimeS: 100, outputEveryS: 10 });
    expect(Object.keys(result.document.analysis?.cases[analysisId]?.thermomech?.thermal?.step ?? {}).length).toBe(5);
  });

  it('refuses a step without endTimeS, a bad increment, and leaves the document unchanged', () => {
    const { doc, analysisId } = coupledFixture();
    for (const bad of [{ initialIncrementS: 1 }, { endTimeS: 10, initialIncrementS: 20 }, { endTimeS: -1 }]) {
      const result = execute(doc, 'set_thermal_step', { analysisId, ...bad });
      expect(result.error?.code).toBe('THM_STEP_INVALID');
      expect(result.document).toBe(doc);
    }
  });
});

describe('transient coupled deck', () => {
  it('writes the transient step, specific heat once, no thermal density, the time points and the outputs on them', () => {
    const { doc, analysisId, mesh } = coupledFixture({
      transient: { ...STEP, maxTemperatureChangePerIncrement: { value: 5, unit: 'K' }, outputTimesS: [10, 50, 100] },
    });
    const text = textOf(writeInp(doc, analysisId, mesh));
    expect(text).toContain(`** coupled temperature-displacement analysis ${analysisId}: transient to 100 s, T_ref 20 degC, start 20 degC`);
    expect(text).toContain('*TIME POINTS, NAME=TP_OUT\n10, 50, 100\n');
    expect(text).toContain('*STEP, INC=10000\n*COUPLED TEMPERATURE-DISPLACEMENT, DELTMX=5\n1, 100, 0.001, 10\n');
    expect(text).not.toContain('STEADY STATE');
    expect(text.match(/\*SPECIFIC HEAT/g)).toHaveLength(1);
    expect(text).toMatch(/\*SPECIFIC HEAT\n[0-9.e+]+\n/);
    expect(text.match(/\*DENSITY/g)).toHaveLength(1);
    expect(text).toContain('*NODE FILE, TIME POINTS=TP_OUT\nU, NT\n*EL FILE, TIME POINTS=TP_OUT\nS, HFL\n*END STEP');
    expect(text).not.toContain('*STATIC');
    expect(text).not.toContain('OP=NEW\n*TEMPERATURE');
    expect(writeInp(doc, analysisId, mesh)).toEqual(writeInp(doc, analysisId, mesh));
  });

  it('writes fixed increments with FREQUENCY output and the thermal BC amplitude block before the step', () => {
    const { doc, analysisId, mesh } = coupledFixture({
      amplitude: true,
      transient: { endTimeS: 10, initialIncrementS: 0.5, fixedIncrements: true, outputEveryS: 2 },
    });
    const text = textOf(writeInp(doc, analysisId, mesh));
    expect(text).toContain('*COUPLED TEMPERATURE-DISPLACEMENT, DIRECT\n0.5, 10\n');
    expect(text).toContain('*NODE FILE, FREQUENCY=4\nU, NT\n');
    const amplitude = text.indexOf('*AMPLITUDE, NAME=');
    expect(amplitude).toBeGreaterThan(text.indexOf('*INITIAL CONDITIONS') - 200);
    expect(amplitude).toBeLessThan(text.indexOf('*STEP'));
    expect(text).toMatch(/\*BOUNDARY, AMPLITUDE=AM_/);
  });

  it('a start temperature equal to T_ref needs no pre-heating; a different one runs a *STATIC step first', () => {
    const same = coupledFixture({ initial: 20, transient: STEP });
    expect(textOf(writeInp(same.doc, same.analysisId, same.mesh))).not.toContain('*STATIC');
    const hot = coupledFixture({ initial: 90, transient: STEP });
    const text = textOf(writeInp(hot.doc, hot.analysisId, hot.mesh));
    expect(text).toContain('start 90 degC');
    const preheat = text.slice(text.indexOf('** pre-heating'), text.indexOf('*COUPLED TEMPERATURE-DISPLACEMENT'));
    expect(preheat).toContain('*STEP\n*STATIC\n1, 1\n');
    expect(preheat).toContain('*BOUNDARY, OP=NEW');
    expect(preheat).toContain('*TEMPERATURE\n1, 90\n2, 90\n3, 90\n4, 90\n5, 90\n*END STEP');
    expect(text).toContain('*TEMPERATURE, OP=NEW\n');
    expect(text.indexOf('*TEMPERATURE, OP=NEW')).toBeGreaterThan(text.indexOf('*COUPLED TEMPERATURE-DISPLACEMENT'));
    expect(text).toMatch(/\*INITIAL CONDITIONS, TYPE=TEMPERATURE\n1, 20\n/);
  });

  it('needs cp on the material and refuses a steady-state step with amplitudes (TMC_COUPLED_UNSUPPORTED)', () => {
    const noCp = coupledFixture({ withCp: false, transient: STEP });
    expect(writeInp(noCp.doc, noCp.analysisId, noCp.mesh)).toMatchObject({ code: 'THM_MATERIAL_NO_CP' });
    const steady = coupledFixture({ amplitude: true });
    expect(writeInp(steady.doc, steady.analysisId, steady.mesh)).toMatchObject({ code: 'TMC_COUPLED_UNSUPPORTED' });
  });

  it('refuses more than 20000 result times', () => {
    const { doc, analysisId, mesh } = coupledFixture({ transient: { endTimeS: 100000, outputEveryS: 1 } });
    expect(writeInp(doc, analysisId, mesh)).toMatchObject({ code: 'THM_STEP_INVALID' });
  });

  it('check_thermo_mechanical reminds of the defaulted start and of the pre-heating step', () => {
    const none = coupledFixture({ transient: STEP });
    const codes = (id: string, doc: typeof none.doc): string[] =>
      (execute(doc, 'check_thermo_mechanical', { analysisId: id }).data as { items: { code: string }[] }).items.map((item) => item.code);
    expect(codes(none.analysisId, none.doc)).toEqual(['TMC_TRANSIENT_START_DEFAULTED']);
    const same = coupledFixture({ initial: 20, transient: STEP });
    expect(codes(same.analysisId, same.doc)).toEqual([]);
    const hot = coupledFixture({ initial: 90, transient: STEP });
    expect(codes(hot.analysisId, hot.doc)).toEqual(['TMC_TRANSIENT_PREHEAT']);
    const steady = coupledFixture();
    expect(codes(steady.analysisId, steady.doc)).toEqual([]);
  });

  it('the input hash moves with the time period', () => {
    const a = coupledFixture({ transient: STEP });
    const b = execute(a.doc, 'set_thermal_step', { analysisId: a.analysisId, endTimeS: 200 });
    expect(analysisInputHash(b.document, a.analysisId, 'full')).not.toBe(analysisInputHash(a.doc, a.analysisId, 'full'));
  });
});

const field = (components: string[], values: Record<string, number[]>): FeResultsArtifact['steps'][number]['fields'][string] => ({
  components,
  values,
});

/** One written increment: von Mises of [s,0,0,0,0,0] = s at node 2 (the others s / 2), displacement magnitude u at node 3, temperature t + node id. */
function increment(step: number, time: number, s: number, u: number, t: number): FeResultsArtifact['steps'][number] {
  return {
    step,
    time,
    fields: {
      DISP: field(['D1', 'D2', 'D3'], { '1': [0, 0, 0], '3': [u, 0, 0] }),
      STRESS: field(['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], { '1': [s / 2, 0, 0, 0, 0, 0], '2': [s, 0, 0, 0, 0, 0] }),
      NDTEMP: field(['T'], { '1': [t], '2': [t + 10], '3': [t + 5] }),
    },
  };
}

describe('transient results (per time increment)', () => {
  const fixture = coupledFixture({ transient: { endTimeS: 100 } });
  const results = (offset: number, step: number): FeResultsArtifact => ({
    kind: 'fe_results',
    meshHash: 'm',
    inputHash: 'i',
    solver: 'ccx',
    solverVersion: '2.21',
    steps: [
      ...(step > 1 ? [{ step: 1, time: 1, fields: { DISP: field(['D1', 'D2', 'D3'], { '1': [9, 0, 0] }) } }] : []),
      increment(step, offset + 10, 50, 0.01, 30),
      increment(step, offset + 50, 120, 0.04, 80),
      increment(step, offset + 100, 90, 0.05, 119),
    ],
  });
  const analysisCase = fixture.doc.analysis?.cases[fixture.analysisId];

  it('records the series, the peaks (first wins ties) and the peak as the load case', () => {
    const found = analysisCase === undefined ? undefined : transientResults(analysisCase, fixture.mesh, results(0, 1));
    expect(found?.summary.series).toEqual([
      { timeS: 10, maxVonMises: 50, maxDisplacement: 0.01, maxTemperature: 40, minTemperature: 30 },
      { timeS: 50, maxVonMises: 120, maxDisplacement: 0.04, maxTemperature: 90, minTemperature: 80 },
      { timeS: 100, maxVonMises: 90, maxDisplacement: 0.05, maxTemperature: 129, minTemperature: 119 },
    ]);
    expect(found?.summary.peakVonMises).toEqual({ value: 120, timeS: 50, at: [10, 0, 0], entityId: fixture.boxId });
    expect(found?.summary.peakDisplacement).toMatchObject({ value: 0.05, timeS: 100 });
    expect(found?.loadCases).toEqual([
      {
        name: 'thermal',
        category: 'limit',
        maxVonMises: { value: 120, at: [10, 0, 0], entityId: fixture.boxId },
        maxDisplacement: { value: 0.05, at: [0, 10, 0] },
      },
    ]);
  });

  it('measures times from the start of the coupled step when a pre-heating step came first', () => {
    const found = analysisCase === undefined ? undefined : transientResults(analysisCase, fixture.mesh, results(1, 2));
    expect(found?.summary.series.map((row) => row.timeS)).toEqual([10, 50, 100]);
  });

  it('resultsSummary carries it and the report text names the peak', () => {
    const summary = resultsSummary(fixture.doc, fixture.analysisId, fixture.mesh, results(0, 1), 'hash');
    expect(summary.thermomechTransient?.series).toHaveLength(3);
    expect(summary.loadCases).toHaveLength(1);
    expect(transientSummaryText(summary)).toBe(
      '; transient: 3 increment(s) to t=100 s, peak von Mises 120 at t=50 s, peak displacement 0.05 at t=100 s',
    );
    const steady = coupledFixture();
    expect(resultsSummary(steady.doc, steady.analysisId, steady.mesh, results(0, 1), 'hash').thermomechTransient).toBeUndefined();
    expect(transientSummaryText({ ...summary, thermomechTransient: undefined } as never)).toBe('');
  });

  it('is undefined without increments carrying displacement, stress and temperature, and for a steady case', () => {
    const empty: FeResultsArtifact = { ...results(0, 1), steps: [{ step: 1, time: 5, fields: {} }] };
    expect(analysisCase === undefined ? 0 : transientResults(analysisCase, fixture.mesh, empty)).toBeUndefined();
    const noTemperature: FeResultsArtifact = {
      ...results(0, 1),
      steps: [{ step: 1, time: 100, fields: { ...increment(1, 100, 1, 1, 1).fields, NDTEMP: field(['T'], {}) } }],
    };
    expect(analysisCase === undefined ? 0 : transientResults(analysisCase, fixture.mesh, noTemperature)).toBeUndefined();
    const steady = coupledFixture();
    const steadyCase = steady.doc.analysis?.cases[steady.analysisId];
    expect(steadyCase === undefined ? 0 : transientResults(steadyCase, steady.mesh, results(0, 1))).toBeUndefined();
  });

  it('reads the increments of an FRD file with two steps (pre-heating, then the transient)', () => {
    const frd = (step: number, increment: number, time: number, t: number): string =>
      [
        `    1PSTEP                         ${increment}           ${increment}           ${step}          `,
        `  100CL  ${100 + increment} ${time.toExponential(5).toUpperCase().padStart(11)}           2                     2    ${step}           1`,
        ' -4  NDTEMP      1    1',
        ' -5  T           1    1    1    0',
        ` -1         1${t.toExponential(5).toUpperCase().padStart(12)}`,
        ' -3',
      ].join('\n');
    const steps = parseFrd(`${frd(1, 1, 1, 20)}\n${frd(2, 1, 11, 25)}\n${frd(2, 2, 101, 90)}\n`);
    expect(steps.map((step) => [step.step, step.time])).toEqual([
      [1, 1],
      [2, 11],
      [2, 101],
    ]);
    expect(steps.at(-1)?.fields['NDTEMP']?.values['1']).toEqual([90]);
  });
});
