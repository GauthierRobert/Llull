// The open sheet: title block form, its views (select / delete) and the add-view forms.

import React from 'react';
import type { DrawingSheet } from '@core/model/sheet';
import { useStore } from '@ui/store';
import { useSheetViewStore } from '@ui/viewport/sheet/sheetViewStore';
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
          onSelect={() => selectView(view.id === selectedViewId ? null : view.id)}
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
