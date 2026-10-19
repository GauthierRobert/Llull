/**
 * Exchange tools (export_step, import_step, import_dwg, import_code) against the shared live
 * document for `POST /exchange` (the CLI with --app / --server): the same handlers the CLI runs
 * in-process, with every document change routed through the command bus (undo, live sync).
 */

import type { CommandOutcome } from '@protocol/restProtocol';
import { runExchangeTool, type ExchangeHost } from './exchangeResult';
import { applyCommand } from './commandBus';
import { getLiveDoc } from './liveDocument';
import type { ExchangeOptions } from './pythonExchange';
import type { LiveCommandSource } from '@protocol/liveSync';

/** The live document + the command bus (undo, live sync events tagged with `source`). */
const liveHost = (source: LiveCommandSource): ExchangeHost => ({
  getDoc: getLiveDoc,
  applyCommand: (commandName, commandParams) => applyCommand(commandName, commandParams, undefined, source),
});

/** Run an exchange tool against the live document, answered in the command-bus shape (REST `POST /exchange`). */
export function runLiveExchangeTool(
  name: string,
  params: unknown,
  exchange: ExchangeOptions,
  source: LiveCommandSource,
): Promise<CommandOutcome | null> {
  return runExchangeTool(name, params, exchange, liveHost(source));
}
