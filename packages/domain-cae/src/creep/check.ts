/** Set-up and result items of a `creep` case (PHY-11 §7.1): appended to `check_analysis`, extended by `check_creep` with the hold. */

import type { AnalysisCase, ResultsSummary } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { crpRemediation } from './codes';
import { partIssues } from './readiness';

export interface CreepItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const item = (code: string, severity: CreepItem['severity'], message: string, ids: readonly string[]): CreepItem => ({
  code,
  severity,
  ids,
  message,
  remediation: crpRemediation(code),
});

/**
 * Items that stop the deck (no hold, a part without a usable law, all parts without one) and warnings about the law (unverified, overstress).
 * @invariant called for `creep` cases only; a case with parts all lacking a law reports CRP_NO_VISCOUS_MATERIAL once instead of one error per part
 */
export function checkCreepItems(doc: CadDocument, analysis: AnalysisCase): CreepItem[] {
  const id = analysis.id;
  const items: CreepItem[] = [];
  if (analysis.creep === undefined) items.push(item('CRP_STEP_MISSING', 'error', 'no creep step yet: call set_creep_step', [id]));
  if (analysis.creep !== undefined && analysis.creep.maxIncrementS === undefined)
    items.push(
      item(
        'CRP_INCREMENT_UNBOUNDED',
        'warning',
        'no maxIncrement: with a constant stress CETOL does not limit the increment growth and CalculiX 2.21 can stop with a singular matrix (spec 11 section 13)',
        [id],
      ),
    );
  const issues = partIssues(doc, analysis, analysis.creep?.temperature.valueK ?? null);
  const errors = issues.filter((issue) => issue.severity === 'error');
  const noLaw =
    Object.keys(analysis.parts).length > 0 &&
    errors.length === Object.keys(analysis.parts).length &&
    errors.every((issue) => issue.code === 'CRP_LAW_MISSING');
  if (noLaw) items.push(item('CRP_NO_VISCOUS_MATERIAL', 'error', `no part of '${id}' has a creep law`, [id]));
  else for (const issue of issues) items.push(item(issue.code, issue.severity, issue.message, issue.ids));
  if (
    analysis.loadOrder.length === 0 &&
    !Object.values(analysis.constraints).some((c) => Object.values(c.dofs ?? {}).some((value) => value !== 0))
  )
    items.push(item('FEA_NO_LOADS', 'warning', 'no load and no prescribed displacement: nothing makes the part creep', [id]));
  return items;
}

/**
 * Items of the recorded hold: a hold shorter than the duration (CRP_HOLD_INCOMPLETE).
 * @invariant empty for a summary without `creep`
 */
export function creepResultItems(analysis: AnalysisCase, summary: ResultsSummary | undefined): CreepItem[] {
  const creep = summary?.creep;
  if (creep === undefined || analysis.creep === undefined || creep.holdComplete) return [];
  return [
    item(
      'CRP_HOLD_INCOMPLETE',
      'error',
      `the solve stored results up to ${creep.finalTimeS} s of the ${analysis.creep.durationS} s hold: the creep strain is not the end-of-hold value`,
      [analysis.id],
    ),
  ];
}
