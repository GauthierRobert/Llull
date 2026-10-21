import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeResultsArtifact } from '@core/model/analysis';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseDat } from '@cae/results/datReader';
import { parseFrd } from '@cae/results/frdReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { X0_NODES, barDocument, barMesh, hashOf, mustRun, portOf, solvedBar } from './deckFixtures';
import { caseIn, run } from './helpers';

const sets = (constraints: Record<string, string>): Record<string, number[]> => ({
  [`C_${constraints['x0']}`]: X0_NODES,
  [`C_${constraints['nodeA']}`]: [1],
  [`C_${constraints['nodeB']}`]: [3],
});

const deckOf = (type: 'modal' | 'buckling', withLoad: boolean): { text: string } | { code: string } => {
  const bar = barDocument({ analysisType: type });
  const doc = withLoad
    ? mustRun(bar.doc, 'add_fea_load', {
        analysisId: bar.analysisId,
        name: 'P',
        kind: 'force',
        vector: [-100, 0, 0],
        target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
      })
    : bar.doc;
  const loadKey = Object.keys(caseIn(doc, bar.analysisId).loads)[0];
  const nodeSets = { ...sets(bar.constraints), ...(loadKey === undefined ? {} : { [`L_${loadKey}`]: [2, 4, 6, 8] }) };
  return writeInp(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, nodeSets));
};

describe('modal and buckling decks', () => {
  it('modal writes one *FREQUENCY step with the constraints, no loads and the eigenvectors', () => {
    const written = deckOf('modal', false);
    const text = 'text' in written ? written.text : JSON.stringify(written);
    const step = text.slice(text.indexOf('** modal analysis'));
    expect(step).toBe(
      '** modal analysis\n*STEP\n*FREQUENCY\n6\n*BOUNDARY\nC_fc_8_1, 1, 1\nC_fc_9_1, 2, 2\nC_fc_9_1, 3, 3\nC_fc_10_1, 3, 3\n*NODE FILE\nU\n*END STEP\n',
    );
    expect(text).toContain('*DENSITY');
    expect(text).not.toContain('*STATIC');
  });

  it('buckling writes ONE *BUCKLE step that holds the constraints and the reference load', () => {
    const written = deckOf('buckling', true);
    const text = 'text' in written ? written.text : JSON.stringify(written);
    const step = text.slice(text.indexOf('** buckling reference load case LC1'));
    expect(step.split('\n').slice(0, 4)).toEqual(['** buckling reference load case LC1', '*STEP', '*BUCKLE', '3']);
    expect(step).toContain('*CLOAD, OP=NEW');
    expect(step).toContain('2, 1, -25');
    expect(step.match(/\*STEP/g)).toHaveLength(1);
    expect(step.endsWith('*NODE FILE\nU\n*END STEP\n')).toBe(true);
  });

  it('buckling without any load is refused: the factor multiplies the applied load', () => {
    expect(deckOf('buckling', false)).toMatchObject({ code: 'FEA_NO_LOADS' });
  });
});

