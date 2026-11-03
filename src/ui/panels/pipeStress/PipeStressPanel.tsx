// Pipe stress tab (07 PST M4): pick a stress model, read its load cases, governing code ratios, worst stations and findings, switch the 3D
// overlay, and take the model through record -> approve. The analysis is the read-only `analyze_pipe_stress` (shared with the overlay);
// recording is a command through `dispatch`, and approving is a human act signed in the app (SignActDialog), never an agent call.

import React, { useEffect, useMemo, useState } from 'react';
import type { CadDocument } from '@core/model/types';
import { humanGatePayload } from '@core/model/humanGate';
import { classNames } from '@ui/classNames';
import { SignActDialog, type SignActRequest } from '@ui/components/SignActDialog';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useIsFocused, type PanelFocus } from '@ui/store/focusStore';
import { useStore } from '@ui/store';
import { usePipeStressStore } from '@ui/store/pipeStressStore';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { KpiStrip, ListRow, PanelEmpty, PanelHeader, PanelSection, StatusChip, StatusLine, type StatusTone } from '@ui/panels/PanelParts';
import { pathMidpoint, pipePath } from '@ui/viewport/3d/pipeStress/pipePaths';
import { stressOutcome } from '@ui/viewport/3d/pipeStress/stressQuery';
import {
  approvalStatus,
  ratioTone,
  TONE_COLOR,
  worstStations,
  type ApprovalStatus,
  type RatioTone,
  type StressOutcome,
  type StressRow,
  type StressView,
} from '@ui/viewport/3d/pipeStress/stressView';

type StressModel = NonNullable<NonNullable<CadDocument['plant']>['stress']>['models'][string];

const WORST_LIMIT = 8;
const ALL_CASES = '';

const CHIP_TONE: Record<RatioTone, StatusTone> = { pass: 'ok', warn: 'warn', fail: 'bad', unknown: 'info' };
const STATUS_TONE: Record<StressView['status'], StatusTone> = { pass: 'ok', fail: 'bad', incomplete: 'warn' };
const APPROVAL_TEXT: Record<ApprovalStatus, string> = {
  approved: 'Approved',
  stale: 'Stale: inputs changed since the record',
  'not-recorded': 'Not recorded',
  'not-approved': 'Not approved',
  unverifiable: 'Cannot verify (analysis refused)',
};
const APPROVAL_TONE: Record<ApprovalStatus, StatusTone> = {
  approved: 'ok',
  stale: 'warn',
  'not-recorded': 'info',
  'not-approved': 'warn',
  unverifiable: 'bad',
};

const fmtRatio = (ratio: number | null): string => (ratio === null ? 'n/a' : Number.isFinite(ratio) ? ratio.toFixed(2) : 'not finite');

const LEGEND: ReadonlyArray<readonly [RatioTone, string]> = [
  ['pass', 'below 0.8'],
  ['warn', '0.8 to 1'],
  ['fail', 'above 1'],
  ['unknown', 'no ratio'],
];

function ToneLegend(): React.ReactElement {
  return (
    <ul
      className="panel__row-meta"
      data-testid="stress-legend"
      aria-label="Ratio colours"
      style={{ display: 'flex', gap: 10, flexWrap: 'wrap', listStyle: 'none', padding: 0, margin: 0 }}
    >
      {LEGEND.map(([tone, text]) => (
        <li key={tone} data-testid={'stress-legend-' + tone}>
          <span className="panel__swatch" style={{ background: TONE_COLOR[tone] }} aria-hidden="true" /> {text}
        </li>
      ))}
    </ul>
  );
}

function stationFocus(document: CadDocument, row: StressRow): PanelFocus {
  const tone = ratioTone(row.ratio);
  const path = pipePath(document, row.pipeId);
  const position = path === null ? null : pathMidpoint(path.points);
  const where = `${row.pipeId}${row.node === null ? '' : ` ${row.node}`}`;
  return {
    key: `pipestress:station:${row.case}:${row.pipeId}:${row.node ?? row.element}`,
    label: `${row.case} ${where}, ratio ${fmtRatio(row.ratio)}`,
    color: TONE_COLOR[tone],
    entityIds: [],
    markers: position === null ? [] : [{ position, label: `${where} ${fmtRatio(row.ratio)}` }],
  };
}

