/** Hostile-input table: the recorded creep summary read by creep_report / check_creep (a tampered or malformed `results.creep`). */
import { execute } from '@core/commands/registry';
import { caseOf, withCase } from '@cae/shared/access';
import { creepResultItems } from '@cae/creep/check';
import { creepCube, holdFrd, solveCube, type SolvedCube } from '../../unit/cae/creep/support';
import { asText, type HostileReader } from './types';

let cached: { readonly analysisId: string; readonly solved: SolvedCube } | undefined;

/** One solved creep cube, built on first use. */
function fixture(): { readonly analysisId: string; readonly solved: SolvedCube } {
  if (cached === undefined) {
    const c = creepCube({ probes: [{ name: 'centre', quantity: 'ceeq' }] });
    cached = { analysisId: c.analysisId, solved: solveCube(c, holdFrd(1e-3)) };
  }
  return cached;
}

const summaryBuild = (records: number): string =>
  JSON.stringify({
    holdComplete: true,
    finalTimeS: 1000,
    outputSets: records,
    probeHistories: Object.fromEntries(
      Array.from({ length: records }, (_, k) => [`p${k}`, { quantity: 'ceeq', unit: '-', tS: [1], values: [k] }]),
    ),
  });

/** creep_report, check_creep and the result items on the stored document whose recorded `results.creep` is the parsed text. */
function readCreepSummary(input: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = undefined;
  }
  const { analysisId, solved } = fixture();
  const analysis = caseOf(solved.doc, analysisId);
  if (analysis?.results === undefined) throw new Error('fixture has no results');
  const { creep, ...rest } = analysis.results;
  void creep;
  const results = parsed === undefined || parsed === null ? rest : { ...rest, creep: parsed };
  const doc = withCase(solved.doc, { ...analysis, results: results as typeof analysis.results });
  const report = execute(doc, 'creep_report', { analysisId }, solved.ctx);
  const check = execute(doc, 'check_creep', { analysisId }, solved.ctx);
  const items = creepResultItems(analysis, { ...analysis.results, creep: parsed ?? undefined } as never);
  return { report, check, items };
}

export const CREEP_READERS: readonly HostileReader[] = [
  {
    name: 'cae: recorded creep summary (creep_report, check_creep)',
    covers: ['creep_report', 'check_creep'],
    input: 'text',
    build: summaryBuild,
    read: (input) => readCreepSummary(asText(input)),
    accepts: (result) => typeof (result as { report: { summary: unknown } }).report.summary === 'string',
    budgetMs: 20_000,
    maxRecords: 1 << 10,
    extra: [
      { name: 'creep summary removed', input: () => 'null' },
      {
        name: 'non-numeric finalTimeS',
        input: () => JSON.stringify({ holdComplete: true, finalTimeS: 'soon', outputSets: 'many', probeHistories: 7 }),
      },
      {
        name: 'holdComplete false, no peaks',
        input: () => JSON.stringify({ holdComplete: false, finalTimeS: Number.NaN, outputSets: 0, probeHistories: {} }),
      },
    ],
  },
];
