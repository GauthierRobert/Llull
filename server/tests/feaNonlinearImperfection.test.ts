/**
 * PHY-05 VC-NLS-50 with the real tools (Netgen llull-mesh + CalculiX; skipped without them): the imperfect column of
 * docs/physics/05-nonlinear-structural/validation/plans/nls_column_imperfection.plan.json. The plan runs in two parts: the set-up, then (after
 * fea_mesh + fea_solve of the buckling case) add_imperfection with the 0.5 mm first-mode amplitude, the two load steps and the tip probe.
 *   VC-NLS-50.a  buckling factor (1 N reference) = P_cr = pi^2 E I / L^2 = 4605.815 N (2 %)
 *   VC-NLS-50.b  additional tip deflection at 0.5 P_cr = w0 (P/Pcr) / (1 - P/Pcr) = 0.5 mm (5 %)
 *   VC-NLS-50.c  same at 0.8 P_cr = 2.0 mm (5 %)
 * The mesh is coarsened from the plan's 2.5 mm to 4 mm (quadratic tets, 2.5 elements through the 10 mm thickness) to keep the run short.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import type { FeResultsArtifact } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import { extractCurves } from '@cae/nonlinear/curves';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { defaultFeArtifactStore } from '../src/fea/artifactStore';
import { REPO_ROOT } from './packCli';
import { FEA_TOOL_ENV, feaToolsMissing } from './feaTestSupport';

const PLAN = 'docs/physics/05-nonlinear-structural/validation/plans/nls_column_imperfection.plan.json';
const MESH_SIZE = 4;
/** Generator VC-NLS-50 (expected_results.json): E 70 GPa, 20 x 10 mm, pinned L = 500 mm (= fixed-free 250 mm), w0 = 0.5 mm. */
const P_CR = 4605.81538718;
const W0 = 0.5;

let work = '';

function io(out: string[]): CliIo {
  return {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(''),
    env: { ...FEA_TOOL_ENV },
    prepareKernel: () => Promise.resolve(),
  };
}

async function cli(docPath: string, ...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const out: string[] = [];
  const code = await runCli([...argv, '--doc', docPath, '--json'], io(out));
  const parsed: unknown = JSON.parse(out.join('') || '{}');
  return { code, json: isRecord(parsed) ? parsed : {} };
}

const dataOf = (json: Record<string, unknown>): Record<string, unknown> => (isRecord(json['data']) ? json['data'] : {});

type Action = { command: string; params: Record<string, unknown>; as?: string };

/** Run `actions` as a plan file on the document. */
async function runActions(docPath: string, name: string, actions: readonly Action[]): Promise<void> {
  const planPath = path.join(work, `${name}.plan.json`);
  writeFileSync(planPath, JSON.stringify(actions));
  const ran = await cli(docPath, 'run', planPath);
  expect(ran.code, String(ran.json['summary'])).toBe(EXIT_OK);
}

async function meshAndSolve(docPath: string, analysisId: string): Promise<Record<string, unknown>> {
  const meshed = await cli(docPath, 'fea_mesh', `analysisId=${analysisId}`);
  expect(meshed.code, String(meshed.json['summary'])).toBe(EXIT_OK);
  const solved = await cli(docPath, 'fea_solve', `analysisId=${analysisId}`, 'timeoutS=1200');
  expect(solved.code, String(solved.json['summary'])).toBe(EXIT_OK);
  return solved.json;
}

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'llull-fea-imperfect-'));
  process.env['LLULL_FEA_CACHE'] = path.join(work, 'cache');
  setGeometryKernel(await createManifoldKernel());
}, 60_000);

afterAll(() => {
  setGeometryKernel(null);
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(feaToolsMissing())('PHY-05 imperfect column with ccx (VC-NLS-50)', () => {
  it('buckles at pi^2 E I / L^2 and amplifies a 0.5 mm first-mode imperfection by (P/Pcr) / (1 - P/Pcr)', async () => {
    const plan = (JSON.parse(readFileSync(path.join(REPO_ROOT, PLAN), 'utf8')) as Action[]).map((action) =>
      action.command === 'set_mesh_controls' ? { ...action, params: { ...action.params, globalSize: MESH_SIZE } } : action,
    );
    const split = plan.findIndex((action) => action.command === 'add_imperfection');
    const docPath = path.join(work, 'column.llull.json');
    await runActions(docPath, 'setup', plan.slice(0, split));
    const setup = deserializeDocument(readFileSync(docPath, 'utf8'));
    const [bucklingId = '', nonlinearId = ''] = setup.analysis?.caseOrder ?? [];
    const columnId = Object.keys(setup.entities)[0] ?? '';

    const buckled = await meshAndSolve(docPath, bucklingId);
    const factors = (deserializeDocument(readFileSync(docPath, 'utf8')).analysis?.cases[bucklingId]?.results?.bucklingFactors ??
      []) as number[];
    const pcr = factors[0] ?? Number.NaN;
    expect(Math.abs(pcr / P_CR - 1), `buckling factor ${pcr} (${String(buckled['summary'])})`).toBeLessThan(0.02);

    const ids = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll('"$bk"', `"${bucklingId}"`)
          .replaceAll('"$an"', `"${nonlinearId}"`)
          .replaceAll('"$col"', `"${columnId}"`),
      );
    await runActions(
      docPath,
      'imperfect',
      plan.slice(split).map((action) => ids(action) as Action),
    );
    const solved = await meshAndSolve(docPath, nonlinearId);
    const results = defaultFeArtifactStore().get(String(dataOf(solved)['resultsHash'])) as FeResultsArtifact;
    const analysis = deserializeDocument(readFileSync(docPath, 'utf8')).analysis?.cases[nonlinearId];
    expect(analysis?.nonlinear?.imperfectionOrder).toHaveLength(1);
    const [curve] = analysis === undefined ? [] : extractCurves(analysis, results);
    expect(curve, 'the plan has one curve probe').toBeDefined();
    if (curve === undefined) return;
    const at = (time: number): number => {
      const index = curve.time.findIndex((value) => Math.abs(value - time) < 1e-9);
      expect(index, `a stored increment at time ${time}`).toBeGreaterThan(0);
      return Math.abs(curve.displacement[index] ?? Number.NaN);
    };
    const measured = { half: at(1), eightTenths: at(2) };
    const amplified = (ratio: number): number => (W0 * ratio) / (1 - ratio);
    // the measured numbers of the real run, recorded in TECHNICAL_SPEC 13
    process.stderr.write(
      `VC-NLS-50 measured: Pcr ${pcr} N; tip w - w0 at 0.5 Pcr ${measured.half} mm, at 0.8 Pcr ${measured.eightTenths} mm; FE-Pcr oracle ${amplified((0.5 * P_CR) / pcr)} / ${amplified((0.8 * P_CR) / pcr)} mm\n`,
    );
    expect(Math.abs(measured.half / amplified(0.5) - 1)).toBeLessThan(0.05);
    expect(Math.abs(measured.eightTenths / amplified(0.8) - 1)).toBeLessThan(0.05);
  }, 2_400_000);
});
