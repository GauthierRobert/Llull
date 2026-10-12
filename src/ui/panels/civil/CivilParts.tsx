/**
 * @layer ui/panels/civil
 *
 * Shared civil panel parts: typed object lists from the store, an object row with a delete
 * button (`delete_civil_object`), an object select and a status line. Presentation only.
 */

import React, { useMemo, useState } from 'react';
import type { CivilCategory, CivilObject } from '@core/model/civil';
import { useStore } from '@ui/store';
import { PairSelect } from '@ui/panels/OptionSelect';
import { formatPoints, selectedPolylinePoints } from './civilInput';

/** Civil objects of `category` in creation order (re-derived when the civil model changes). */
export function useCivilObjects<C extends CivilCategory>(
  category: C,
): Array<Extract<CivilObject, { category: C }>> {
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

interface CivilObjectRowProps {
  object: CivilObject;
  detail?: string;
  /** Controls on the row, next to Delete. */
  children?: React.ReactNode;
  /** Editor shown under the row. */
  body?: React.ReactNode;
}

export function CivilObjectRow({
  object,
  detail,
  children,
  body,
}: CivilObjectRowProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  return (
    <li className="civil-row" data-testid={`civil-row-${object.id}`}>
      <div className="building-actions">
        <span className="civil-row__name" title={object.id}>
          {object.name} <small>({object.id})</small>
        </span>
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
  /** Label of the empty choice; omitted = no empty choice. */
  emptyLabel?: string;
}

/** Select over civil objects; an unknown `value` falls back to the first object (or empty). */
export function CivilObjectSelect({
  objects,
  value,
  label,
  onChange,
  emptyLabel,
}: CivilObjectSelectProps): React.ReactElement {
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

/**
 * A select's chosen object id with its setter: the picked id while it still names one of `objects`,
 * else the object at `preferredIndex` (when given and nothing was picked), else `chosenId`'s
 * fallback.
 */
export function useChosenId(
  objects: ReadonlyArray<CivilObject>,
  allowEmpty = false,
  preferredIndex?: number,
): [string, (id: string) => void] {
  const [picked, setPicked] = useState('');
  const value =
    picked === '' && preferredIndex !== undefined ? (objects[preferredIndex]?.id ?? '') : picked;
  return [chosenId(objects, value, allowEmpty), setPicked];
}

interface CivilFieldProps {
  value: string;
  set: (text: string) => void;
  hint: string;
  label: string;
}

function CivilInput({
  value,
  set,
  hint,
  label,
  type,
}: CivilFieldProps & { type?: 'number' }): React.ReactElement {
  return (
    <input
      type={type}
      value={value}
      placeholder={hint}
      aria-label={label}
      onChange={(event) => set(event.target.value)}
    />
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
  /** Controls placed before the points field. */
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
