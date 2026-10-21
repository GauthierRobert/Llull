/**
 * The exchange tools (export_step, import_step, import_dwg, import_code), the FE tools (fea_mesh, fea_solve, fea_export, fea_import_field) and
 * the native transports (fatigue_field, fea_map_field, fea_render, topology_solve: `server/src/native/tools.ts`, run by `runExchangeTool`) in the
 * `llull` CLI. They are not registry commands — Python / DWG / solver I/O sits behind ports — so the CLI runs their `@protocol` handlers: in-process for a local --doc (document changes via `execute`), `POST /exchange`
 * for --app / --server. `file=<path>` reads a local file into the tool's content parameter.
 */

import fs from 'fs';
import type { CadDocument } from '@core/model/types';
import {
  buildExchangeToolDefinitions,
  buildFeaToolDefinitions,
  buildLibraryToolDefinitions,
  buildNativeToolDefinitions,
} from '@protocol/index';
import type { ToolDefinition } from '@protocol/tools';
import { isRecord } from '@lib/isRecord';
import { runExchangeTool } from '../exchangeResult';
import type { ExchangeOptions } from '../pythonExchange';
import type { CommandOutcome } from '@protocol/restProtocol';

let definitions: readonly ToolDefinition[] | null = null;

export function exchangeToolDefinitions(): readonly ToolDefinition[] {
  definitions ??= [
    ...buildExchangeToolDefinitions(),
    ...buildFeaToolDefinitions(),
    ...buildLibraryToolDefinitions(),
    ...buildNativeToolDefinitions(),
  ];
  return definitions;
}

export function exchangeTool(name: string): ToolDefinition | undefined {
  return exchangeToolDefinitions().find((tool) => tool.name === name);
}

/** `file=` target per tool: the parameter it fills and how the file is read. */
const FILE_PARAMS: Readonly<Record<string, { key: string; encoding: 'base64' | 'utf8' }>> = {
  import_step: { key: 'stepBase64', encoding: 'base64' },
  import_step_exact: { key: 'stepBase64', encoding: 'base64' },
  import_iges: { key: 'igesBase64', encoding: 'base64' },
  verify_exchange_file: { key: 'stepBase64', encoding: 'base64' },
  import_dwg: { key: 'dwgBase64', encoding: 'base64' },
  import_code: { key: 'code', encoding: 'utf8' },
  fea_import_field: { key: 'csv', encoding: 'utf8' },
  fea_import_results: { key: 'dataBase64', encoding: 'base64' },
  register_material_library: { key: 'libraryJson', encoding: 'utf8' },
};

/** Whether `file=<path>` fills a content parameter of `name` (the exchange tools and the registry commands that read a file: `import_step_exact`, `import_iges`, `verify_exchange_file`). */
export function takesFileParam(name: string): boolean {
  return FILE_PARAMS[name] !== undefined;
}

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
  /** Prints one solver progress line (`--progress`). */
  readonly onProgress?: (line: string) => void;
}

/** Run an exchange tool (native transports included) in-process against a local document. */
export async function runLocalExchange(name: string, params: unknown, context: LocalExchangeContext): Promise<CommandOutcome> {
  const outcome = await runExchangeTool(name, params, context.options, {
    getDoc: context.getDoc,
    applyCommand: context.runCommand,
    ...(context.onProgress !== undefined ? { onProgress: context.onProgress } : {}),
  });
  if (outcome === null) throw new Error(`${name} is not an exchange tool.`);
  return outcome;
}
