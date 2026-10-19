/**
 * The live document's command log for crash reports (SC-D3): a base document plus the commands applied since, i.e. exactly what the
 * `/live` command events carry. A change without a command (undo/redo, session command, snapshot) rebases it, as it resyncs clients.
 */
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { withoutConfirmations } from '@lib/withoutConfirmations';
import type { LoggedCommand } from './crashReports';

/** Past this many commands the log rebases on the current document (bounded memory; the report then replays from that base). */
const MAX_LOGGED_COMMANDS = 2000;

let base: CadDocument = createEmptyDocument();
let commands: LoggedCommand[] = [];

export function rebaseCommandLog(doc: CadDocument): void {
  base = doc;
  commands = [];
}

export function logLiveCommand(next: CadDocument, name: string, params: unknown): void {
  if (commands.length >= MAX_LOGGED_COMMANDS) rebaseCommandLog(next);
  else commands.push({ name, params: withoutConfirmations(params) });
}

/** The base document and the commands that rebuild the live document from it. */
export function liveCommandLog(): { readonly base: CadDocument; readonly commands: readonly LoggedCommand[] } {
  return { base, commands };
}
