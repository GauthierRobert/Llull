/**
 * @layer ui/services
 *
 * REST calls that move files or metadata to/from the optional llull server (STEP export, DWG
 * import, license badge). Components call these and only render the returned status; the wire
 * shapes are shared with `server/` through `@mcp/restProtocol`. Never throws: every failure
 * becomes a user-facing message.
 */

import type { DocumentUnit } from '@core/model/types';
import type {
  DwgImportResponseBody,
  DwgImportTarget,
  ErrorResponseBody,
  LicenseResponseBody,
} from '@mcp/restProtocol';
import { fileStem } from '@ui/chosenFile';
import { SERVER_BASE, serverAuthHeaders } from '@ui/serverConfig';

/** Outcome of a server file transfer: the file (when one came back) and a status line. */
export type ServerFileResult =
  | { readonly ok: true; readonly blob: Blob; readonly message: string }
  | { readonly ok: false; readonly message: string };

async function errorOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as Partial<ErrorResponseBody>;
  return body.error ?? `${fallback} (HTTP ${response.status}).`;
}

/** GET /export/step — the server's live model as an exact STEP file (Python bridge). */
export async function fetchStepExport(name: string): Promise<ServerFileResult> {
  try {
    const response = await fetch(`${SERVER_BASE}/export/step?name=${encodeURIComponent(name)}`, {
      headers: serverAuthHeaders(),
    });
    if (!response.ok) return { ok: false, message: await errorOf(response, 'STEP export failed') };
    return {
      ok: true,
      blob: await response.blob(),
      message: 'STEP exported from the server’s live model.',
    };
  } catch {
    return { ok: false, message: `STEP export needs the llull server at ${SERVER_BASE}.` };
  }
}

/**
 * POST /import/dwg — the server converts the DWG and runs the import command on the live
 * document (the change arrives through `/live`). Resolves to the status line to show.
 */
export async function uploadDwg(
  file: File,
  target: DwgImportTarget,
  unit: DocumentUnit,
): Promise<string> {
  const query = new URLSearchParams({ target, sourceUnit: unit });
  if (target === 'survey') query.set('name', fileStem(file.name));
  try {
    const response = await fetch(`${SERVER_BASE}/import/dwg?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...serverAuthHeaders() },
      body: file,
    });
    if (!response.ok) return await errorOf(response, 'DWG import failed');
    const reply = (await response.json().catch(() => ({}))) as Partial<DwgImportResponseBody>;
    return reply.summary ?? 'DWG imported.';
  } catch {
    return `DWG import needs the llull server at ${SERVER_BASE} (offline), with a DWG converter installed.`;
  }
}

/** GET /license — the license label for the status bar, or null offline / on any failure. */
export async function fetchLicenseLabel(signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(`${SERVER_BASE}/license`, signal ? { signal } : {});
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<LicenseResponseBody>;
    return typeof body.label === 'string' ? body.label : null;
  } catch {
    return null;
  }
}
