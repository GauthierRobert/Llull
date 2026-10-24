// Transport of `POST /preview` (04 DIR M6): a dry run on the backend's live document. Never changes it (no log, no stream frame, no undo entry).

import { SERVER_BASE, serverAuthHeaders } from '@ui/serverConfig';
import type { PreviewResponseBody } from '@protocol/preview';

/** @throws Error on a network failure, a non-2xx answer or when `signal` aborts (the caller drops aborted requests). */
export async function postPreview(name: string, params: unknown, signal: AbortSignal): Promise<PreviewResponseBody> {
  const response = await fetch(`${SERVER_BASE}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serverAuthHeaders() },
    body: JSON.stringify({ name, params }),
    signal,
  });
  if (!response.ok) throw new Error(`Preview unavailable (HTTP ${response.status}).`);
  return (await response.json()) as PreviewResponseBody;
}