function StationRow({ document, row }: { document: CadDocument; row: StressRow }): React.ReactElement {
  const focus = stationFocus(document, row);
  const onFocus = useFocusItem();
  const focused = useIsFocused(focus.key);
  const tone = ratioTone(row.ratio);
  return (
    <ListRow
      selected={focused}
      swatch={TONE_COLOR[tone]}
      testId={`stress-station-${row.case}-${row.pipeId}-${row.node ?? row.element}`}
      onSelect={() => onFocus(focus)}
    >
      <StatusChip tone={CHIP_TONE[tone]} text={fmtRatio(row.ratio)} />
      <span className="panel__row-main">
        {row.pipeId} {row.node ?? row.element}
      </span>
      <span className="panel__row-meta">
        {row.case} · {row.stressMPa.toFixed(0)} / {row.allowableMPa.toFixed(0)} MPa
      </span>
    </ListRow>
  );
}

function ApprovalSection({ model, outcome }: { model: StressModel; outcome: StressOutcome }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [signing, setSigning] = useState<SignActRequest | null>(null);
  const status = approvalStatus(model, outcome);
  const recorded = model.recorded;
  const canApprove = status === 'not-approved' && recorded !== undefined && recorded.status === 'pass';
  const approve = (): void => {
    if (recorded === undefined) return;
    setSigning({
      title: 'Approve pipe stress results',
      summary: `Sign your approval of the recorded results of ${model.id} (result ${recorded.resultHash.slice(0, 12)}). You are certifying that you reviewed them as a qualified engineer.`,
      act: 'approve_pipe_stress',
      payload: (nonce) =>
        humanGatePayload(
          'plant:approve_pipe_stress',
          [model.id],
          { inputHash: recorded.inputHash, resultHash: recorded.resultHash },
          nonce,
        ),
      onSigned: (confirmation) => dispatch('approve_pipe_stress', { modelId: model.id, confirmation, at: new Date().toISOString() }),
    });
  };
  return (
    <PanelSection title="Approval">
      <div className="panel__row" data-testid="stress-approval">
        <StatusChip tone={APPROVAL_TONE[status]} text={APPROVAL_TEXT[status]} testId="stress-approval-status" />
        {model.approval !== undefined && status === 'approved' && (
          <span className="panel__row-meta">
            {model.approval.signer} · {model.approval.at}
          </span>
        )}
      </div>
      <div className="panel__row">
        <button
          type="button"
          className="btn btn--sm"
          data-testid="stress-record"
          disabled={!outcome.ok}
          onClick={() => dispatch('record_pipe_stress_results', { modelId: model.id })}
        >
          {recorded === undefined ? 'Record results' : 'Re-record results'}
        </button>
        <button type="button" className="btn btn--primary btn--sm" data-testid="stress-approve" disabled={!canApprove} onClick={approve}>
          Approve…
        </button>
      </div>
      {recorded !== undefined && recorded.status !== 'pass' && status !== 'stale' && (
        <p className="panel__row-meta">A {recorded.status} record cannot be approved.</p>
      )}
      {signing !== null && <SignActDialog request={signing} onClose={() => setSigning(null)} />}
    </PanelSection>
  );
}

function ResultSections({ document, view }: { document: CadDocument; view: StressView }): React.ReactElement {
  const caseName = usePipeStressStore((s) => s.caseName);
  const stations = useMemo(() => worstStations(view.rows, caseName, WORST_LIMIT), [view, caseName]);
  const flagged = view.findings.filter((finding) => finding.severity !== 'info');
  return (
    <>
      <PanelSection title="Load cases" count={view.cases.length}>
        <ul className="panel__list" data-testid="stress-cases">
          {view.cases.map((entry) => (
            <li key={entry.name} className={classNames('panel__row', caseName === entry.name && 'panel__row--selected')}>
              <StatusChip tone={CHIP_TONE[ratioTone(entry.governingRatio)]} text={fmtRatio(entry.governingRatio)} />
              <span className="panel__row-main">
                {entry.name} <span className="panel__row-meta">{entry.type}</span>
              </span>
              <span className="panel__row-meta">
                {entry.governingNode ?? ''}
                {entry.maxDisplacementMm === null ? '' : ` · ${entry.maxDisplacementMm.toFixed(1)} mm`}
              </span>
            </li>
          ))}
        </ul>
      </PanelSection>
      <PanelSection title="Worst stations" count={stations.length} hint="Click a row to mark the pipe on the model.">
        <ul className="panel__list" data-testid="stress-stations">
          {stations.map((row) => (
            <StationRow key={`${row.case}|${row.pipeId}|${row.node ?? row.element}`} document={document} row={row} />
          ))}
        </ul>
        {stations.length === 0 && <p className="panel__row-meta">No code stress rows (no sustained, expansion or occasional case).</p>}
      </PanelSection>
      <PanelSection title="Findings" count={flagged.length} collapsible defaultOpen={flagged.some((f) => f.severity === 'fail')}>
        <ul className="panel__list" data-testid="stress-findings">
          {flagged.map((finding, i) => (
            <li key={`${finding.code}-${i}`} className="panel__row" title={finding.message}>
              <StatusChip tone={finding.severity === 'fail' ? 'bad' : 'warn'} text={finding.severity} />
              <span className="panel__row-main">{finding.code}</span>
              <span className="panel__row-meta">{finding.ids.slice(0, 3).join(', ')}</span>
            </li>
          ))}
        </ul>
      </PanelSection>
    </>
  );
}

