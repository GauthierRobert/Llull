/**
 * @layer ui/components
 *
 * ProjectIO — Save (export) and Open (import) the current llull document as a
 * JSON file. Pure UI: Save serialises the in-store document and triggers a
 * browser download; Open reads a chosen file and dispatches `load_document`
 * (the registered command — PRIME DIRECTIVE: never mutate the document outside
 * a command).
 *
 * Cross-session persistence between server restarts is handled separately by
 * the server-side autosave in `server/src/liveDocument.ts`; this surface lets
 * the user explicitly carry a project across machines / branches.
 */

import React, { useRef } from 'react';
import { useStore } from '@ui/store';
import { serializeDocument } from '@core/commands/persistence';

function timestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function ProjectIO(): React.ReactElement {
  const document = useStore((s) => s.document);
  const dispatch = useStore((s) => s.dispatch);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSave = (): void => {
    const json = serializeDocument(document);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `llull-${timestamp()}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
        Open
      </button>
      <button
        type="button"
        className="project-io__btn"
        onClick={handleSave}
        aria-label="Save project to a JSON file"
        title="Save project (.json)"
      >
        Save
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
