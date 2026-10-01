/**
 * @layer ui
 *
 * Browser file download for exports (presentation side effect; never touches the document).
 */

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // Revoking synchronously can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadText(text: string, fileName: string, mimeType: string): void {
  downloadBlob(new Blob([text], { type: `${mimeType};charset=utf-8` }), fileName);
}
