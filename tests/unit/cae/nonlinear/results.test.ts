import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeResultsArtifact } from '@core/model/analysis';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseDat } from '@cae/results/datReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { extractCurves } from '@cae/nonlinear/curves';
import { multiplierAt } from '@cae/nonlinear/history';
import { classifyNonlinearStop, parseSta } from '@cae/nonlinear/solverLog';
import { caseOf } from '@cae/shared/access';
import { hashOf, portOf } from '../deckFixtures';
import { meshOf, pressureBar, pulledBar } from './support';

const TIMES = [0.1, 0.3, 0.55, 0.8, 1];
const sci = (value: number): string =>
  value
    .toExponential(7)
    .toUpperCase()
    .replace(/E([+-])(\d)$/, (_match, sign: string, digit: string) => `E${sign}0${digit}`);

/** A `.dat` text with one displacement table (node 2) and one total-force table (constraint x0) per stored increment. */
function datText(constraintSet: string, probeSet: string): string {
  return TIMES.map((time) => {
    const ux = 0.01 * time;
    const force = -Math.min(250, 105000 * ux);
    return [
      '',
      ` displacements (vx,vy,vz) for set ${probeSet} and time  ${sci(time)}`,
      '',
      `         2  ${sci(ux)}  ${sci(0)}  ${sci(0)}`,
      '',
      ` total force (fx,fy,fz) for set ${constraintSet} and time  ${sci(time)}`,
      '',
      `  ${sci(force)}  ${sci(0)}  ${sci(0)}`,
    ].join('\n');
  }).join('\n');
}

const STA = `
 SUMMARY OF JOB INFORMATION
  STEP      INC     ATT   ITRS     TOT TIME     STEP TIME      INC TIME
     1        1       1      1  1.00000E-01  1.00000E-01  1.00000E-01
     1        2       2      4  3.00000E-01  3.00000E-01  2.00000E-01
     1        3       1      3  5.50000E-01  5.50000E-01  2.50000E-01
     1        4       1      2  8.00000E-01  8.00000E-01  2.50000E-01
     1        5       3      5  1.00000E+00  1.00000E+00  2.00000E-01
`;

function solved(): { bar: ReturnType<typeof pulledBar>; mesh: ReturnType<typeof meshOf>; results: FeResultsArtifact; hash: string } {
  const bar = pulledBar();
  const mesh = meshOf(bar);
  const set = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const dat = parseDat(datText(set(`C_${bar.constraints['x0']}`), set(`N_${bar.probeId}`)));
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(bar.doc, bar.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: TIMES.map((time) => ({
      step: 1,
      time,
      fields: {
        DISP: { components: ['D1', 'D2', 'D3'], values: { '2': [0.01 * time, 0, 0] } },
        STRESS: {
          components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'],
          values: { '5': [Math.min(250, 210000 * 0.005 * time), 0, 0, 0, 0, 0] },
        },
        PE: { components: ['PE'], values: { '5': [Math.max(0, time - 0.3) * 0.004] } },
      },
    })),
    dat,
    convergence: parseSta(STA),
  };
  return { bar, mesh, results, hash: hashOf(results) };
}

describe('solver log readers', () => {
  it('parses the .sta table into one row per increment', () => {
    const rows = parseSta(STA);
    expect(rows).toHaveLength(5);
    expect(rows[1]).toEqual({ step: 1, increment: 2, attempts: 2, iterations: 4, totalTime: 0.3 });
    expect(parseSta('nothing here\n')).toEqual([]);
  });

  it('classifies the three stop reasons from the real ccx 2.21 error lines and leaves other failures unclassified', () => {
    expect(
      classifyNonlinearStop(' divergence; the increment size is decreased to 1.25e-01\n\n *ERROR: increment size smaller than minimum\n'),
    ).toBe('NLS_INCREMENT_TOO_SMALL');
    expect(classifyNonlinearStop(' *ERROR in nonlingeo: max. # of increments reached\n')).toBe('NLS_MAX_INCREMENTS');
    expect(classifyNonlinearStop(' *ERROR: too many cutbacks\n')).toBe('NLS_NOT_CONVERGED');
    expect(classifyNonlinearStop(' *ERROR: too many iterations needed\n')).toBe('NLS_NOT_CONVERGED');
    expect(classifyNonlinearStop(' *ERROR: solution seems to diverge; please try\n')).toBe('NLS_NOT_CONVERGED');
    expect(classifyNonlinearStop('*ERROR reading input deck')).toBeNull();
  });

  it('does not mistake the lines of a normal run with cutbacks for a stop', () => {
    const normal =
      ' no convergence\n divergence; the increment size is decreased to 1.250000e-01\n the increment is reattempted\n convergence\n';
    expect(classifyNonlinearStop(normal)).toBeNull();
    expect(classifyNonlinearStop(`${normal} *ERROR in readinput: bad keyword\n`)).toBeNull();
  });
});

