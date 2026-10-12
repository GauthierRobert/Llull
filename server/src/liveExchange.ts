/**
 * @layer server
 * Exchange tools (export_step, import_step, import_dwg, import_code) against the shared live
 * document, for both transports (`POST /exchange` and MCP tools/call): the same handlers as MCP
 * (`applyExchangeToolCall`), with every document change routed through the command bus (undo,
 * live sync, audit).
 */

import { applyExchangeToolCall } from '@mcp/index';
import type { CommandOutcome } from '@mcp/restProtocol';
import { exchangeDepsOf, runExchangeTool, type ExchangeHost } from './exchangeResult';
import { applyCommand } from './commandBus';
import { getLiveDoc } from './liveDocument';
import type { ExchangeOptions } from './pythonExchange';
import type { Actor } from './audit';

/** The live document + the command bus (undo, live sync, audit attributed to `actor`). */
const liveHost = (actor: Actor): ExchangeHost => ({
  getDoc: getLiveDoc,
  applyCommand: (commandName, commandParams) =>
    applyCommand(commandName, commandParams, undefined, actor),
});

/** Run an exchange tool against the live document (MCP tools/call); commands go through the bus. */
export function applyLiveExchangeToolCall(
  name: string,
  params: unknown,
  exchange: ExchangeOptions,
  actor: Actor,
): ReturnType<typeof applyExchangeToolCall> {
  return applyExchangeToolCall(name, params, exchangeDepsOf(exchange, liveHost(actor)));
}

/** The same call answered in the command-bus shape (REST `POST /exchange`). */
export function runLiveExchangeTool(
  name: string,
  params: unknown,
  exchange: ExchangeOptions,
  actor: Actor,
): Promise<CommandOutcome | null> {
  return runExchangeTool(name, params, exchange, liveHost(actor));
}
