// BCF in and out of the review: pick a .bcf (import_bcf, base64) and download the issues as one (export_bcf, read-only). Gathers the file
// and shows the command's own summary; the parsing, merging and the export gate are the commands'.

import React, { useRef, useState } from 'react';
import { downloadBlob } from '@ui/download';
import { takeChosenFile } from '@ui/chosenFile';
import { runQuery } from '@ui/services/localQuery';
import { useStore } from '@ui/store';
import { base64OfBytes, bytesOfBase64 } from './issueModel';

export function BcfActions({ issueIds }: { issueIds: readonly string[] }): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);
  const input = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState('');

  const onFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = takeChosenFile(event);
    if (file === undefined) return;
    file
      .arrayBuffer()
      .then((buffer) =>
        dispatch('import_bcf', { bcf: base64OfBytes(new Uint8Array(buffer)) }, { onResult: (result) => setStatus(result.summary) }),
      )
      .catch(() => setStatus(`Could not read ${file.name}.`));
  };

  const exportBcf = (): void => {
    const result = runQuery('export_bcf', { issueIds: [...issueIds], snapshots: false });
    const data = result.data as { base64?: unknown; fileName?: unknown } | undefined;
    if (typeof data?.base64 === 'string') {
      const name = typeof data.fileName === 'string' ? data.fileName : 'review.bcf';
      downloadBlob(new Blob([bytesOfBase64(data.base64)], { type: 'application/zip' }), name);
    }
    setStatus(result.summary);
  };

  return (
    <div className="bcf-actions">
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={() => input.current?.click()}
        title="Import issues from a BCF 2.1 or 3.0 file"
      >
        Import BCF
      </button>
      <input ref={input} type="file" accept=".bcf,.bcfzip" onChange={onFile} style={{ display: 'none' }} aria-label="BCF file to import" />
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        disabled={issueIds.length === 0}
        onClick={exportBcf}
        title="Download the issues as a BCF 3.0 file"
      >
        Export BCF
      </button>
      {status !== '' && (
        <p className="panel__row-meta" role="status" data-testid="bcf-status">
          {status}
        </p>
      )}
    </div>
  );
}
