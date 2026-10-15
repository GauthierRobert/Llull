// Drawing sheets (`document.drawings`): create / open / delete sheets, edit the open one. The viewer is `SheetViewer`.

import React, { useEffect, useRef, useState } from 'react';
import '@ui/styles/panels/sheets.css';
import type { DrawingSheet } from '@core/model/sheet';
import { classNames } from '@ui/classNames';
import { useStore } from '@ui/store';
import { ConfirmDialog } from '@ui/components/ConfirmDialog';
import { useSheetViewStore } from '@ui/viewport/sheet/sheetViewStore';
import { DeleteButton, ListRow, PanelEmpty, PanelHeader, PanelSection } from '@ui/panels/PanelParts';
import { NewSheetForm } from '@ui/panels/sheets/NewSheetForm';
import { SheetDetails } from '@ui/panels/sheets/SheetDetails';

export function SheetsPanel({ className }: { className?: string }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const drawings = useStore((s) => s.document.drawings);
  const openSheetId = useSheetViewStore((s) => s.openSheetId);
  const openSheet = useSheetViewStore((s) => s.openSheet);
  const closeSheet = useSheetViewStore((s) => s.closeSheet);
  const [pendingDelete, setPendingDelete] = useState<DrawingSheet | null>(null);
  const openNewest = useRef(false);

  const order = drawings?.order ?? [];
  const sheets = order.flatMap((id) => drawings?.sheets[id] ?? []);
  const openSheetData = openSheetId === null ? undefined : drawings?.sheets[openSheetId];

  // A sheet just created opens in the viewer (dispatch reports no ids; the new sheet is the last one).
  const newestId = order[order.length - 1];
  useEffect(() => {
    if (!openNewest.current || newestId === undefined) return;
    openNewest.current = false;
    openSheet(newestId);
  }, [order.length, newestId, openSheet]);

  const confirmDelete = (): void => {
    if (pendingDelete === null) return;
    if (pendingDelete.id === openSheetId) closeSheet();
    dispatch('delete_sheet', { sheetId: pendingDelete.id });
    setPendingDelete(null);
  };

  return (
    <aside className={classNames('panel', className)} aria-label="Drawing sheets" data-testid="sheets-panel">
      <PanelHeader title="Sheets" count={sheets.length} countLabel={`${sheets.length} sheets`} />
      <PanelSection title="Sheets" hint="2D drawings of the model: views stay live when the model changes.">
        {sheets.length === 0 ? (
          <PanelEmpty compact icon="square" message="No sheets yet" hint="Create one below." />
        ) : (
          <ul className="panel__list" aria-label="Sheets">
            {sheets.map((sheet) => (
              <ListRow
                key={sheet.id}
                testId={`sheet-row-${sheet.id}`}
                buttonTestId={`sheet-open-${sheet.id}`}
                selected={sheet.id === openSheetId}
                current={sheet.id === openSheetId}
                label={`Open sheet ${sheet.name}`}
                onSelect={() => openSheet(sheet.id)}
                actions={
                  <DeleteButton
                    label={`Delete sheet ${sheet.name}`}
                    testId={`sheet-delete-${sheet.id}`}
                    onDelete={() => setPendingDelete(sheet)}
                  />
                }
              >
                <span className="panel__row-main">{sheet.name}</span>
                <span className="panel__row-meta">
                  {sheet.paper} · {sheet.views.length} {sheet.views.length === 1 ? 'view' : 'views'}
                </span>
              </ListRow>
            ))}
          </ul>
        )}
      </PanelSection>
      {openSheetData !== undefined && <SheetDetails sheet={openSheetData} />}
      <PanelSection title="New sheet" collapsible>
        <NewSheetForm
          onSubmitted={() => {
            openNewest.current = true;
          }}
        />
      </PanelSection>
      {pendingDelete !== null && (
        <ConfirmDialog
          title="Delete sheet?"
          message={`"${pendingDelete.name}" and its ${pendingDelete.views.length} view(s) will be removed. The model is not affected.`}
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </aside>
  );
}
