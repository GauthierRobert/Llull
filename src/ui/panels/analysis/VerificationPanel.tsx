// Solution verification of one analysis case: check_verification (mesh, time-step and element-order convergence studies), per study its levels, the
// observed order, the GCI or least-squares uncertainty, the staleness and the reviewer's accepted exceptions with the port-verified signer.
// Read-only apart from deleting a study (delete_convergence_study): the exception gate is a signed human act with no signing route in this panel yet.

import React, { useId, useMemo, useState } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { PanelSection, StatusChip, StatusLine, type StatusTone } from '@ui/panels/PanelParts';
import { useStore } from '@ui/store';
import { formatSignificant } from './quantityFormat';
import {
  levelRows,
  parseVerification,
  REFINEMENT_LABEL,
  type ReportView,
  type StudyStateName,
  type StudyView,
  type VerificationItemView,
  type VerificationStatus,
} from './verificationData';
import { useHostQuery } from './useHostQuery';

const STATUS_TONE: Readonly<Record<VerificationStatus, StatusTone>> = { pass: 'ok', warn: 'warn', fail: 'bad' };
const STATE_TONE: Readonly<Record<StudyStateName, StatusTone>> = { current: 'ok', stale: 'bad', unverifiable: 'warn', untrusted: 'bad' };
const STATE_MEANING: Readonly<Record<StudyStateName, string>> = {
  current: 'every level re-derives from the stored artifacts and the analysis is unchanged',
  stale: 'the analysis changed after the study: no number is shown, re-run run_convergence_study',
  unverifiable: 'the study cannot be checked here (artifacts absent): no number is used',
  untrusted: 'a recorded number differs from the artifacts: no number is used',
};
const METHOD_LABEL: Readonly<Record<string, string>> = {
  'celik2008-gci': 'Celik et al. 2008 GCI (3 levels)',
  'eca-hoekstra-lsq': 'Least-squares fit f0 + a·h^p (Eça & Hoekstra model, 4+ levels)',
  'order-difference': 'Order 1 / order 2 difference (indicator only)',
};

const percent = (fraction: number): string => `${formatSignificant(fraction * 100, 3)} %`;

/** A GCI target typed in percent: undefined = empty, null = not a positive finite number. */
function parseTarget(text: string): number | undefined | null {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value / 100 : null;
}

function ItemLine({ item }: { item: VerificationItemView }): React.ReactElement {
  return (
    <li className="analysis__verification-item" data-testid={`verification-item-${item.code}`} data-severity={item.severity}>
      <span className={`analysis__margin-status analysis__margin-status--${item.severity === 'warning' ? 'warn' : 'bad'}`}>
        {item.code}
      </span>{' '}
      {item.message}
      {item.accepted !== null && (
        <span className="analysis__verification-accepted" data-testid={`verification-accepted-${item.code}`}>
          {' '}
          Accepted by {item.accepted.signer} (signature {item.accepted.signatureId}): {item.accepted.justification}
        </span>
      )}
      {item.accepted === null && item.remediation !== '' && <span className="analysis__hint"> {item.remediation}</span>}
    </li>
  );
}

function ReportLines({ report, unit }: { report: ReportView; unit: string }): React.ReactElement {
  const { lsq, orderPair } = report;
  return (
    <div data-testid="verification-report">
      <p className="analysis__line" data-testid="verification-method">
        Method: {METHOD_LABEL[report.method] ?? report.method} · {report.status}
      </p>
      {orderPair !== null && (
        <p className="analysis__line" data-testid="verification-order-pair">
          Order 2: {formatSignificant(orderPair.quadratic)} {unit} · order 1: {formatSignificant(orderPair.linear)} {unit} · difference{' '}
          {formatSignificant(orderPair.absolute)} {unit}
          {orderPair.relative === null ? '' : ` (${percent(orderPair.relative)})`}. An indicator: no observed order, no extrapolated value.
        </p>
      )}
      {report.p !== null && (
        <p className="analysis__line" data-testid="verification-order">
          Observed order p = {formatSignificant(report.p, 4)}
          {lsq?.standardErrorP == null ? '' : ` ± ${formatSignificant(lsq.standardErrorP, 2)} (standard error)`}
          {report.extrapolated === null ? '' : ` · extrapolated ${formatSignificant(report.extrapolated, 6)} ${unit}`}
        </p>
      )}
      {report.gciFine !== null && (
        <p className="analysis__line" data-testid="verification-gci">
          GCI of the finest level: {percent(report.gciFine)} (estimated discretisation error)
          {report.asymptoticRatio === null ? '' : ` · asymptotic ratio ${formatSignificant(report.asymptoticRatio, 4)}`}
        </p>
      )}
      {lsq !== null && (
        <p className="analysis__line" data-testid="verification-lsq">
          Fit residual: standard deviation {formatSignificant(lsq.standardDeviation, 3)} {unit} (rss {formatSignificant(lsq.rss, 3)},{' '}
          {lsq.degreesOfFreedom} degree(s) of freedom) · uncertainty{' '}
          {lsq.uncertaintyRelative === null
            ? `${formatSignificant(lsq.uncertaintyAbsolute, 3)} ${unit}`
            : `${percent(lsq.uncertaintyRelative)} of the finest value`}
        </p>
      )}
      {report.gciFine === null && report.gciAbs !== null && lsq === null && (
        <p className="analysis__line">
          Absolute GCI {formatSignificant(report.gciAbs, 3)} {unit} (the finest value is 0)
        </p>
      )}
    </div>
  );
}

