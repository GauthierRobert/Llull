/**
 * The exchange tools (export_step, import_step, import_dwg, import_code) live in `@protocol` and
 * return shaped tool results (`shapeToolCallContent`). REST (`POST /exchange`) and the CLI want the command
 * bus shape `{ summary, affected, isError, data }`; this recovers it from `structuredContent`,
 * which carries the full data and every affected id.
 */

import type { ShapedToolResult } from '@protocol/toolResult';
import { applyExchangeToolCall, type ExchangeDeps } from '@protocol/exchangeTools';
import type { CadDocument } from '@core/model/types';
import type { CommandOutcome } from '@protocol/restProtocol';
import type { ExchangeCommandResult } from '@protocol/exchangeTools';
import type { ExchangeOptions } from './pythonExchange';
import { isRecord } from '@lib/isRecord';
import { runNativeTool } from './native/tools';

const AFFECTED_LINE = /^Affected entity ids: (.+)$/;

export function unshapeExchangeResult(shaped: ShapedToolResult): ExchangeCommandResult {
  const summary = shaped.content[0]?.text ?? '';
  const structured = shaped.structuredContent;
  const fromStructure =
    isRecord(structured) && Array.isArray(structured['affected'])
      ? structured['affected'].filter((id): id is string => typeof id === 'string')
      : null;
  const fromText = shaped.content
    .map((block) => AFFECTED_LINE.exec(block.text)?.[1])
    .find((ids) => ids !== undefined)
    ?.split(', ');
  const affected = fromStructure ?? fromText ?? [];
  let data: unknown;
  if (structured !== undefined) {
    const rest = Object.fromEntries(Object.entries(structured).filter(([key]) => key !== 'affected'));
    data = 'data' in rest && Object.keys(rest).length === 1 ? rest['data'] : rest;
  }
  return {
    summary,
    affected,
    isError: shaped.isError,
    ...(data !== undefined && !(isRecord(data) && Object.keys(data).length === 0) ? { data } : {}),
  };
}

/** The dependencies of the exchange tools: the configured ports + the host document. */
function exchangeDepsOf(exchange: ExchangeOptions, host: ExchangeHost): ExchangeDeps {
  return {
    port: exchange.port,
    dwg: exchange.dwg ?? null,
    fea: exchange.fea ?? null,
    libraries: exchange.libraries ?? null,
    getDoc: host.getDoc,
    applyCommand: host.applyCommand,
    allowCodeExecution: exchange.allowCodeExecution,
  };
}

export interface ExchangeHost {
  readonly getDoc: () => CadDocument;
  /** Runs a registry command on the host's document (command bus, or a local tracked document). */
  readonly applyCommand: (name: string, params: unknown) => ExchangeCommandResult;
  /** One line per solver iteration of a native job (the CLI's `--progress`); absent on the server. */
  readonly onProgress?: (line: string) => void;
}

/**
 * Run an exchange tool and answer the command-bus shape plus `changed` (the host document was
 * replaced). null = `name` is not an exchange tool. The one wiring of ports + host for REST and CLI:
 * the native transports (fatigue_field, fea_map_field, fea_render, topology_solve: `native/tools.ts`) run here too,
 * so a local `--doc`, `--app` and `--server` (`POST /exchange`) reach the same handlers.
 */
export async function runExchangeTool(
  name: string,
  params: unknown,
  exchange: ExchangeOptions,
  host: ExchangeHost,
): Promise<CommandOutcome | null> {
  const native = await runNativeTool(name, params, host);
  if (native !== null) return native;
  const before = host.getDoc();
  const shaped = await applyExchangeToolCall(name, params, exchangeDepsOf(exchange, host));
  if (shaped === null) return null;
  return { ...unshapeExchangeResult(shaped), changed: host.getDoc() !== before };
}
