// Fetches a content-addressed flow result file (a slice or streamline file a `cfd_*` query returned by hash) from the local backend.

import { SERVER_BASE, serverAuthHeaders } from '@ui/serverConfig';

const HASH = /^[0-9a-f]{64}$/;

/** The bytes of the stored file `sha256`. @throws Error with the reason when the backend does not have it. */
export async function fetchCfdFile(sha256: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (!HASH.test(sha256)) throw new Error('The transport returned no valid file hash.');
  const response = await fetch(`${SERVER_BASE}/cfd/file/${sha256}`, {
    headers: serverAuthHeaders(),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error(`The backend could not serve the result file (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}