function StudyCard({ analysisCase, study }: { analysisCase: AnalysisCase; study: StudyView }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const { sizeLabel, rows } = levelRows(analysisCase, study.id);
  return (
    <div className="analysis__study" data-testid={`verification-study-${study.id}`} data-refinement={study.refinement}>
      <p className="analysis__line">
        <strong>{study.id}</strong> · {REFINEMENT_LABEL[study.refinement]} · {study.quantity} [{study.unit}] ·{' '}
        <StatusChip tone={STATE_TONE[study.state]} text={study.state} testId={`verification-state-${study.id}`} />
      </p>
      <p className="analysis__hint">{STATE_MEANING[study.state]}</p>
      {rows.length > 0 && (
        <table className="analysis__margins" data-testid={`verification-levels-${study.id}`}>
          <thead>
            <tr>
              <th scope="col">Level</th>
              <th scope="col">{sizeLabel}</th>
              <th scope="col">Value ({study.unit})</th>
              <th scope="col">Elements</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.index}>
                <td>{row.index}</td>
                <td>{formatSignificant(Number(row.size), 4)}</td>
                <td>{formatSignificant(row.value, 6)}</td>
                <td>{row.elements}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {study.report !== null && <ReportLines report={study.report} unit={study.unit} />}
      {study.report?.exception != null && (
        <p className="analysis__line" data-testid={`verification-exception-${study.id}`}>
          Exception accepted: {study.report.exception.code} by {study.report.exception.signer} — {study.report.exception.justification}
        </p>
      )}
      {study.reviewRequired && (
        <p className="analysis__hint" data-testid={`verification-review-${study.id}`}>
          Human review required (computed by llull, not approved): {study.reviewReasons.join('; ')}.
        </p>
      )}
      {study.state !== 'current' && (
        <button
          type="button"
          className="btn btn--ghost"
          data-testid={`verification-delete-${study.id}`}
          onClick={() => dispatch('delete_convergence_study', { analysisId: analysisCase.id, studyId: study.id })}
        >
          Delete study
        </button>
      )}
    </div>
  );
}

export function VerificationPanel({ analysisCase }: { analysisCase: AnalysisCase }): React.ReactElement {
  const ids = useId();
  const document = useStore((s) => s.document);
  const [targetText, setTargetText] = useState('');
  const target = parseTarget(targetText);
  const params = useMemo(
    () => ({ analysisId: analysisCase.id, ...(target === undefined || target === null ? {} : { gciTarget: target }) }),
    [analysisCase.id, target],
  );
  const answer = useHostQuery('check_verification', params, document);
  const view = answer.status === 'done' && !answer.isError ? parseVerification(answer.data) : null;

  return (
    <PanelSection
      title="Solution verification"
      hint="Mesh, time-step and element-order convergence studies of this case (read-only; run them with run_convergence_study)."
    >
      <label className="field" htmlFor={`${ids}-target`}>
        <span className="field__label">GCI target (% of the finest value; set by the owner, no default)</span>
        <input
          id={`${ids}-target`}
          type="number"
          min={0}
          step="any"
          placeholder="none"
          data-testid="verification-target"
          value={targetText}
          onChange={(e) => setTargetText(e.target.value)}
        />
      </label>
      {answer.status === 'loading' && <p className="analysis__hint">Checking the studies…</p>}
      {answer.status === 'done' && view === null && <StatusLine text={answer.summary} testId="verification-refused" />}
      {view !== null && (
        <>
          <p className="analysis__line">
            <StatusChip tone={STATUS_TONE[view.status]} text={view.status} testId="verification-status" />{' '}
            <span data-testid="verification-summary">{answer.status === 'done' ? answer.summary : ''}</span>
          </p>
          {view.studies.length === 0 && (
            <p className="analysis__hint" data-testid="verification-none">
              No convergence study yet: run run_convergence_study for this case (the CLI: llull run_convergence_study analysisId=
              {analysisCase.id}
              quantity=…).
            </p>
          )}
          {view.studies.map((study) => (
            <StudyCard key={study.id} analysisCase={analysisCase} study={study} />
          ))}
          {view.items.length > 0 && (
            <ul className="analysis__verification-items" aria-label="Verification findings">
              {view.items.map((item, index) => (
                <ItemLine key={`${item.code}-${index}`} item={item} />
              ))}
            </ul>
          )}
          <p className="analysis__hint" data-testid="verification-gate-note">
            Accepting a non-converged finding is a signed human act (accept_verification_exception). It cannot be signed from this panel
            yet: the reviewer signing route for it does not exist. An agent can never accept one.
          </p>
        </>
      )}
    </PanelSection>
  );
}
