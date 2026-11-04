// Material classes of the display (plant 09 VIS-M8f): the named classes in force (defaults + document), define / edit one, delete one and
// assign a class to the selection. Every change is a command (define_material_class, delete_material_class, assign_material_class); a
// refusal (e.g. VIS_MATERIAL_CLASS_IN_USE) is shown as the command's summary. The viewport reads the classes from the document.

import React, { useMemo, useState } from 'react';
import { effectiveMaterialClasses } from '@core/geometry/materialClasses';
import type { MaterialClass } from '@core/model/display';
import type { CadDocument } from '@core/model/types';
import { FormError, PanelSection } from '@ui/panels/PanelParts';
import { useStore } from '@ui/store';

interface Draft {
  id: string;
  name: string;
  /** False = keep the entity colour (class colour null). */
  coloured: boolean;
  colour: string;
  metalness: string;
  roughness: string;
}

const NEW_DRAFT: Draft = { id: '', name: '', coloured: true, colour: '#8f999f', metalness: '0.5', roughness: '0.5' };

const draftOf = (entry: MaterialClass): Draft => ({
  id: entry.id,
  name: entry.name,
  coloured: entry.colour !== null,
  colour: entry.colour ?? NEW_DRAFT.colour,
  metalness: String(entry.metalness),
  roughness: String(entry.roughness),
});

export function MaterialClassSection({ document }: { document: CadDocument }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const [draft, setDraft] = useState<Draft>(NEW_DRAFT);
  const [status, setStatus] = useState('');
  const classes = useMemo(() => effectiveMaterialClasses(document.display), [document.display]);
  const own = document.display?.materialClasses ?? {};
  const assignedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [entityId, classId] of Object.entries(document.display?.materialClassOf ?? {})) {
      if (document.entities[entityId] !== undefined) counts.set(classId, (counts.get(classId) ?? 0) + 1);
    }
    return counts;
  }, [document.display, document.entities]);
  const selection = document.selection;
  const report = (result: { changed: boolean; summary: string }): void => setStatus(result.changed ? '' : result.summary);

  const define = (): void =>
    dispatch(
      'define_material_class',
      {
        id: draft.id.trim(),
        ...(draft.name.trim() !== '' && { name: draft.name.trim() }),
        colour: draft.coloured ? draft.colour : null,
        metalness: Number(draft.metalness),
        roughness: Number(draft.roughness),
      },
      { onResult: report },
    );
  const assign = (classId: string | null): void =>
    dispatch('assign_material_class', { classId, entityIds: selection }, { onResult: report });
  const set = (patch: Partial<Draft>): void => setDraft((current) => ({ ...current, ...patch }));

  return (
    <PanelSection title="Material classes" testId="review-material-classes" collapsible>
      <ul className="panel__list" aria-label="Material classes">
        {classes.map((entry) => {
          const count = assignedCounts.get(entry.id) ?? 0;
          return (
            <li key={entry.id} className="panel__row" data-testid={`material-class-${entry.id}`}>
              <span
                className="panel__swatch"
                style={entry.colour === null ? { border: '1px dashed currentColor' } : { background: entry.colour }}
                aria-hidden="true"
              />
              <span className="panel__row-main">
                {entry.name}
                <span className="panel__row-meta">
                  {' '}
                  M {entry.metalness} · R {entry.roughness}
                  {count > 0 ? ` · ${count} assigned` : ''}
                </span>
              </span>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                aria-label={`Assign ${entry.name} to the selection`}
                disabled={selection.length === 0}
                onClick={() => assign(entry.id)}
              >
                Assign
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                aria-label={`Edit ${entry.name}`}
                onClick={() => setDraft(draftOf(entry))}
              >
                Edit
              </button>
              {Object.hasOwn(own, entry.id) && (
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  aria-label={`Delete ${entry.name}`}
                  onClick={() => dispatch('delete_material_class', { id: entry.id }, { onResult: report })}
                >
                  Delete
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="issue-form">
        <button type="button" className="btn btn--sm btn--ghost" disabled={selection.length === 0} onClick={() => assign(null)}>
          Clear class of selection
        </button>
      </div>
      <div className="issue-form">
        <input
          className="field__input"
          aria-label="Class id"
          placeholder="class_id"
          value={draft.id}
          onChange={(event) => set({ id: event.target.value })}
        />
        <input
          className="field__input"
          aria-label="Class name"
          placeholder="Name"
          value={draft.name}
          onChange={(event) => set({ name: event.target.value })}
        />
      </div>
      <div className="issue-form">
        <label className="datasheet__toggle">
          <input type="checkbox" checked={draft.coloured} onChange={(event) => set({ coloured: event.target.checked })} />
          Colour
        </label>
        <input
          type="color"
          aria-label="Class colour"
          value={draft.colour}
          disabled={!draft.coloured}
          onChange={(event) => set({ colour: event.target.value })}
        />
        <input
          className="field__input"
          type="number"
          min={0}
          max={1}
          step={0.05}
          aria-label="Metalness"
          value={draft.metalness}
          onChange={(event) => set({ metalness: event.target.value })}
        />
        <input
          className="field__input"
          type="number"
          min={0}
          max={1}
          step={0.05}
          aria-label="Roughness"
          value={draft.roughness}
          onChange={(event) => set({ roughness: event.target.value })}
        />
        <button type="button" className="btn btn--sm" disabled={draft.id.trim() === ''} onClick={define}>
          Save class
        </button>
      </div>
      <FormError text={status} />
    </PanelSection>
  );
}
