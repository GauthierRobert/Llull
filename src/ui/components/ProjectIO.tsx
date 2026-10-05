/**
 * @layer ui/components
 *
 * ProjectIO — Save downloads the in-store document as JSON; Open reads a chosen file and
 * dispatches `load_document` (PRIME DIRECTIVE: never mutate the document outside a command).
 * Cross-session persistence is the server-side autosave in `server/src/liveDocument.ts`.
 */

import React, { useRef } from 'react';
import { useStore } from '@ui/store';
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

  const handleSave = (): void => {
    const json = serializeDocument(useStore.getState().document);
    downloadBlob(new Blob([json], { type: 'application/json' }), `llull-${timestamp()}.json`);
  };

  const handleOpenClick = (): void => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void file.text().then((json) => {
      dispatch('load_document', { json });
    });
  };

  return (
    <span className="project-io" role="group" aria-label="Project file">
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
    </span>
  );
}
