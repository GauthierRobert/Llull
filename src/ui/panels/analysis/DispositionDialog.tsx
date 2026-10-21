// Human disposition of a FAIL / MARGINAL margin row (05 §5.8, 09 PLM signing): the reviewer picks the row, the decision and a justification, types the
// key passphrase, the local backend signs the row's payload hash, and the signed `dispose_margin` is dispatched. It never turns a FAIL into a PASS.

import React, { useId, useMemo, useState } from 'react';
import type { AnalysisCase, Decision } from '@core/model/analysis';
import { ModalDialog } from '@ui/components/ModalDialog';
import { NoSigningKeyHint, SigningFields, useSigningFields } from '@ui/components/SigningFields';
import { signPayload } from '@ui/services/signing';
import { useStore } from '@ui/store';
import { parseMargins } from './marginsData';
import { runHostQuery, useHostQuery } from './useHostQuery';

const DECISIONS: readonly Decision[] = ['accepted', 'rejected', 'redesign'];

interface Props {
  readonly analysisCase: AnalysisCase;
  readonly onClose: () => void;
}

export function DispositionDialog({ analysisCase, onClose }: Props): React.ReactElement {
  const ids = useId();
  const document = useStore((s) => s.document);
  const dispatch = useStore((s) => s.dispatch);
  const { id, marginalBand } = analysisCase;
  const params = useMemo(() => ({ analysisId: id, ...(marginalBand === undefined ? {} : { marginalBand }) }), [id, marginalBand]);
  const answer = useHostQuery('compute_margins', params, document);
  const pending = useMemo(() => {
    const view = answer.status === 'done' && !answer.isError ? parseMargins(answer.data) : null;
    return (view?.rows ?? []).filter((row) => row.status !== 'PASS');
  }, [answer]);
  const resultsHash =
    answer.status === 'done' && answer.data !== null && typeof answer.data === 'object'
      ? String((answer.data as Record<string, unknown>)['resultsHash'] ?? '')
      : '';
  const [rowId, setRowId] = useState('');
  const [decision, setDecision] = useState<Decision>('accepted');
  const [justification, setJustification] = useState('');
  const signing = useSigningFields();
  const { key, passphrase } = signing;
  const row = pending.find((candidate) => candidate.rowId === (rowId || pending[0]?.rowId));
  const ready = row !== undefined && key !== undefined && justification.trim() !== '' && passphrase !== '' && resultsHash !== '';

  async function submit(): Promise<void> {
    if (row === undefined || key === undefined) return;
    const payloadAnswer = await runHostQuery('margin_disposition_payload', { ...params, rowId: row.rowId, decision, justification });
    const payload = (payloadAnswer.data as { payloadSha256?: unknown } | null)?.payloadSha256;
    if (payloadAnswer.isError || typeof payload !== 'string') return signing.setMessage(payloadAnswer.summary);
    const signed = await signPayload(key.keyId, passphrase, 'dispose_margin', payload);
    if ('error' in signed) return signing.setMessage(signed.error);
    signing.setPassphrase('');
    await dispatch('dispose_margin', {
      analysisId: id,
      rowId: row.rowId,
      decision,
      justification,
      signature: signed.signature,
      ...(marginalBand === undefined ? {} : { marginalBand }),
    });
    onClose();
  }

  return (
    <ModalDialog
      backdropClassName="shortcuts-backdrop"
      className="shortcuts-dialog"
      onClose={onClose}
      label="Disposition of a margin row"
      initialFocus="first"
    >
      <div className="shortcuts-dialog__header">
        <h2 className="shortcuts-dialog__title">Disposition</h2>
      </div>
      {pending.length === 0 && (
        <p className="analysis__hint" data-testid="disposition-none">
          No FAIL or MARGINAL row to disposition.
        </p>
      )}
      <NoSigningKeyHint prefix="disposition" keys={signing.keys}>
        No signing key on this machine. Create one: llull keys create --user ID --name NAME
      </NoSigningKeyHint>
      <label className="field" htmlFor={`${ids}-row`}>
        <span className="field__label">Row</span>
        <select id={`${ids}-row`} data-testid="disposition-row" value={row?.rowId ?? ''} onChange={(e) => setRowId(e.target.value)}>
          {pending.map((candidate) => (
            <option key={candidate.rowId} value={candidate.rowId}>
              {candidate.rowId}: {candidate.part} {candidate.check} {candidate.status}
            </option>
          ))}
        </select>
      </label>
      <label className="field" htmlFor={`${ids}-decision`}>
        <span className="field__label">Decision</span>
        <select
          id={`${ids}-decision`}
          data-testid="disposition-decision"
          value={decision}
          onChange={(e) => setDecision(e.target.value as Decision)}
        >
          {DECISIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="field" htmlFor={`${ids}-why`}>
        <span className="field__label">Justification</span>
        <textarea
          id={`${ids}-why`}
          data-testid="disposition-justification"
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
        />
      </label>
      <SigningFields prefix="disposition" signing={signing} />
      <p className="analysis__hint">
        The decision never changes the row status: a FAIL stays FAIL ("FAIL (accepted)"). It ends when the case is solved again.
      </p>
      <div className="confirm-dialog__actions">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" data-testid="disposition-sign" disabled={!ready} onClick={() => void submit()}>
          Sign and record
        </button>
      </div>
    </ModalDialog>
  );
}