describe('create_analysis modal / buckling / factors', () => {
  const empty = barDocument().doc;
  const refused = (result: ReturnType<typeof run>, code: string): void => {
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe(code);
    expect(result.affected).toEqual([]);
  };

  it('accepts modal and buckling with their default and explicit mode counts', () => {
    const modal = run(empty, 'create_analysis', { name: 'm', analysisType: 'modal' });
    expect(caseIn(modal.document, modal.affected[0] ?? '').modes).toBe(6);
    const buckling = run(empty, 'create_analysis', { name: 'b', analysisType: 'buckling', modes: 2 });
    expect(caseIn(buckling.document, buckling.affected[0] ?? '').modes).toBe(2);
    expect(buckling.summary).toContain('2 mode(s)');
    expect(run(empty, 'create_analysis', { name: 's', analysisType: 'static' }).summary).not.toContain('mode(s)');
    for (const analysisType of ['heat_steady', 'heat_transient'])
      expect(run(empty, 'create_analysis', { name: 'h', analysisType }).summary).not.toContain('safety factors');
    for (const analysisType of ['static', 'modal'])
      expect(run(empty, 'create_analysis', { name: 's', analysisType }).summary).toContain('DEFAULT 14 CFR 25.303');
  });

  it('refuses modes on other types and outside 1..100', () => {
    refused(run(empty, 'create_analysis', { name: 's', analysisType: 'static', modes: 3 }), 'FEA_PARAM_NOT_APPLICABLE');
    refused(run(empty, 'create_analysis', { name: 'm', analysisType: 'modal', modes: 0 }), 'FEA_PARAM_INVALID');
    refused(run(empty, 'create_analysis', { name: 'm', analysisType: 'modal', modes: 101 }), 'FEA_PARAM_INVALID');
  });

  it('factor is one number for ultimate and yield, and the summary says it was set', () => {
    const result = run(empty, 'create_analysis', { name: 'f', analysisType: 'static', factor: 2 });
    expect(caseIn(result.document, result.affected[0] ?? '').factors).toEqual({ ultimate: 2, yield: 2, extra: [] });
    expect(result.summary).toContain('safety factors ultimate 2, yield 2 (set by the caller)');
  });

  it('without factor / factors the summary names the defaults and how to change them', () => {
    const result = run(empty, 'create_analysis', { name: 'f', analysisType: 'static' });
    expect(result.summary).toContain('safety factors ultimate 1.5, yield 1 (DEFAULT 14 CFR 25.303');
    expect(result.summary).toContain('pass factor/factors');
  });

  it('refuses factor with factors, and factor below 1', () => {
    refused(
      run(empty, 'create_analysis', { name: 'f', analysisType: 'static', factor: 2, factors: { ultimate: 2, yield: 1 } }),
      'FEA_FACTOR_INVALID',
    );
    refused(run(empty, 'create_analysis', { name: 'f', analysisType: 'static', factor: 0.5 }), 'FEA_FACTOR_INVALID');
  });
});

const EIGEN_DAT = `
                        S T E P       1


     E I G E N V A L U E   O U T P U T

 MODE NO    EIGENVALUE                       FREQUENCY   
                                     REAL PART            IMAGINARY PART
                           (RAD/TIME)      (CYCLES/TIME     (RAD/TIME)

      1   0.1736497E+07   0.1317762E+04   0.2097284E+03   0.0000000E+00
      2   0.6665793E+08   0.8164431E+04   0.1299410E+04   0.0000000E+00

     P A R T I C I P A T I O N   F A C T O R S
`;

const BUCKLE_DAT = `
     B U C K L I N G   F A C T O R   O U T P U T

 MODE NO       BUCKLING
                FACTOR

      1   0.4802456E+01
      2   0.4802488E+01
`;

describe('eigenvalue result readers', () => {
  it('parseDat keeps the frequency table (mode, eigenvalue, rad/s, Hz, imaginary) and the buckling factors', () => {
    const modal = parseDat(EIGEN_DAT);
    expect(modal.tables).toHaveLength(1);
    expect(modal.tables[0]?.rows.map((row) => row[3])).toEqual([209.7284, 1299.41]);
    const buckling = parseDat(BUCKLE_DAT);
    expect(buckling.tables[0]?.rows).toEqual([
      [1, 4.802456],
      [2, 4.802488],
    ]);
    expect(parseDat('no tables here').tables).toEqual([]);
  });

  it('parseFrd gives one result set per mode of a step (same step and increment, distinct set numbers)', () => {
    const block = (counter: number, set: number, time: string, ux: number): string =>
      [
        `    1PSTEP                         ${counter}           1           1          `,
        `  100CL  ${set} ${time}           2                     2    ${counter}MODAL      1`,
        ' -4  DISP        4    1',
        ' -5  D1          1    2    1    0',
        ' -5  D2          1    2    2    0',
        ' -5  D3          1    2    3    0',
        ' -5  ALL         1    2    0    0    1ALL',
        ` -1         1${ux.toExponential(5).toUpperCase().padStart(12)} 0.00000E+00 0.00000E+00`,
        ' -3',
      ].join('\n');
    const steps = parseFrd([block(1, 101, '209.7283706', 1), block(2, 102, '1299.409549', 2)].join('\n'));
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.time)).toEqual([209.7283706, 1299.409549]);
    expect(steps.map((step) => step.fields['DISP']?.values['1']?.[0])).toEqual([1, 2]);
  });
});

