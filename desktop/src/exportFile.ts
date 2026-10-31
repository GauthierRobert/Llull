/**
 * File > Export 3MF…: the backend writes the package to a host file (`export_3mf` toFile, 05 IMP 14.12) and the desktop moves that file to the
 * chosen path. The bytes never pass through the renderer or this process's memory. Only `export_3mf` has a file sink today.
 */
import path from 'path';
import { isRecord } from '@lib/isRecord';
import { outcomeIsFailure } from '@protocol/commandOutcome';
import { parseCommandResponse } from '@protocol/restProtocol';
import { requestJson, type FetchLike } from '@server/restClient';
import { saveDataFiles } from '@server/cli/saveFiles';
import { isHostedExport } from '@server/exportFiles';

export interface ExportFileOptions {
  readonly url: string;
  readonly token: string;
  readonly target: string;
  /** The folder the backend writes hosted exports to (`desktopExportDir`): a reported file anywhere else is refused and left alone. */
  readonly exportDir: string;
  readonly fetchImpl?: FetchLike;
}

/** Exports the live document as 3MF to `target`; resolves with a one-line message. @failure a refused export or an unusable answer -> rejects with the summary */
export async function export3mfToFile(options: ExportFileOptions): Promise<string> {
  const { status, body } = await requestJson(`${options.url}/command`, {
    body: { name: 'export_3mf', params: { toFile: true, name: path.basename(options.target, path.extname(options.target)) } },
    token: options.token,
    fetchImpl: options.fetchImpl,
  });
  const outcome = parseCommandResponse(body, status);
  if (outcomeIsFailure('export_3mf', outcome, true))
    throw new Error(outcome.summary !== '' ? outcome.summary : `export_3mf failed (HTTP ${status})`);
  const file = isRecord(outcome.data) ? outcome.data['file'] : undefined;
  if (!isRecord(file) || typeof file['path'] !== 'string' || typeof file['bytes'] !== 'number')
    throw new Error(`export_3mf reported no usable file (data.file.path and data.file.bytes are needed): ${outcome.summary}`);
  if (!isHostedExport(file['path'], options.exportDir))
    throw new Error(`export_3mf reported a file outside the export folder (${file['path']}); nothing was moved`);
  const saved = saveDataFiles(outcome.data, path.resolve(options.target), options.exportDir)[0];
  if (saved === undefined) throw new Error('the exported file could not be saved');
  return `${saved.path} (${saved.bytes} bytes)`;
}