describe('curve probes read per increment', () => {
  it('builds the reaction-displacement curve from the .dat tables, starting at the origin', () => {
    const { bar, results } = solved();
    const analysis = caseOf(bar.doc, bar.analysisId);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    const [curve] = extractCurves(analysis, results);
    expect(curve?.probeId).toBe(bar.probeId);
    expect(curve?.time).toEqual([0, ...TIMES]);
    expect(curve?.displacement.map((value) => Number(value.toFixed(6)))).toEqual([0, 0.001, 0.003, 0.0055, 0.008, 0.01]);
    expect(curve?.load.map((value) => Number(value.toFixed(3)))).toEqual([0, -105, -250, -250, -250, -250]);
  });

  it('gives only the origin when the tables of the probe are absent', () => {
    const { bar, results } = solved();
    const analysis = caseOf(bar.doc, bar.analysisId);
    if (analysis === undefined) return;
    const [curve] = extractCurves(analysis, { ...results, dat: { tables: [] } });
    expect(curve?.time).toEqual([0]);
    const { nonlinear, ...linear } = analysis;
    expect(nonlinear).toBeDefined();
    expect(extractCurves(linear, results)).toEqual([]);
  });

  it('plots a load probe as base value x the ramped multiplier of the steps (load, unload)', () => {
    const bar = pressureBar();
    const nonlinear = caseOf(bar.doc, bar.analysisId)?.nonlinear;
    expect(nonlinear).toBeDefined();
    if (nonlinear === undefined) return;
    expect([0.5, 1, 1.5, 2].map((time) => multiplierAt(nonlinear, 'LC1', time))).toEqual([25, 50, 25, 0]);
    expect(multiplierAt(nonlinear, 'LC1', 0)).toBe(0);
    expect(multiplierAt(nonlinear, 'LC1', 9)).toBe(0);
    const stepped = pressureBar({ amplitude: 'step' }).doc;
    const stepNonlinear = caseOf(stepped, bar.analysisId)?.nonlinear;
    expect(stepNonlinear && multiplierAt(stepNonlinear, 'LC1', 0.1)).toBe(50);
  });
});

describe('nonlinear results summary and trust', () => {
  it('summarises steps, convergence, curves and the plastic peak', () => {
    const { bar, mesh, results, hash } = solved();
    const summary = resultsSummary(bar.doc, bar.analysisId, mesh, results, hash);
    expect(summary.nonlinear).toMatchObject({
      nlgeom: true,
      completed: true,
      steps: [{ increments: 5, cutbacks: 3, iterations: 15, lastLoadFactor: 1, completed: true }],
      curves: [{ probeId: bar.probeId, name: 'pull_curve', points: 6, peakLoad: -250 }],
    });
    expect(summary.nonlinear?.curves[0]?.dispRange).toEqual([0, 0.01]);
    expect(summary.nonlinear?.maxPeeq?.value).toBeCloseTo(0.0028, 9);
    expect(summary.loadCases).toHaveLength(1);
    expect(summary.loadCases[0]).toMatchObject({ name: 'pull', category: 'limit' });
    expect(JSON.stringify(summary)).toBe(JSON.stringify(resultsSummary(bar.doc, bar.analysisId, mesh, results, hash)));
  });

  it('falls back to the stored result sets when the artifact has no .sta, and flags an unfinished step', () => {
    const { bar, mesh, results, hash } = solved();
    const { convergence, ...bare } = results;
    expect(convergence).toBeDefined();
    const partial: FeResultsArtifact = { ...bare, steps: bare.steps.slice(0, 3) };
    const summary = resultsSummary(bar.doc, bar.analysisId, mesh, partial, hash);
    expect(summary.nonlinear?.steps[0]).toMatchObject({ increments: 3, cutbacks: 0, iterations: 0, completed: false });
    expect(summary.nonlinear?.completed).toBe(false);
    expect(summary.nonlinear?.steps[0]?.lastLoadFactor).toBeCloseTo(0.55, 12);
  });

  it('records through record_fea_results with the convergence info in the summary and refuses a hand-edited one', () => {
    const { bar, mesh, results, hash } = solved();
    const meshHash = hashOf(mesh);
    const context: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(mesh, results) };
    const meshed = execute(bar.doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(mesh, meshHash) }, context);
    expect(meshed.error).toBeUndefined();
    const summary = resultsSummary(meshed.document, bar.analysisId, mesh, results, hash);
    const recorded = execute(meshed.document, 'record_fea_results', { analysisId: bar.analysisId, summary }, context);
    expect(recorded.error).toBeUndefined();
    expect(recorded.summary).toContain('nonlinear (nlgeom true): 1 step(s), 5 increment(s), 3 cutback(s), all steps completed');
    expect(recorded.summary).toContain("curve 'pull_curve' 6 points, peak load -250");
    const described = execute(recorded.document, 'describe_analysis', { analysisId: bar.analysisId }, context);
    expect((described.data as { state: string }).state).toBe('solved');
    const forged = { ...summary, nonlinear: { ...summary.nonlinear, completed: false } };
    const refused = execute(meshed.document, 'record_fea_results', { analysisId: bar.analysisId, summary: forged }, context);
    expect(refused.error?.code).toBe('FEA_SUMMARY_MISMATCH');
  });

  it('turns stale when a nonlinear setting changes (the input hash covers the nonlinear set-up)', () => {
    const bar = pulledBar();
    const before = analysisInputHash(bar.doc, bar.analysisId, 'full');
    const changed = execute(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: false });
    expect(analysisInputHash(changed.document, bar.analysisId, 'full')).not.toBe(before);
    expect(analysisInputHash(changed.document, bar.analysisId, 'mesh')).toBe(analysisInputHash(bar.doc, bar.analysisId, 'mesh'));
    const moved = execute(bar.doc, 'add_curve_probe', {
      analysisId: bar.analysisId,
      name: 'again',
      load: { kind: 'reaction', constraintId: 'x0', component: 'x' },
      displacement: { point: [1, 0, 0], dof: 'ux' },
    });
    expect(analysisInputHash(moved.document, bar.analysisId, 'mesh')).not.toBe(analysisInputHash(bar.doc, bar.analysisId, 'mesh'));
  });
});
