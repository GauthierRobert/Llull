/** VC-TMC-01.a through the real solver: restrained bar, uniform 100 K rise, sigma_xx = -E alpha dT = -252 MPa (skipped without ccx). */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeInp } from '@cae/decks/inpWriter';
import { parseFrd } from '@cae/results/frdReader';
import { execute } from '@core/commands/registry';
import { expectCase } from '../../physics/benchmarkCases';
import { PACK, strainModel, withModel } from '../../physics/thermomech/thermomechFixtures';
import { barDocument, barMesh } from '../deckFixtures';

const SOLVER = 'ccx';
const ccxAvailable = spawnSync(SOLVER, ['-v']).error === undefined;

function restrainedBar(): { text: string } {
  const bar = barDocument({ material: 'models', analysisType: 'thermo_static', supports: false });
  let doc = withModel(bar.doc, 'steel', strainModel(1.2e-5));
  const sets: Record<string, number[]> = {};
  const restrain = (name: string, dofs: Record<string, number>, point: number[], nodes: number[]): void => {
    const result = execute(doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name,
      kind: 'displacement',
      dofs,
      target: { entityId: bar.boxId, facesNear: [point] },
    });
    doc = result.document;
    sets[`C_${result.affected[0] ?? ''}`] = nodes;
  };
  restrain('x0', { ux: 0 }, [0, 0.5, 0.5], [1, 3, 5, 7]);
  restrain('x2', { ux: 0 }, [2, 0.5, 0.5], [2, 4, 6, 8]);
  restrain('y0', { uy: 0 }, [1, 0, 0.5], [1, 2, 5, 6]);
  restrain('z0', { uz: 0 }, [1, 0.5, 0], [1, 2, 3, 4]);
  doc = execute(doc, 'set_temperature_field', {
    analysisId: bar.analysisId,
    source: { kind: 'uniform', value: { value: 120, unit: 'degC' } },
  }).document;
  const written = writeInp(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, sets));
  if (!('text' in written)) throw new Error(JSON.stringify(written));
  return written;
}

describe('thermo_static deck through ccx', () => {
  it('writes a complete deck with the thermo-mechanical sections', () => {
    const { text } = restrainedBar();
    expect(text).toContain('*EXPANSION, ZERO=20');
    expect(text).toContain('*INITIAL CONDITIONS, TYPE=TEMPERATURE');
    expect(text).toContain('*TEMPERATURE');
    expect(text.indexOf('*EXPANSION')).toBeLessThan(text.indexOf('*STEP'));
    expect(text).toContain('S, E, THE');
  });

  it.skipIf(!ccxAvailable)('VC-TMC-01.a: fully restrained bar, uniform delta T = 100 K -> sigma_xx = -252 MPa', () => {
    const { text } = restrainedBar();
    const dir = mkdtempSync(join(tmpdir(), 'llull-tmc-'));
    writeFileSync(join(dir, 'job.inp'), text);
    const run = spawnSync(SOLVER, ['-i', 'job'], { cwd: dir, encoding: 'utf8' });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const steps = parseFrd(readFileSync(join(dir, 'job.frd'), 'utf8'));
    const stress = steps[steps.length - 1]?.fields['STRESS'];
    expect(stress).toBeDefined();
    const sxx = Object.values(stress?.values ?? {}).map((components) => components[0] ?? Number.NaN);
    expect(sxx).toHaveLength(8);
    for (const value of sxx) expectCase(PACK, 'VC-TMC-01.a', value);
  });
});
