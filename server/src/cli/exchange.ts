/**
 * @layer server
 * The exchange tools (export_step, import_step, import_dwg, import_code) in the `llull` CLI. They
 * are not registry commands — Python / DWG I/O sits behind ports — so the CLI runs the same MCP-
 * layer handlers: in-process for a local --doc (document changes via `execute`), `POST /exchange`
 * for --app / --server. `file=<path>` reads a local file into the tool's content parameter.
 */

import fs from 'fs';
import type { CadDocument } from '@core/model/types';
import { buildExchangeToolDefinitions } from '@mcp/index';
import type { McpToolDefinition } from '@mcp/tools';
import { isRecord } from '@lib/isRecord';
import { runExchangeTool } from '../exchangeResult';
import type { ExchangeOptions } from '../pythonExchange';
import type { CommandOutcome } from '@mcp/restProtocol';

let definitions: readonly McpToolDefinition[] | null = null;

export function exchangeToolDefinitions(): readonly McpToolDefinition[] {
  definitions ??= buildExchangeToolDefinitions();
  return definitions;
}

export function exchangeTool(name: string): McpToolDefinition | undefined {
  return exchangeToolDefinitions().find((tool) => tool.name === name);
}

/** `file=` target per tool: the parameter it fills and how the file is read. */
const FILE_PARAMS: Readonly<Record<string, { key: string; encoding: 'base64' | 'utf8' }>> = {
  import_step: { key: 'stepBase64', encoding: 'base64' },
  import_dwg: { key: 'dwgBase64', encoding: 'base64' },
  import_code: { key: 'code', encoding: 'utf8' },
};

/**
 * Replace `file=<path>` with the tool's content parameter, read from the local disk (works the
 * same against a local doc, the desktop app or a remote server).
 * @failure unreadable file -> Error; `file` on a tool without content -> Error
 */
export function withFileContent(name: string, params: unknown): unknown {
  if (!isRecord(params) || typeof params['file'] !== 'string') return params;
  const target = FILE_PARAMS[name];
  if (target === undefined) throw new Error(`${name} takes no file= parameter.`);
  const { file, ...rest } = params;
  return { ...rest, [target.key]: fs.readFileSync(file).toString(target.encoding) };
}

interface LocalExchangeContext {
  readonly options: ExchangeOptions;
  readonly getDoc: () => CadDocument;
  /** Runs a registry command on the local document (tracks + saves it like any CLI command). */
  readonly runCommand: (name: string, params: unknown) => CommandOutcome;
}

/** Run an exchange tool in-process against a local document. */
export async function runLocalExchange(
  name: string,
  params: unknown,
  context: LocalExchangeContext,
): Promise<CommandOutcome> {
  const outcome = await runExchangeTool(name, params, context.options, {
    getDoc: context.getDoc,
    applyCommand: context.runCommand,
  });
  if (outcome === null) throw new Error(`${name} is not an exchange tool.`);
  return outcome;
}
