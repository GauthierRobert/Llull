import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { parseDat } from '@cae/results/datReader';
import { parseFrd } from '@cae/results/frdReader';
import { resultsSummary } from '@cae/results/summary';
import { X0_NODES, X2_NODES, barDocument, barMesh, facesOn, hashOf, solvedBar } from './deckFixtures';

/** The CalculiX binary: `LLULL_CCX` or `ccx` on the PATH (the tests are skipped when it cannot be started). */
const CCX = process.env['LLULL_CCX'] ?? 'ccx';
const hasCcx = spawnSync(CCX, ['-v']).error === undefined;

interface Run {
  readonly steps: FeResultsArtifact['steps'];
  readonly dat: ReturnType<typeof parseDat>;
  readonly results: FeResultsArtifact;
}

/** Write the deck, run ccx 2.x on it in a temporary directory and parse the FRD / DAT it produces. */
function solve(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact): Run {
  const written = writeInp(doc, analysisId, mesh);
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  const dir = mkdtempSync(join(tmpdir(), 'llull-ccx-'));
  try {
    writeFileSync(join(dir, 'job.inp'), written.text);
    const ran = spawnSync(CCX, ['-i', 'job'], { cwd: dir, encoding: 'utf8' });
    if (ran.status !== 0) throw new Error(`ccx failed: ${ran.stdout}\n${ran.stderr}`);
    const steps = parseFrd(readFileSync(join(dir, 'job.frd'), 'utf8'));
    const dat = parseDat(readFileSync(join(dir, 'job.dat'), 'utf8'));
    const results: FeResultsArtifact = {
      kind: 'fe_results',
      meshHash: hashOf(mesh),
      inputHash: '',
      solver: 'CalculiX',
      solverVersion: '2',
      steps,
      dat,
    };
    return { steps, dat, results };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!hasCcx)('CalculiX closed-form checks of the written deck', () => {
  it('axial bar under a prescribed end displacement: sigma = E * u / L and the reaction F = sigma * A within 1e-6', () => {
    const bar = solvedBar();
    const { steps, dat, results } = solve(bar.doc, bar.analysisId, bar.mesh);
    const stress = steps[0]?.fields['STRESS']?.values ?? {};
    expect(Object.keys(stress)).toHaveLength(8);
    for (const values of Object.values(stress)) expect(Math.abs((values[0] ?? 0) - 210) / 210).toBeLessThan(1e-6);
    const probeTable = dat.tables.find((table) => table.title.startsWith('displacements'));
    expect(probeTable).toBeDefined();
    expect(probeTable?.rows.find((row) => row[0] === 2)?.[1]).toBeCloseTo(0.002, 9);
    const summary = resultsSummary(bar.doc, bar.analysisId, bar.mesh, results, 'h');
    expect(Math.abs((summary.loadCases[0]?.maxVonMises.value ?? 0) - 210) / 210).toBeLessThan(1e-6);
  });

  it('bar under end pressure: sigma_xx = -p and u = -p * L / E; the next load case does not inherit the pressure', () => {
    const base = barDocument();
    const pressure = execute(base.doc, 'add_fea_load', {
      analysisId: base.analysisId,
      name: 'p',
      kind: 'pressure',
      magnitude: 10,
      loadCase: 'LC1',
      target: { entityId: base.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const gravity = execute(pressure.document, 'add_fea_load', {
      analysisId: base.analysisId,
      name: 'g',
      kind: 'gravity',
      vector: [0, 0, -9810],
      loadCase: 'LC2',
    });
    const sets = {
      [`C_${base.constraints['x0']}`]: X0_NODES,
      [`C_${base.constraints['nodeA']}`]: [1],
      [`C_${base.constraints['nodeB']}`]: [3],
    };
    const mesh = barMesh(gravity.document, base.analysisId, base.boxId, sets, { [`L_${pressure.affected[0]}`]: facesOn(X2_NODES) });
    const { steps, results } = solve(gravity.document, base.analysisId, mesh);
    expect(steps.map((step) => step.step)).toEqual([1, 2]);
    for (const values of Object.values(steps[0]?.fields['STRESS']?.values ?? {}))
      expect(Math.abs((values[0] ?? 0) + 10)).toBeLessThan(1e-5);
    expect(steps[0]?.fields['DISP']?.values['2']?.[0]).toBeCloseTo((-10 * 2) / 210000, 9);
    for (const values of Object.values(steps[1]?.fields['STRESS']?.values ?? {})) expect(Math.abs(values[0] ?? 0)).toBeLessThan(1e-2);
    const summary = resultsSummary(gravity.document, base.analysisId, mesh, results, 'h');
    expect(summary.loadCases.map((lc) => lc.name)).toEqual(['LC1', 'LC2']);
    expect(summary.loadCases[0]?.maxVonMises.value).toBeCloseTo(10, 4);
  });

  it('distributes a total force over the end nodes: the reaction balances it', () => {
    const base = barDocument({ supports: false });
    const force = execute(base.doc, 'add_fea_load', {
      analysisId: base.analysisId,
      name: 'f',
      kind: 'force',
      vector: [100, 0, 0],
      target: { entityId: base.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const fixedX = execute(force.document, 'add_fea_constraint', {
      analysisId: base.analysisId,
      name: 'rf',
      kind: 'fixed',
      target: { entityId: base.boxId, facesNear: [[0, 0.5, 0.5]] },
    });
    const sets = { [`C_${fixedX.affected[0]}`]: X0_NODES, [`L_${force.affected[0]}`]: X2_NODES };
    const mesh = barMesh(fixedX.document, base.analysisId, base.boxId, sets);
    const { steps } = solve(fixedX.document, base.analysisId, mesh);
    const displacement = steps[0]?.fields['DISP']?.values ?? {};
    // mean end displacement is F L / (E A) for a bar of 2 x 1 x 1 mm, within the Poisson restraint of the fixed end
    const mean = X2_NODES.reduce((sum, id) => sum + (displacement[String(id)]?.[0] ?? 0), 0) / 4;
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan((100 * 2) / 210000 + 1e-9);
  });
});
