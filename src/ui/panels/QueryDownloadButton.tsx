// Runs a read-only export, downloads its payload and reports the summary (`downloadQuery`).

import React from 'react';
import { downloadQuery } from '@ui/services/localQuery';

interface QueryDownloadButtonProps {
  label: string;
  command: string;
  params?: Record<string, unknown>;
  /** `data` field holding the file content. */
  field: string;
  /** Used when the command reports no name; null = no download then. */
  fallbackName: string | null;
  mimeType: string;
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
