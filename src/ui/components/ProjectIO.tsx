// Save downloads the document JSON; Open dispatches `load_document`; New `clear_document` + clears the browser autosave.
// Persistence across sessions: browser autosave offline, server autosave (server/src/liveDocument.ts) online.

import React, { useRef, useState } from 'react';
import { useStore, useToolStore } from '@ui/store';
import { isLocalMode } from '@ui/store/localMode';
import { useSessionStore } from '@ui/store/sessionStore';
import { browserStorage, clearAutosave, writeAutosave } from '@ui/store/autosave';
import { ConfirmDialog } from '@ui/components/ConfirmDialog';
import { projectFileStem } from '@ui/components/projectName';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { Icon } from '@ui/components/Icon';
import { downloadBlob } from '@ui/download';
import { readChosenFile } from '@ui/chosenFile';
import { DOCUMENT_ACCEPT } from '@mcp/documentFiles';

function timestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function ProjectIO(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const liveStatus = useStore((s) => s.liveStatus);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [confirmingNew, setConfirmingNew] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);

  const handleSave = (): void => {
    const document = useStore.getState().document;
    const json = serializeDocument(document);
    const stem = projectFileStem(document, `llull-${timestamp()}`);
    downloadBlob(new Blob([json], { type: 'application/json' }), `${stem}.json`);
    useSessionStore.getState().markSaved();
    // Offline only, like autosave: the stored copy now equals the saved file.
    const storage = browserStorage();
    if (storage !== null && useStore.getState().liveStatus !== 'connected') {
      writeAutosave(storage, { savedAt: Date.now(), json, clean: true });
    }
  };

  const startNewProject = (): void => {
    dispatch('clear_document', {});
    useStore.getState().clearSelection();
    useStore.getState().clearLastMeasure();
    useToolStore.getState().setDrawTool('none');
    useToolStore.getState().setModifyTool('none');
    const storage = browserStorage();
    if (storage !== null) clearAutosave(storage);
    useSessionStore.getState().setRestoredAt(null);
    useSessionStore.getState().markSaved();
    setConfirmingNew(false);
  };

  const handleNewClick = (): void => {
    if (useStore.getState().document.order.length === 0) startNewProject();
    else setConfirmingNew(true);
  };

  /** Empty → loaded is framed by useAutoFrame; a replaced document is framed here. */
  const afterOpen =
    (replacedContent: boolean) =>
    ({ changed }: { changed: boolean }): void => {
      if (!changed) return;
      useSessionStore.getState().markSaved();
      useSessionStore.getState().setRestoredAt(null);
      if (replacedContent && isLocalMode(useStore.getState())) {
        dispatch('fit_view', { direction: 'iso' }, { quiet: true, coalesce: true });
      }
    };

  const handleOpenClick = (): void => {
    fileInputRef.current?.click();
  };

  const openJson = (json: string): void => {
    const replacedContent = useStore.getState().document.order.length > 0;
    dispatch('load_document', { json }, { onResult: afterOpen(replacedContent) });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    readChosenFile(e, (json) => {
      if (useSessionStore.getState().dirty) setPendingOpen(json);
      else openJson(json);
    });
  };

  return (
    <span className="project-io" role="group" aria-label="Project file">
      <button type="button" className="project-io__btn" onClick={handleNewClick} aria-label="New project" title="New project">
        <Icon name="plus" size={14} />
        <span>New</span>
      </button>
      <button
        type="button"
        className="project-io__btn"
        onClick={handleOpenClick}
        aria-label="Open project from a JSON file"
        title="Open project (.json)"
      >
        <Icon name="open" size={14} />
        <span>Open</span>
      </button>
      <button
        type="button"
        className="project-io__btn"
        onClick={handleSave}
        aria-label="Save project to a JSON file"
        title="Save project (.json)"
      >
        <Icon name="save" size={14} />
        <span>Save</span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept={DOCUMENT_ACCEPT}
        onChange={handleFileChange}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
      {confirmingNew && (
        <ConfirmDialog
          title="Start a new project?"
          message={
            liveStatus === 'connected'
              ? 'This clears the SHARED live model on the server, for every connected user and agent. You can undo it right after.'
              : 'This clears the current model. You can undo it right after.'
          }
          confirmLabel="Clear and start new"
          onConfirm={startNewProject}
          onCancel={() => setConfirmingNew(false)}
        />
      )}
      {pendingOpen !== null && (
        <ConfirmDialog
          title="Open another project?"
          message="You have unsaved changes. Opening a file replaces the current model. You can undo it right after."
          confirmLabel="Discard changes and open"
          onConfirm={() => {
            openJson(pendingOpen);
            setPendingOpen(null);
          }}
          onCancel={() => setPendingOpen(null)}
        />
      )}
    </span>
  );
}
