import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeResultsArtifact, FeaLoad } from '@core/model/analysis';
import { extractCurves } from '@cae/nonlinear/curves';
import { loadBaseValue, multiplierAt } from '@cae/nonlinear/history';
import { nlsRemediation } from '@cae/nonlinear/codes';
import { caseOf } from '@cae/shared/access';
import { nonlinearBar, pulledBar } from './support';

type Table = NonNullable<FeResultsArtifact['dat']>['tables'][number];

const load = (extra: Partial<FeaLoad>): FeaLoad => ({ id: 'l', name: 'l', loadCase: 'LC1', category: 'limit', kind: 'force', ...extra });
const setName = (prefix: string, id: string): string => `${prefix}_${id}`.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
const table = (title: string, row: number[]): Table => ({ title, time: 0.5, rows: [row] });

describe('load base values and multipliers', () => {
  it('uses the magnitude of pressures and the vector length of forces, moments and gravity', () => {
    expect(loadBaseValue(load({ kind: 'pressure', magnitude: 2.5 }))).toBe(2.5);
    expect(loadBaseValue(load({ kind: 'force', vector: [3, 4, 0] }))).toBe(5);
    expect(loadBaseValue(load({ kind: 'gravity', vector: [0, 0, -9810] }))).toBe(9810);
    expect(loadBaseValue(load({ kind: 'moment' }))).toBe(0);
  });

  it('is 0 for a case without steps', () => {
    const bar = nonlinearBar();
    const controlled = execute(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: true }).document;
    const nonlinear = caseOf(controlled, bar.analysisId)?.nonlinear;
    expect(nonlinear && multiplierAt(nonlinear, 'LC1', 0.5)).toBe(0);
  });
});

describe('curve components', () => {
  it('reads the y component, the magnitude of a reaction and of a displacement from the same tables', () => {
    const bar = pulledBar();
    const magnitude = execute(bar.doc, 'add_curve_probe', {
      analysisId: bar.analysisId,
      name: 'mag',
      load: { kind: 'reaction', constraintId: 'x0', component: 'magnitude' },
      displacement: { point: [2, 0, 0], dof: 'magnitude' },
    });
    const second = execute(magnitude.document, 'add_curve_probe', {
      analysisId: bar.analysisId,
      name: 'y',
      load: { kind: 'reaction', constraintId: 'x0', component: 'y' },
      displacement: { point: [2, 0, 0], dof: 'uy' },
    });
    const analysis = caseOf(second.document, bar.analysisId);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    const tables = [
      table(`total force (fx,fy,fz) for set ${setName('C', bar.constraints['x0'] ?? '')} and time 5.0E-01`, [3, 4, 0]),
      ...[magnitude.affected[0], second.affected[0]].map((id) =>
        table(`displacements (vx,vy,vz) for set ${setName('N', id ?? '')} and time 5.0E-01`, [2, 0.3, 0.4, 0]),
      ),
    ];
    const results: FeResultsArtifact = {
      kind: 'fe_results',
      meshHash: 'm',
      inputHash: 'i',
      solver: 'CalculiX',
      solverVersion: '2',
      steps: [],
      dat: { tables },
    };
    const curves = extractCurves(analysis, results);
    expect(curves.map((curve) => curve.name)).toEqual(['pull_curve', 'mag', 'y']);
    expect(curves[0]?.time).toEqual([0]);
    expect(curves[1]).toMatchObject({ time: [0, 0.5], load: [0, 5], displacement: [0, 0.5] });
    expect(curves[2]).toMatchObject({ time: [0, 0.5], load: [0, 4], displacement: [0, 0.4] });
  });

  it('has a fallback remediation text for codes it does not know', () => {
    expect(nlsRemediation('NLS_NOT_CONVERGED')).toContain('smaller initial increment');
    expect(nlsRemediation('SOMETHING_ELSE')).toBe('see the command description');
  });
});
