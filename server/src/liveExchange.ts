/**
 * @layer server
 * Exchange tools (export_step, import_step, import_dwg, import_code) against the shared live
 * document, for both transports (`POST /exchange` and MCP tools/call): the same handlers as MCP
 * (`applyExchangeToolCall`), with every document change routed through the command bus (undo,
 * live sync, audit).
 */

import { applyExchangeToolCall } from '@mcp/index';
import { applyCommand } from './commandBus';
import { getLiveDoc } from './liveDocument';
import type { ExchangeOptions } from './pythonExchange';
import type { Actor } from './audit';

/** Run an exchange tool against the live document; its commands go through the command bus. */
export function applyLiveExchangeToolCall(
  name: string,
  params: unknown,
  exchange: ExchangeOptions,
  actor: Actor,
): ReturnType<typeof applyExchangeToolCall> {
  return applyExchangeToolCall(name, params, {
    port: exchange.port,
    dwg: exchange.dwg ?? null,
    getDoc: getLiveDoc,
    applyCommand: (commandName, commandParams) =>
      applyCommand(commandName, commandParams, undefined, actor),
    allowCodeExecution: exchange.allowCodeExecution,
  });
}