export function PipeStressPanel({ className }: { className?: string }): React.ReactElement {
  const document = useDocumentWithoutSelection();
  const models = document.plant?.stress?.models ?? {};
  const order = document.plant?.stress?.modelOrder ?? [];
  const storedId = usePipeStressStore((s) => s.modelId);
  const caseName = usePipeStressStore((s) => s.caseName);
  const shown = usePipeStressStore((s) => s.shown);
  const { setModelId, setCaseName, setShown } = usePipeStressStore.getState();
  const modelId = storedId !== null && order.includes(storedId) ? storedId : (order[0] ?? null);
  useEffect(() => {
    if (modelId !== storedId) setModelId(modelId);
  }, [modelId, storedId, setModelId]);
  const model = modelId === null || !Object.hasOwn(models, modelId) ? undefined : models[modelId];
  const outcome = useMemo(() => (modelId === null ? null : stressOutcome(document, modelId)), [document, modelId]);

  return (
    <aside className={classNames('panel pipe-stress-panel', className)} aria-label="Pipe stress">
      <PanelHeader title="Pipe stress" count={order.length} countLabel={`${order.length} stress models`}>
        {outcome?.ok === true && <StatusChip tone={STATUS_TONE[outcome.view.status]} text={outcome.view.status} testId="stress-status" />}
      </PanelHeader>
      {model === undefined || outcome === null ? (
        <PanelEmpty
          icon="wireframe"
          message="No stress model yet"
          hint="A stress model analyses a set of building pipes or 02 RTE runs against a piping code."
          action={{ command: 'create_stress_model', label: 'Create stress model' }}
        />
      ) : (
        <>
          <PanelSection title="Model">
            <LabeledSelect
              label="Model"
              value={model.id}
              options={order.map((id) => [id, models[id]?.name ?? id] as const)}
              testId="stress-model-select"
              onChange={setModelId}
            />
            <p className="panel__row-meta">{model.rule}</p>
            {outcome.ok && (
              <KpiStrip
                label="Pipe stress summary"
                items={[
                  {
                    key: 'worst',
                    label: 'Worst ratio',
                    value: fmtRatio(
                      outcome.view.cases.reduce<number | null>(
                        (a, c) => (c.governingRatio === null || (a !== null && a >= c.governingRatio) ? a : c.governingRatio),
                        null,
                      ),
                    ),
                    tone: STATUS_TONE[outcome.view.status],
                  },
                  { key: 'cases', label: 'Cases', value: String(outcome.view.cases.length) },
                ]}
              />
            )}
            <label className="field field--inline">
              <input type="checkbox" checked={shown} data-testid="stress-overlay-toggle" onChange={(e) => setShown(e.target.checked)} />
              <span className="field__label">Colour pipes by stress ratio</span>
            </label>
            <ToneLegend />
            {outcome.ok && (
              <LabeledSelect
                label="Overlay case"
                value={caseName ?? ALL_CASES}
                options={outcome.view.cases.filter((c) => c.governingRatio !== null).map((c) => [c.name, c.name] as const)}
                blankLabel="Worst of all cases"
                testId="stress-case-select"
                onChange={(value) => setCaseName(value === ALL_CASES ? null : value)}
              />
            )}
          </PanelSection>
          {outcome.ok ? (
            <ResultSections document={document} view={outcome.view} />
          ) : (
            <StatusLine text={outcome.summary} testId="stress-refused" />
          )}
          <ApprovalSection model={model} outcome={outcome} />
          <p className="panel__row-meta" data-testid="stress-review-required">
            Review required: a qualified engineer reviews every pipe stress result.
          </p>
        </>
      )}
    </aside>
  );
}
