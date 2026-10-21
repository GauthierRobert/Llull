// Shared civil panel parts: typed object lists, object row (delete_civil_object), object select, status line.

import React, { useMemo, useState } from 'react';
import type { CivilCategory, CivilObject } from '@aec/index';
import { useStore } from '@ui/store';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { PairSelect } from '@ui/panels/OptionSelect';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useIsFocused } from '@ui/store/focusStore';
import { formatPoints, selectedPolylinePoints } from './civilInput';
import { civilFocus } from './civilFocus';

/** Creation order, re-derived when the civil model changes. */
export function useCivilObjects<C extends CivilCategory>(category: C): Array<Extract<CivilObject, { category: C }>> {
  const civil = useStore((s) => s.document.civil);
  return useMemo(
    () =>
      (civil?.order ?? [])
        .map((id) => civil?.objects[id])
        .filter((object): object is Extract<CivilObject, { category: C }> => {
          return object?.category === category;
        }),
    [civil, category],
  );
}

/** A workflow-step section's start state, from CivilPanel: expanded (has content or is the next step) and done (has content). */
export interface CivilStepState {
  defaultOpen: boolean;
  done: boolean;
}

interface CivilObjectRowProps {
  object: CivilObject;
  detail?: string;
  /** Controls on the row, next to Delete. */
  children?: React.ReactNode;
  /** Editor shown under the row. */
  body?: React.ReactNode;
}

export function CivilObjectRow({ object, detail, children, body }: CivilObjectRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const document = useDocumentWithoutSelection();
  const focusItem = useFocusItem();
  const focus = civilFocus(document, object, detail);
  const focused = useIsFocused(focus.key);
  return (
    <li className={focused ? 'civil-row civil-row--focused' : 'civil-row'} data-testid={`civil-row-${object.id}`}>
      <div className="building-actions">
        <button
          type="button"
          className="civil-row__name building-row-btn"
          title="Show on the model"
          aria-pressed={focused}
          data-testid={`civil-focus-${object.id}`}
          onClick={() => focusItem(focus)}
        >
          <span className="panel__swatch" style={{ background: focus.color }} aria-hidden="true" />
          <span className="civil-row__label">
            {object.name} <small>({object.id})</small>
          </span>
        </button>
        {children}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label={`Delete ${object.name}`}
          onClick={() => dispatch('delete_civil_object', { id: object.id })}
        >
          Delete
        </button>
      </div>
      {detail !== undefined && detail !== '' && <p className="panel__empty-hint">{detail}</p>}
      {body}
    </li>
  );
}

interface CivilObjectSelectProps {
  objects: ReadonlyArray<CivilObject>;
  value: string;
  label: string;
  onChange: (id: string) => void;
  /** Omitted = no empty choice. */
  emptyLabel?: string;
}

/** An unknown `value` falls back to the first object (or empty). */
export function CivilObjectSelect({ objects, value, label, onChange, emptyLabel }: CivilObjectSelectProps): React.ReactElement {
  return (
    <PairSelect
      value={value}
      options={objects.map((object) => [object.id, object.name] as const)}
      label={label}
      {...(emptyLabel !== undefined ? { blankLabel: emptyLabel } : {})}
      onChange={onChange}
    />
  );
}

/** `value` when it names one of `objects`, else the first id ('' when `allowEmpty` or none). */
function chosenId(objects: ReadonlyArray<CivilObject>, value: string, allowEmpty = false): string {
  if (objects.some((object) => object.id === value)) return value;
  return allowEmpty ? '' : (objects[0]?.id ?? '');
}

/** The picked id while it names one of `objects`, else `preferredIndex`'s object (nothing picked yet), else `chosenId`'s fallback. */
export function useChosenId(
  objects: ReadonlyArray<CivilObject>,
  allowEmpty = false,
  preferredIndex?: number,
): [string, (id: string) => void] {
  const [picked, setPicked] = useState('');
  const value = picked === '' && preferredIndex !== undefined ? (objects[preferredIndex]?.id ?? '') : picked;
  return [chosenId(objects, value, allowEmpty), setPicked];
}

interface CivilFieldProps {
  value: string;
  set: (text: string) => void;
  hint: string;
  label: string;
}

/** Labelled field: the label stays visible above the input (the placeholder only hints the format or default). */
function CivilInput({ value, set, hint, label, type }: CivilFieldProps & { type?: 'number' }): React.ReactElement {
  return (
    <label className="civil-field">
      <span className="civil-field__label" title={label}>
        {label}
      </span>
      <input type={type} value={value} placeholder={hint} aria-label={label} onChange={(event) => set(event.target.value)} />
    </label>
  );
}

export function TextField(props: CivilFieldProps): React.ReactElement {
  return <CivilInput {...props} />;
}

export function NumberTextField(props: CivilFieldProps): React.ReactElement {
  return <CivilInput {...props} type="number" />;
}

interface PointsFromSelectionRowProps {
  value: string;
  set: (text: string) => void;
  label: string;
  /** Shown through `setError` when the selection is not one polyline. */
  noSelectionError: string;
  setError: (message: string) => void;
  children?: React.ReactNode;
}

/** "x,y; …" points field with a "From selection" button that copies the selected polyline. */
export function PointsFromSelectionRow({
  value,
  set,
  label,
  noSelectionError,
  setError,
  children,
}: PointsFromSelectionRowProps): React.ReactElement {
  const takeSelection = (): void => {
    const points = selectedPolylinePoints(useStore.getState().document);
    if (points === null) setError(noSelectionError);
    else {
      set(formatPoints(points));
      setError('');
    }
  };
  return (
    <div className="building-inline-form">
      {children}
      <TextField value={value} set={set} hint="x,y; x,y; x,y; …" label={label} />
      <button type="button" className="btn btn--ghost btn--sm" onClick={takeSelection}>
        From selection
      </button>
    </div>
  );
}
