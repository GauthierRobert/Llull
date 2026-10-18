// The open sheet: title block form, its views (select / delete) and the add-view forms.

import React from 'react';
import type { DrawingSheet } from '@core/model/sheet';
import { useStore } from '@ui/store';
import { useSheetViewStore } from '@ui/viewport/sheet/sheetViewStore';
import { is3D } from '@core/model/types';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import { useFocusStore } from '@ui/store/focusStore';
import { entitiesFocus } from '@ui/panels/entityFocus';
import { DeleteButton, ListRow, PanelEmpty, PanelSection } from '@ui/panels/PanelParts';
import { AddViewForms } from './AddViewForms';
import { EditSheetForm } from './EditSheetForm';

function viewMeta(view: DrawingSheet['views'][number]): string {
  if (view.kind === 'detail') return 'detail';
  return `${view.kind} · ${view.direction ?? ''}`;
}

function ViewList({ sheet }: { sheet: DrawingSheet }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const selectedViewId = useSheetViewStore((s) => s.selectedViewId);
  const selectView = useSheetViewStore((s) => s.selectView);
  const focusItem = useFocusItem();
  // Selecting a view also highlights its source on the model: its recorded entities, else every 3D solid (what an unscoped view shows).
  const highlightSource = (view: DrawingSheet['views'][number]): void => {
    const doc = useStore.getState().document;
    const ids =
      view.entityIds ?? Object.values(doc.entities).flatMap((entity) => (entity !== undefined && is3D(entity) ? [entity.id] : []));
    focusItem(entitiesFocus(doc, { key: `sheets:view:${view.id}`, label: `View ${view.label} — source geometry`, ids }));
  };
  if (sheet.views.length === 0) return <PanelEmpty compact icon="square" message="No views yet" hint="Add one below." />;
  return (
    <ul className="panel__list" aria-label={`Views of ${sheet.name}`}>
      {sheet.views.map((view) => (
        <ListRow
          key={view.id}
          testId={`sheet-view-row-${view.id}`}
          buttonTestId={`sheet-view-select-${view.id}`}
          selected={view.id === selectedViewId}
          label={`Select view ${view.label}`}
          onSelect={() => {
            const deselect = view.id === selectedViewId;
            selectView(deselect ? null : view.id);
            if (deselect) useFocusStore.getState().setFocus(null);
            else highlightSource(view);
          }}
          actions={
            <DeleteButton
              label={`Delete view ${view.label}`}
              testId={`sheet-view-delete-${view.id}`}
              onDelete={() => dispatch('delete_drawing_view', { sheetId: sheet.id, viewId: view.id })}
            />
          }
        >
          <span className="panel__row-main">{view.label}</span>
          <span className="panel__row-meta">{viewMeta(view)}</span>
        </ListRow>
      ))}
    </ul>
  );
}

export function SheetDetails({ sheet }: { sheet: DrawingSheet }): React.ReactElement {
  return (
    <>
      <PanelSection title="Views" count={sheet.views.length} countLabel={`${sheet.views.length} views`}>
        <ViewList sheet={sheet} />
      </PanelSection>
      <PanelSection title="Add view" collapsible>
        <AddViewForms.Projection key={`p-${sheet.id}`} sheet={sheet} />
      </PanelSection>
      <PanelSection title="Add section view" collapsible>
        <AddViewForms.Section key={`s-${sheet.id}`} sheet={sheet} />
      </PanelSection>
      <PanelSection title="Add detail view" collapsible>
        <AddViewForms.Detail key={`d-${sheet.id}`} sheet={sheet} />
      </PanelSection>
      <PanelSection title="Sheet properties" collapsible>
        {/* Remounted per sheet and per saved state so the draft follows the document. */}
        <EditSheetForm
          key={`${sheet.id}-${JSON.stringify([sheet.name, sheet.paper, sheet.projectionAngle, sheet.titleBlock])}`}
          sheet={sheet}
        />
      </PanelSection>
    </>
  );
}
