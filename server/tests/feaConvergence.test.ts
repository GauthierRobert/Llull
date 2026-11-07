/**
 * run_convergence_study end to end through the `llull` CLI (PHY-00 VNV-M3; VC-VNV-10, 13, 17): the 05 cantilever (validation plan
 * vnv_beamp_convergence) meshed with Netgen and solved with CalculiX at three sizes (0.25, 0.5, 1 mm), tip u_y followed through a probe. Skipped without
 * llull-mesh or `ccx`. The extrapolated value must lie within 2 % of 0.0888411 mm (05 VC-FEA-10.b: Euler-Bernoulli + Timoshenko).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { isRecord } from '@lib/isRecord';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { REPO_ROOT } from './packCli';
import { FEA_TOOL_ENV, feaToolsMissing } from './feaTestSupport';

const PLAN = path.join(REPO_ROOT, 'docs/physics/00-vv-harness/validation/plans/vnv_beamp_convergence.plan.json');
const TIP_DEFLECTION_MM = 0.0888411;

let work = '';
let docPath = '';
let analysisId = '';
let probeId = '';

function io(out: string[]): CliIo {
  return {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(''),
    env: { ...FEA_TOOL_ENV },
    prepareKernel: () => Promise.resolve(),
  };
}

async function cli(...argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const out: string[] = [];
  const code = await runCli([...argv, '--doc', docPath, '--json'], io(out));
  const parsed: unknown = JSON.parse(out.join('') || '{}');
  return { code, json: isRecord(parsed) ? parsed : {} };
}

const dataOf = (json: Record<string, unknown>): Record<string, unknown> => (isRecord(json['data']) ? json['data'] : {});
const currentDoc = (): ReturnType<typeof deserializeDocument> => deserializeDocument(readFileSync(docPath, 'utf8'));
const studiesOf = (): string => JSON.stringify(currentDoc().analysis?.cases[analysisId]?.studies);

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'llull-fea-study-'));
  process.env['LLULL_FEA_CACHE'] = path.join(work, 'cache');
  docPath = path.join(work, 'beam.llull.json');
  setGeometryKernel(await createManifoldKernel());
  writeFileSync(path.join(work, 'plan.json'), readFileSync(PLAN));
  const { code, json } = await cli('run', path.join(work, 'plan.json'));
  expect(code, String(json['summary'])).toBe(EXIT_OK);
  const doc = currentDoc();
  analysisId = Object.keys(doc.analysis?.cases ?? {})[0] ?? '';
  probeId = Object.keys(doc.analysis?.cases[analysisId]?.probes ?? {})[0] ?? '';
  expect(analysisId).not.toBe('');
  expect(probeId).not.toBe('');
}, 120_000);

afterAll(() => {
  setGeometryKernel(null);
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(feaToolsMissing())('run_convergence_study (netgen + ccx)', () => {
  const quantity = (): string => JSON.stringify({ kind: 'probe', probeId, loadCase: 'LC1' });

  it('runs three levels, records a verified study whose extrapolated tip deflection matches the beam theory, and is repeatable', async () => {
    const first = await cli(
      'run_convergence_study',
      `analysisId=${analysisId}`,
      `quantity=${quantity()}`,
      'levels=3',
      'ratio=2',
      'timeoutS=300',
    );
    expect(first.code, String(first.json['summary'])).toBe(EXIT_OK);
    expect(currentDoc().analysis?.cases[analysisId]?.meshSummary).toBeUndefined();
    const checked = await cli('check_verification', `analysisId=${analysisId}`, 'gciTarget=0.05');
    expect(checked.code, String(checked.json['summary'])).toBe(EXIT_OK);
    const study = (
      dataOf(checked.json)['studies'] as { state: string; report: { p: number; extrapolated: number; gci21: { fine: number } } }[]
    )[0];
    expect(study?.state).toBe('current');
    expect(Math.abs((study?.report.extrapolated ?? Number.NaN) / TIP_DEFLECTION_MM - 1)).toBeLessThan(0.02);
    const firstStudies = studiesOf();

    const repeat = await cli(
      'delete_convergence_study',
      `analysisId=${analysisId}`,
      `studyId=${Object.keys(currentDoc().analysis?.cases[analysisId]?.studies ?? {})[0]}`,
    );
    expect(repeat.code, String(repeat.json['summary'])).toBe(EXIT_OK);
    const second = await cli(
      'run_convergence_study',
      `analysisId=${analysisId}`,
      `quantity=${quantity()}`,
      'levels=3',
      'ratio=2',
      'timeoutS=300',
    );
    expect(second.code, String(second.json['summary'])).toBe(EXIT_OK);
    const secondStudies = JSON.parse(studiesOf()) as Record<string, unknown>;
    const firstParsed = JSON.parse(firstStudies) as Record<string, unknown>;
    const strip = (studies: Record<string, unknown>): string[] =>
      Object.values(studies).map((study) => JSON.stringify({ ...(study as object), id: 'x' }));
    const identical = JSON.stringify(strip(secondStudies)) === JSON.stringify(strip(firstParsed));
    expect(identical).toBe(true);
    // VC-VNV-17 is judged ONLY from this real-pipeline run (quality:physics reads the measurement file); a machine without the tools skips it
    const target = process.env['LLULL_PHYSICS_MEASUREMENTS'];
    if (target !== undefined && target !== '')
      appendFileSync(
        target,
        `${JSON.stringify({ pack: '00-vv-harness', caseId: 'VC-VNV-17', measured: { value: identical ? 'identical study JSON' : 'different study JSON', unit: '-' } })}
`,
      );

    const changed = await cli('scale_entity', `id=${currentDoc().order[0]}`, 'factor=1.5');
    expect(changed.code, String(changed.json['summary'])).toBe(EXIT_OK);
    const stale = await cli('check_verification', `analysisId=${analysisId}`);
    expect(JSON.stringify(dataOf(stale.json)['items'])).toContain('VNV_STUDY_STALE');
  }, 900_000);
});
