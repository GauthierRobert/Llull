/** check_structural_dynamics: readiness and post-solve checks of a frequency_response / random_response case (PHY-09 §7.1, AF-20). */

import type { AnalysisCase } from '@core/model/analysis';
import type { DynamicSummary } from '@core/model/structuralDynamics';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { FeArtifactPort } from '@core/model/analysis';
import { significantNumber } from '@lib/compactNumber';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import { checkItem, refuseDyn, type DynamicCheckItem } from './codes';
import { caseLossFactor } from './materialDamping';
import { hasBaseConstraint } from './setupCommands';
import { dynamicCaseOf, spectrumOf, type DynamicCase } from './store';

/** Excitation band top must stay below this multiple of the highest kept mode (AF-30 rule held as data). */
export const BAND_TO_MODE_RATIO = 1.5;

const n = (value: number): string => significantNumber(value, 6);

function setupItems(doc: CadDocument, { analysisCase, dynamics }: DynamicCase): DynamicCheckItem[] {
  const id = analysisCase.id;
  const items: DynamicCheckItem[] = [];
  const random = analysisCase.type === 'random_response';
  if (analysisCase.modes === undefined) items.push(checkItem('DYN_BASIS_MISSING', 'error', 'the case has no number of modes', [id]));
  if (dynamics.damping === undefined) items.push(checkItem('DYN_DAMPING_UNSET', 'error', 'no damping (there is no default)', [id]));
  else if (dynamics.damping.model === 'structural_material') {
    const eta = caseLossFactor(doc, analysisCase);
    if ('code' in eta) items.push(checkItem(eta.code, 'error', eta.message, eta.ids));
  }
  if (dynamics.sweep === undefined) items.push(checkItem('DYN_SWEEP_UNSET', 'error', 'no frequency band (set_frequency_sweep)', [id]));
  const base = dynamics.base;
  if (base === undefined) {
    if (random) items.push(checkItem('DYN_BASE_UNSET', 'error', 'a random_response case needs a base excitation spectrum', [id]));
    else if (analysisCase.loadOrder.length === 0)
      items.push(checkItem('FEA_NO_LOADS', 'error', 'a frequency_response case needs a load or a base excitation', [id]));
  } else {
    if (!hasBaseConstraint(analysisCase, base.direction))
      items.push(checkItem('DYN_BASE_NO_CONSTRAINT', 'error', `no homogeneous constraint on ${base.direction} for the base motion`, [id]));
    if (base.spectrum !== undefined) {
      const spectrum = spectrumOf(doc, base.spectrum);
      if (spectrum === undefined)
        items.push(checkItem('DYN_SPECTRUM_UNKNOWN', 'error', `no vibration spectrum '${base.spectrum}'`, [base.spectrum]));
      else if (spectrum.unverified)
        items.push(
          checkItem(
            'DYN_SPECTRUM_UNVERIFIED',
            'warning',
            `spectrum '${base.spectrum}' is source grade ${spectrum.source.grade ?? 'unstated'}`,
            [base.spectrum],
          ),
        );
    }
  }
  if (random && dynamics.modalTruncationThreshold === undefined)
    items.push(
      checkItem('DYN_TRUNCATION_THRESHOLD_UNSET', 'warning', 'no modal truncation threshold (company rule; llull ships none)', [id]),
    );
  return items;
}

function resultItems(analysisCase: AnalysisCase, summary: DynamicSummary): DynamicCheckItem[] {
  const id = analysisCase.id;
  const items: DynamicCheckItem[] = [];
  const dynamics = analysisCase.dynamics;
  const top = dynamics?.sweep?.fMaxHz;
  if (top !== undefined && summary.highestModeHz * BAND_TO_MODE_RATIO < top)
    items.push(
      checkItem(
        'DYN_BAND_ABOVE_MODES',
        'warning',
        `the band reaches ${n(top)} Hz, above ${BAND_TO_MODE_RATIO} x the highest kept mode (${n(summary.highestModeHz)} Hz)`,
        [id],
      ),
    );
  const threshold = dynamics?.modalTruncationThreshold;
  const direction = dynamics?.base?.direction;
  if (threshold !== undefined && direction !== undefined && summary.massParticipation[direction] < threshold)
    items.push(
      checkItem(
        'DYN_MODAL_TRUNCATION',
        'warning',
        `the kept modes carry ${n(summary.massParticipation[direction])} of the ${direction} effective mass, below ${n(threshold)}`,
        [id],
      ),
    );
  for (const reason of summary.unverifiedReasons)
    if (reason.startsWith('DYN_PSD_GRID_NOT_CONVERGED')) items.push(checkItem('DYN_PSD_GRID_NOT_CONVERGED', 'error', reason, [id]));
  items.push(checkItem('DYN_REVIEW_PENDING', 'warning', summary.reviewReason, [id]));
  return items;
}

/** Every check item of the case (set-up, then state, then post-solve items when the results verify). */
export function dynamicCheckItems(doc: CadDocument, found: DynamicCase, port: FeArtifactPort | null | undefined): DynamicCheckItem[] {
  const items = setupItems(doc, found);
  const trust = trustedRecord(doc, found.analysisCase, port);
  if (trust.state === 'stale')
    items.push(checkItem('DYN_RESULTS_STALE', 'error', 'an input changed after the solve', [found.analysisCase.id]));
  const summary = trust.results?.dynamics;
  if (trust.state === 'solved' && summary !== undefined) items.push(...resultItems(found.analysisCase, summary));
  return items;
}

/**
 * @invariant read-only; status error when any item is an error, warning when any is a warning, else ok; reviewRequired always true
 * @failure unknown / non-dynamic case -> FEA_ANALYSIS_NOT_FOUND / DYN_CASE_TYPE
 */
export const checkDynamics = defineCommand({
  name: 'check_structural_dynamics',
  description:
    'Check a frequency_response / random_response case before and after the solve: data { status ok | warning | error, items [{ code, ' +
    'severity, ids, message, remediation }], state, reviewRequired: true }. Set-up: modes, damping (never defaulted), sweep, base excitation and ' +
    'its constraint, spectrum known and verified, truncation threshold. After fea_solve: stale results, band above 1.5 x the highest kept mode, ' +
    'effective mass below the threshold, grid convergence, and the pending human review.',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema }),
  run: (doc, { analysisId }, ctx): CommandResult => {
    const found = dynamicCaseOf(doc, analysisId);
    if (found === 'missing')
      return refuseDyn(
        doc,
        'check_structural_dynamics',
        'FEA_ANALYSIS_NOT_FOUND',
        `no analysis '${analysisId}'`,
        [analysisId],
        ['analysisId'],
      );
    if (found === 'not_dynamic')
      return refuseDyn(
        doc,
        'check_structural_dynamics',
        'DYN_CASE_TYPE',
        `analysis '${analysisId}' is not a dynamic case`,
        [analysisId],
        ['analysisId'],
      );
    const items = dynamicCheckItems(doc, found, ctx?.feaArtifacts);
    const errors = items.filter((entry) => entry.severity === 'error').length;
    const warnings = items.length - errors;
    const status = errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok';
    const state = trustedRecord(doc, found.analysisCase, ctx?.feaArtifacts).state;
    return report(
      doc,
      `check_structural_dynamics: '${analysisId}' ${status} — ${errors} error(s), ${warnings} warning(s)${items.length > 0 ? `: ${items.map((entry) => entry.code).join(', ')}` : ''}.`,
      { status, items, state, reviewRequired: true },
    );
  },
});
