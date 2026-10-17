// Insert-fastener dialog (08 §7): gathers family / size / stack, previews the choice live through the read-only `select_fastener` query
// (part number, grip, washers, refusals with remediation, defaulted rules) and only dispatches `insert_fastener_stack` on Confirm.

import React, { useEffect, useId, useRef, useState } from 'react';
import { ModalDialog } from '@ui/components/ModalDialog';
import { LabeledInput } from '@ui/panels/LabeledInput';
import { LabeledSelect } from '@ui/panels/LabeledSelect';
import { useReadOnlyQuery } from '@ui/panels/useReadOnlyQuery';
import { parseNumber, parseNumberRow } from '@ui/numberText';
import { useStore } from '@ui/store';
import { parseSelection, selectionParams, type InsertDraft } from './fastenerView';

const UNITS: ReadonlyArray<readonly [string, string]> = ['in', 'mm', 'cm', 'm', 'ft'].map((u) => [u, u] as const);
const HOLE_MODES: ReadonlyArray<readonly [string, string]> = [
  ['cut_close_tolerance', 'Close-tolerance hole'],
  ['cut_clearance', 'Clearance hole'],
  ['none', 'No hole cut'],
];

function Preview({ query }: { query: ReturnType<typeof useReadOnlyQuery<ReturnType<typeof parseSelection>>> }): React.ReactElement {
  const view = query.view;
  if (view === null)
    return (
      <p className="panel__row-meta" role="status" data-testid="fastener-preview-empty">
        {query.summary === '' ? 'Choose a family, a size and the stack thickness to preview the selection.' : query.summary}
      </p>
    );
  return (
    <div className="fastener-preview" role="status" aria-live="polite" data-testid="fastener-preview" data-ok={view.ok}>
      {view.ok ? (
        <p>
          <strong data-testid="fastener-preview-pn">{view.partNumber}</strong>
          {view.gripDash !== '' && ` · grip -${view.gripDash}`}
          {view.lengthIn !== null && ` · length ${view.lengthIn} in`}
          {view.washers.length > 0 && ` · washers ${view.washers.join(', ')}`}
        </p>
      ) : (
        <ul className="fastener-preview__reasons" data-testid="fastener-preview-reasons">
          {view.reasons.map((reason) => (
            <li key={reason.code}>
              <code>{reason.code}</code> {reason.message} {reason.remediation}
            </li>
          ))}
        </ul>
      )}
      {view.warnings.map((warning) => (
        <p key={warning} className="panel__row-meta">
          ▲ {warning}
        </p>
      ))}
      {view.defaultedRules.length > 0 && (
        <p className="panel__row-meta" data-testid="fastener-preview-defaults">
          Defaulted: {view.defaultedRules.join('; ')}
        </p>
      )}
    </div>
  );
}

export function InsertFastenerDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const titleId = useId();
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const catalogs = useStore((s) => s.document.fasteners?.catalogs);
  const selection = useStore((s) => s.document.selection);
  const dispatch = useStore((s) => s.dispatch);
  const preview = useReadOnlyQuery('select_fastener', parseSelection);
  const families = Object.values(catalogs ?? {});
  const [draft, setDraft] = useState<InsertDraft>({
    family: families.find((f) => f.kind !== 'nut' && f.kind !== 'washer')?.id ?? '',
    diameterDash: '',
    stack: '',
    unit: 'in',
    nut: '',
    washer: '',
    useSelection: false,
    axisPoint: '',
    holeMode: 'cut_close_tolerance',
  });
  const set =
    <K extends keyof InsertDraft>(key: K) =>
    (value: InsertDraft[K]) =>
      setDraft((d) => ({ ...d, [key]: value }));
  const family = catalogs?.[draft.family];
  const dash = family?.sizes.some((s) => s.dash === draft.diameterDash) === true ? draft.diameterDash : (family?.sizes[0]?.dash ?? '');
  const axisPoint = parseNumberRow(draft.axisPoint);
  const params = selectionParams({ ...draft, diameterDash: dash }, selection, { stack: parseNumber(draft.stack), axisPoint });
  const paramsKey = JSON.stringify(params);
  const { run, clear } = preview;
  useEffect(() => {
    if (params === null) clear();
    else run(params);
    // paramsKey is the value identity of params
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey, run, clear]);

  const confirmable = params !== null && axisPoint?.length === 3 && preview.view?.ok === true;
  const confirm = (): void => {
    if (!confirmable) return;
    dispatch('insert_fastener_stack', { ...params, holeMode: draft.holeMode });
    onClose();
  };
  const ofKind = (kinds: readonly string[]): Array<readonly [string, string]> =>
    families.filter((f) => kinds.includes(f.kind)).map((f) => [f.id, f.id] as const);

  return (
    <ModalDialog
      backdropClassName="shortcuts-backdrop"
      className="shortcuts-dialog fastener-dialog"
      onClose={onClose}
      labelledBy={titleId}
      initialFocus="first"
    >
      <div className="shortcuts-dialog__header">
        <h2 id={titleId} className="shortcuts-dialog__title">
          Insert fastener
        </h2>
      </div>
      <div className="mfg__form">
        <LabeledSelect
          label="Family"
          value={draft.family}
          options={ofKind(['bolt', 'hi_lok_pin', 'solid_rivet', 'blind_rivet', 'lockbolt']).map(([id, text]) => [id, text] as const)}
          onChange={set('family')}
          testId="fastener-family"
        />
        <LabeledSelect
          label="Size"
          value={dash}
          options={(family?.sizes ?? []).map((s) => [s.dash, `-${s.dash} (${s.nominalDiameter.value} ${s.nominalDiameter.unit})`] as const)}
          onChange={set('diameterDash')}
          testId="fastener-size"
        />
        <LabeledSelect label="Nut" value={draft.nut} options={ofKind(['nut'])} blankLabel="None" onChange={set('nut')} />
        <LabeledSelect label="Washer" value={draft.washer} options={ofKind(['washer'])} blankLabel="None" onChange={set('washer')} />
        <label className="field">
          <span className="field__label">Stack from</span>
          <select
            value={draft.useSelection ? 'selection' : 'value'}
            onChange={(e) => set('useSelection')(e.target.value === 'selection')}
            aria-label="Stack from"
            data-testid="fastener-stack-mode"
          >
            <option value="value">Thickness value</option>
            <option value="selection">Selected plates ({selection.length})</option>
          </select>
        </label>
        {!draft.useSelection && (
          <>
            <LabeledInput
              label="Stack thickness"
              type="number"
              value={draft.stack}
              onChange={set('stack')}
              testId="fastener-stack"
              inputProps={{ step: 'any' }}
            />
            <LabeledSelect label="Unit" value={draft.unit} options={UNITS} onChange={set('unit')} />
          </>
        )}
        <LabeledInput
          label="Axis point x, y, z"
          type="text"
          value={draft.axisPoint}
          onChange={set('axisPoint')}
          testId="fastener-axis-point"
        />
        <LabeledSelect label="Hole" value={draft.holeMode} options={HOLE_MODES} onChange={set('holeMode')} />
        <Preview query={preview} />
      </div>
      <div className="confirm-dialog__actions">
        <button ref={firstRef} type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={!confirmable} onClick={confirm} data-testid="fastener-confirm">
          Insert
        </button>
      </div>
    </ModalDialog>
  );
}
