/**
 * @layer ui/components
 *
 * ProjectIO — Save downloads the in-store document as JSON; Open reads a chosen file and
 * dispatches `load_document` (PRIME DIRECTIVE: never mutate the document outside a command).
 * Cross-session persistence is the server-side autosave in `server/src/liveDocument.ts`.
 */

import React, { useRef, useState } from 'react';
import { useStore, useToolStore } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import { clearAutosave } from '@ui/store/autosave';
import { ConfirmDialog } from '@ui/components/ConfirmDialog';
import { projectFileStem } from '@ui/components/projectName';
import { serializeDocument } from '@core/commands/persistence';
import { Icon } from '@ui/components/Icon';
import { downloadBlob } from '@ui/download';

function timestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function ProjectIO(): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [confirmingNew, setConfirmingNew] = useState(false);

  const handleSave = (): void => {
    const document = useStore.getState().document;
    const json = serializeDocument(document);
    const stem = projectFileStem(document, `llull-${timestamp()}`);
    downloadBlob(new Blob([json], { type: 'application/json' }), `${stem}.json`);
    useSessionStore.getState().markSaved();
  };

  const startNewProject = (): void => {
    dispatch('clear_document', {});
    useStore.getState().clearSelection();
    useStore.getState().clearLastMeasure();
    useToolStore.getState().setDrawTool('none');
    useToolStore.getState().setModifyTool('none');
    try {
      clearAutosave(window.localStorage);
    } catch {
      // storage unavailable: nothing to clear
    }
    useSessionStore.getState().setRestoredAt(null);
    useSessionStore.getState().markSaved();
    setConfirmingNew(false);
  };

  const handleNewClick = (): void => {
    if (useStore.getState().document.order.length === 0) startNewProject();
    else setConfirmingNew(true);
  };

  const afterOpen = ({ changed }: { changed: boolean }): void => {
    if (!changed) return;
    useSessionStore.getState().markSaved();
    useSessionStore.getState().setRestoredAt(null);
    dispatch('fit_view', { direction: 'iso' }, { quiet: true });
  };

  const handleOpenClick = (): void => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void file.text().then((json) => {
      dispatch('load_document', { json }, { onResult: afterOpen });
    });
  };

  return (
    <span className="project-io" role="group" aria-label="Project file">
      <button
        type="button"
        className="project-io__btn"
        onClick={handleNewClick}
        aria-label="New project"
        title="New project"
      >
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
        accept="application/json,.json"
        onChange={handleFileChange}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
      {confirmingNew && (
        <ConfirmDialog
          title="Start a new project?"
          message="This clears the current model. You can undo it right after."
          confirmLabel="Clear and start new"
          onConfirm={startNewProject}
          onCancel={() => setConfirmingNew(false)}
        />
      )}
    </span>
  );
}
