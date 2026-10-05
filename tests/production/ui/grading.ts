import { expect } from '@playwright/test';
import { deserializeDocument } from '@core/commands/persistence';
import type { CadDocument } from '@core/model/types';
import type { Scenario } from '../contract';
import { gradeContext, gradeScenario } from '../grade';
import { formatReport, writeArtifact, writeReport } from '../report';
import type { Provided } from './exports';
import type { UiSession } from './session';

/**
 * @layer tests/production/ui
 *
 * Grade what the UI produced with the same criteria as the other drivers, archive the downloads,
 * and apply the known-issue ratchet.
 */

export interface UiRun {
  scenario: Scenario;
  session: UiSession;
  baseline: CadDocument;
  /** Project file saved from the app ("Save"). */
  saved: string;
  provided: Provided;
  fileNames: Record<string, string>;
  uiGaps: string[];
  /** Tool calls that went through a panel form vs the command palette. */
  steps: { panel: number; palette: number };
}

export function gradeUiRun(run: UiRun): void {
  const document = deserializeDocument(run.saved);
  const provided: Provided = { ...run.provided, save: run.saved };
  const report = gradeScenario(run.scenario, 'ui', gradeContext(document, run.baseline, provided));
  for (const [id, text] of Object.entries(provided)) {
    writeArtifact('ui', run.scenario.id, `${id.replace(/[^\w.-]/g, '_')}.txt`, text);
  }
  writeReport(report, {
    uiGaps: run.uiGaps,
    downloads: run.fileNames,
    steps: run.steps,
    browserProblems: run.session.problems,
  });
  const failing = report.checks.filter((check) => !check.pass).map((c) => `${c.id}: ${c.detail}`);
  expect(run.session.problems, 'browser console / page errors').toEqual([]);
  expect(report.regressions, `${formatReport(report)}\n${failing.join('\n')}`).toEqual([]);
  expect(report.fixed, 'known UI issues now passing: remove them from knownIssues.ui').toEqual([]);
}
