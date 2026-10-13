/**
 * @layer ui/panels
 * QueryDownloadButton — runs a read-only export command on the current document, downloads its file
 * payload and reports the command summary (see `downloadQuery`). Never changes the document.
 */

import React from 'react';
import { downloadQuery } from '@ui/services/localQuery';

interface QueryDownloadButtonProps {
  label: string;
  command: string;
  params?: Record<string, unknown>;
  /** Field of the command's `data` that holds the file content. */
  field: string;
  /** File name when the command reports none; null = download nothing then. */
  fallbackName: string | null;
  mimeType: string;
  /** Receives the command summary (shown as the section status). */
  onStatus: (summary: string) => void;
  primary?: boolean;
  title?: string;
}

export function QueryDownloadButton({
  label,
  command,
  params = {},
  field,
  fallbackName,
  mimeType,
  onStatus,
  primary = false,
  title,
}: QueryDownloadButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      className={`btn ${primary ? 'btn--primary' : 'btn--ghost'} btn--sm`}
      title={title}
      onClick={() => onStatus(downloadQuery(command, params, field, fallbackName, mimeType))}
    >
      {label}
    </button>
  );
}
