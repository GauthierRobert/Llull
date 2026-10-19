/**
 * Shared harness of the CLI-driven production gates: the real Express app on an ephemeral loopback port, driven
 * through the `llull` CLI's server backend (`createRemoteBackend`, exactly what `llull --server` / `--app` sends:
 * `POST /command` and `POST /exchange`), and the live document it edits.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../../src/index';
import { _resetLiveDoc, getLiveDoc } from '../../src/liveDocument';
import { _resetHistory } from '../../src/commandBus';
import { createRemoteBackend } from '../../src/cli/backend';
import { exchangeTool } from '../../src/cli/exchange';
import { resultText } from '../../src/cli/output';
import { withFailureStatus } from '@protocol/commandOutcome';
import type { CadDocument } from '@core/model/types';

export interface ToolOutcome {
  text: string;
  isError: boolean;
  data: unknown;
}

let server: Server | null = null;
let baseUrl = '';

export async function startServer(): Promise<void> {
  if (server) return;
  const listening = await new Promise<Server>((resolve) => {
    const started: Server = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  server = listening;
  const address = listening.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

export async function stopServer(): Promise<void> {
  const running = server;
  server = null;
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
}

/** Fresh live document (optionally a given one) and empty undo history. */
export function resetDocument(doc?: CadDocument): void {
  _resetLiveDoc(doc);
  _resetHistory();
}

export function liveDocument(): CadDocument {
  return getLiveDoc();
}

/** One tool call as `llull exec <tool>` sends it to the running backend; the text is what the CLI prints. */
export async function callTool(tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const backend = createRemoteBackend(baseUrl, { token: undefined });
  const raw = exchangeTool(tool) !== undefined ? await backend.exchange(tool, args) : await backend.run(tool, args);
  const outcome = withFailureStatus(tool, raw);
  return { text: resultText(outcome), isError: outcome.isError, data: outcome.data };
}