describe('modal results recording, report and mode plot', () => {
  const bar = barDocument({ analysisType: 'modal' });
  const mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, sets(bar.constraints));
  const meshHash = hashOf(mesh);
  const displacement = (scale: number): FeResultsArtifact['steps'][number]['fields'] => ({
    DISP: {
      components: ['D1', 'D2', 'D3'],
      values: Object.fromEntries(mesh.nodes.map(([id, x, y]) => [String(id), [0, 0.001 * scale * (x + y), 0]])),
    },
  });
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash,
    inputHash: analysisInputHash(bar.doc, bar.analysisId, 'full'),
    solver: 'calculix',
    solverVersion: '2.21',
    steps: [
      { step: 1, time: 209.7283706, fields: displacement(1) },
      { step: 1, time: 1299.409549, fields: displacement(2) },
    ],
    dat: parseDat(EIGEN_DAT),
  };
  const resultsHash = hashOf(results);
  const context: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(mesh, results) };
  const meshed = execute(bar.doc, 'record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(mesh, meshHash) }, context);
  const solved = execute(
    meshed.document,
    'record_fea_results',
    { analysisId: bar.analysisId, summary: resultsSummary(bar.doc, bar.analysisId, mesh, results, resultsHash) },
    context,
  );

  it('the summary carries the frequencies in Hz and no load cases; the record summary states them', () => {
    expect(solved.rejected).not.toBe(true);
    expect(solved.summary).toContain('2 natural frequencies: 209.728, 1299.41 Hz');
    expect(caseIn(solved.document, bar.analysisId).results).toMatchObject({ frequenciesHz: [209.7284, 1299.41], loadCases: [] });
    const reported = execute(solved.document, 'analysis_report', { analysisId: bar.analysisId }, context);
    expect(reported.summary).toContain('209.728, 1299.41 Hz');
  });

  it('render_fea_results plots the normalised mode shape of the chosen mode, labelled with its frequency', () => {
    const first = execute(solved.document, 'render_fea_results', { analysisId: bar.analysisId }, context);
    expect(first.summary).toContain('mode 1, f = 209.728 Hz');
    expect(first.summary).toContain('normalised |u|');
    const second = execute(solved.document, 'render_fea_results', { analysisId: bar.analysisId, mode: 2 }, context);
    expect(second.summary).toContain('mode 2, f = 1299.41 Hz');
    expect(second.summary).toContain('max 1 normalised |u|');
    expect(second.document).toBe(solved.document);
  });

  it('refuses a mode beyond the extracted ones, mode on a static case, and field mode on a static case', () => {
    const beyond = execute(solved.document, 'render_fea_results', { analysisId: bar.analysisId, mode: 3 }, context);
    expect(beyond.error?.code).toBe('FEA_RESULTS_MISSING');
    expect(beyond.summary).toContain('no mode 3');
    const staticBar = solvedBar();
    const staticContext: ExecutionContext = { ...defaultContext(), feaArtifacts: staticBar.port };
    const staticMeshed = execute(
      staticBar.doc,
      'record_fe_mesh',
      { analysisId: staticBar.analysisId, summary: meshSummary(staticBar.mesh, staticBar.meshHash) },
      staticContext,
    );
    const staticSolved = execute(
      staticMeshed.document,
      'record_fea_results',
      {
        analysisId: staticBar.analysisId,
        summary: resultsSummary(staticBar.doc, staticBar.analysisId, staticBar.mesh, staticBar.results, staticBar.resultsHash),
      },
      staticContext,
    ).document;
    const onStatic = execute(staticSolved, 'render_fea_results', { analysisId: staticBar.analysisId, mode: 1 }, staticContext);
    expect(onStatic.error?.code).toBe('FEA_PLOT_INVALID');
    const fieldOnStatic = execute(staticSolved, 'render_fea_results', { analysisId: staticBar.analysisId, field: 'mode' }, staticContext);
    expect(fieldOnStatic.error?.code).toBe('FEA_PLOT_INVALID');
  });
});
