/**
 * Exchange tools (export_step, import_step, import_dwg, import_code) against the shared live
 * document, for both transports (`POST /exchange` and MCP tools/call): the same handlers as MCP
 * (`applyExchangeToolCall`), with every document change routed through the command bus (undo,
 * live sync).
 */

import { applyExchangeToolCall } from '@mcp/index';
import type { CommandOutcome } from '@mcp/restProtocol';
import { exchangeDepsOf, runExchangeTool, type ExchangeHost } from './exchangeResult';
import { applyCommand } from './commandBus';
import { getLiveDoc } from './liveDocument';
import type { ExchangeOptions } from './pythonExchange';
import type { LiveCommandSource } from '@mcp/liveSync';

/** The live document + the command bus (undo, live sync events tagged with `source`). */
const liveHost = (source: LiveCommandSource): ExchangeHost => ({
  getDoc: getLiveDoc,
  applyCommand: (commandName, commandParams) => applyCommand(commandName, commandParams, undefined, source),
});

/** Run an exchange tool against the live document (MCP tools/call); commands go through the bus. */
export function applyLiveExchangeToolCall(
  name: string,
  params: unknown,
  exchange: ExchangeOptions,
  source: LiveCommandSource,
): ReturnType<typeof applyExchangeToolCall> {
  return applyExchangeToolCall(name, params, exchangeDepsOf(exchange, liveHost(source)));
}

/** The same call answered in the command-bus shape (REST `POST /exchange`). */
export function runLiveExchangeTool(
  name: string,
  params: unknown,
  exchange: ExchangeOptions,
  source: LiveCommandSource,
): Promise<CommandOutcome | null> {
  return runExchangeTool(name, params, exchange, liveHost(source));
}
