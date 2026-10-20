// REST file/metadata calls to the optional server (STEP export, DWG import); wire shapes from @protocol/restProtocol.
// Never throws: every failure becomes a user-facing message.

import type { DocumentUnit } from '@core/model/types';
import type { DwgImportResponseBody, DwgImportTarget, ErrorResponseBody } from '@protocol/restProtocol';
import { fileStem } from '@ui/chosenFile';
import { SERVER_BASE, serverAuthHeaders } from '@ui/serverConfig';
import { postCommand, ServerCommandError } from '@ui/store/serverCommands';
import { isRecord } from '@lib/isRecord';

export type ServerFileResult =
  | { readonly ok: true; readonly blob: Blob; readonly message: string }
  | { readonly ok: false; readonly message: string };

async function errorOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as Partial<ErrorResponseBody>;
  return body.error ?? `${fallback} (HTTP ${response.status}).`;
}

/** Exact STEP of the server's live model (Python bridge). */
export async function fetchStepExport(name: string): Promise<ServerFileResult> {
  try {
    const response = await fetch(`${SERVER_BASE}/export/step?name=${encodeURIComponent(name)}`, { headers: serverAuthHeaders() });
    if (!response.ok) return { ok: false, message: await errorOf(response, 'STEP export failed') };
    return { ok: true, blob: await response.blob(), message: 'STEP exported from the server’s live model.' };
  } catch {
    return { ok: false, message: `STEP export needs the llull server at ${SERVER_BASE}.` };
  }
}

export interface ExactExportCommand {
  readonly command: 'export_step_ap242' | 'export_iges';
  /** `data` field holding the file text. */
  readonly field: 'step' | 'iges';
  readonly fileName: string;
}

/**
 * Exact AP242 / IGES of the server's live model through its native kernel (read-only command over POST /command; the document is untouched). The
 * file is built from `data[field]`; a refusal (no exact kernel, unverified bodies, red self-check) is the command's own summary.
 */
export async function fetchExactExport(spec: ExactExportCommand, timestamp: string): Promise<ServerFileResult> {
  try {
    const reply = await postCommand(spec.command, spec.command === 'export_step_ap242' ? { timestamp, fileName: spec.fileName } : {});
    const text = isRecord(reply.data) ? reply.data[spec.field] : undefined;
    if (reply.isError || typeof text !== 'string') return { ok: false, message: reply.summary };
    return { ok: true, blob: new Blob([text], { type: 'text/plain;charset=utf-8' }), message: reply.summary };
  } catch (error) {
    if (error instanceof ServerCommandError)
      return { ok: false, message: `Exact export needs the llull desktop app or server (${error.message}).` };
    throw error;
  }
}

/** The server converts and imports into the live document (the change arrives over /live). Resolves to the status line. */
export async function uploadDwg(file: File, target: DwgImportTarget, unit: DocumentUnit): Promise<string> {
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
