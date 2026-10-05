/**
 * @layer ui
 *
 * Browser file download for exports (presentation side effect; never touches the document).
 */

/** Keep the object URL alive long enough for a busy browser to start reading it. */
const REVOKE_AFTER_MS = 60_000;

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately (or on the next tick) cancels the download when the main thread is busy.
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

export function downloadText(text: string, fileName: string, mimeType: string): void {
  downloadBlob(new Blob([text], { type: `${mimeType};charset=utf-8` }), fileName);
}
