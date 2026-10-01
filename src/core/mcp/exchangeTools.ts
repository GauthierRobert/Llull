/**
 * @layer core/mcp
 *
 * CAD exchange tools — STEP import/export and parametric-code import over MCP.
 *
 * These need a Python geometry kernel (CadQuery / build123d via OpenCascade), so they are not pure
 * registry commands: the I/O lives behind the injected `CadExchangePort` (implemented in `server/`),
 * and every document change still goes through registry commands (`import_mesh`,
 * `apply_code_trace`) via the injected `applyCommand` — the PRIME DIRECTIVE holds.
 *
 *   export_step  doc → export_code (CadQuery) → port runs it → exact B-rep STEP
 *   import_step  STEP → port tessellates (names + colours kept) → import_mesh
 *   import_code  CadQuery/build123d source → port runs it → LLULL_TRACE → apply_code_trace
 */

import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { McpToolDefinition } from './tools';
import { shapeToolCallContent, type McpShapedResult } from './dispatch';

export type PythonLanguage = 'cadquery' | 'build123d';

export interface ProgramRun {
  /** LLULL_TRACE of a llull-runtime script, or an import_mesh trace for any other script. */
  readonly trace: unknown;
  /** true when the script used the llull runtime (parametric); false = tessellated fallback. */
  readonly traced: boolean;
  readonly stepBase64?: string;
  /** Captured script stdout (truncated). */
  readonly log: string;
}

/** Port to the Python exchange process. Implementations throw Error with an agent-readable message. */
export interface CadExchangePort {
  runProgram(request: {
    language: PythonLanguage;
    source: string;
    step: boolean;
  }): Promise<ProgramRun>;
  importStep(stepBase64: string): Promise<{ bodies: unknown[] }>;
  /** Read a file from the configured exchange directory as base64 (or text when `encoding` is utf8). */
  readExchangeFile?(path: string, encoding: 'base64' | 'utf8'): Promise<string>;
  /** Write base64 bytes into the exchange directory; returns the absolute path written. */
  writeExchangeFile?(fileName: string, base64: string): Promise<string>;
}

export interface ExchangeCommandResult {
  summary: string;
  affected: string[];
  isError: boolean;
  data?: unknown;
}

export interface ExchangeDeps {
  /** null when Python/CadQuery is not configured; tools then explain how to enable it. */
  readonly port: CadExchangePort | null;
  readonly getDoc: () => CadDocument;
  /** The server command bus (records undo + broadcasts). */
  readonly applyCommand: (name: string, params: unknown) => ExchangeCommandResult;
  /** import_code executes arbitrary Python; it is refused unless the host opted in. */
  readonly allowCodeExecution: boolean;
}

const LANGUAGE_SCHEMA = {
  type: 'string' as const,
  description: 'Python CAD library the code targets: "cadquery" (default) or "build123d".',
  enum: ['cadquery', 'build123d'],
};

export function buildExchangeToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: 'export_step',
      description:
        'Export the model as a STEP (AP214) file with exact B-rep geometry: the feature history is turned ' +
        'into CadQuery/build123d code (export_code) and evaluated by OpenCascade, so booleans and curved ' +
        'faces are exact and every solid keeps its name and colour. Returns data.stepBase64 and, when the ' +
        'server has an exchange directory, writes the file there. Needs the server Python bridge.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'File name without extension (default "model").' },
          language: LANGUAGE_SCHEMA,
          save: {
            type: 'boolean',
            description:
              'Also write <name>.step into the server exchange directory (default true when configured).',
          },
        },
        required: [],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    {
      name: 'import_step',
      description:
        'Import a STEP (.step/.stp) file: every solid becomes a mesh entity carrying the STEP name and colour ' +
        '(added to the current model; undoable). Pass stepBase64, or path relative to the server exchange ' +
        'directory. Imported solids are not parametric — to get an editable model, rebuild it with commands ' +
        'or import_code. Needs the server Python bridge.',
      inputSchema: {
        type: 'object',
        properties: {
          stepBase64: { type: 'string', description: 'The STEP file content, base64-encoded.' },
          path: { type: 'string', description: 'File path inside the server exchange directory.' },
        },
        required: [],
      },
    },
    {
      name: 'import_code',
      description:
        'Rebuild the model from CadQuery or build123d source. Code produced by export_code (or any script using ' +
        'its param()/box()/cut()/... runtime) is re-created as an editable llull feature history: parameters, ' +
        'expressions and feature order are kept, so set_parameter + replay_history regenerate it. Any other ' +
        'script is evaluated and its `result` / show_object() shapes are imported as meshes. mode "replace" ' +
        '(default) swaps the model; "append" adds to it. Executes Python: the server must enable it.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python source text.' },
          path: {
            type: 'string',
            description: 'Script path inside the server exchange directory.',
          },
          language: LANGUAGE_SCHEMA,
          mode: {
            type: 'string',
            description: '"replace" (default) or "append".',
            enum: ['replace', 'append'],
          },
        },
        required: [],
      },
      annotations: { destructiveHint: true },
    },
  ];
}

const EXCHANGE_TOOLS = new Set(['export_step', 'import_step', 'import_code']);

function failure(message: string): McpShapedResult {
  return shapeToolCallContent({ summary: message, affected: [], isError: true });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function languageArg(args: Record<string, unknown>): PythonLanguage | null {
  const value = args.language ?? 'cadquery';
  return value === 'cadquery' || value === 'build123d' ? value : null;
}

const NO_PYTHON =
  'requires the llull Python bridge. Install CadQuery (`pip install cadquery`) on the server host and ' +
  'start the server with LLULL_PYTHON=<python executable> (see docs/CAD_EXCHANGE.md).';

/** Read `inline` or the exchange-directory file named by `path`. */
async function readInput(
  port: CadExchangePort,
  inline: string | undefined,
  path: string | undefined,
  encoding: 'base64' | 'utf8',
): Promise<string> {
  if (inline !== undefined) return inline;
  if (path === undefined)
    throw new Error(`provide ${encoding === 'base64' ? 'stepBase64' : 'code'} or path`);
  if (port.readExchangeFile === undefined) {
    throw new Error(
      'path is unavailable: the server has no exchange directory (LLULL_EXCHANGE_DIR)',
    );
  }
  return port.readExchangeFile(path, encoding);
}

async function exportStep(
  deps: ExchangeDeps,
  port: CadExchangePort,
  args: Record<string, unknown>,
): Promise<McpShapedResult> {
  const language = languageArg(args);
  if (language === null) return failure('export_step: language must be "cadquery" or "build123d".');
  const name = stringArg(args, 'name') ?? 'model';
  const code = execute(deps.getDoc(), 'export_code', { language, name });
  const codeData = code.data as { text?: string; solidCount?: number; source?: string } | undefined;
  if (codeData?.text === undefined) return failure(`export_step: ${code.summary}`);
  if (codeData.solidCount === 0)
    return failure('export_step: the model has no 3D solids to export.');

  const run = await port.runProgram({ language, source: codeData.text, step: true });
  if (run.stepBase64 === undefined)
    return failure('export_step: the Python bridge returned no STEP data.');
  const fileName = `${name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'model'}.step`;
  let savedTo: string | undefined;
  if (args.save !== false && port.writeExchangeFile !== undefined) {
    savedTo = await port.writeExchangeFile(fileName, run.stepBase64);
  }
  const bytes = Math.floor((run.stepBase64.length * 3) / 4);
  const summary =
    `export_step: ${codeData.solidCount ?? 0} solid(s) from ${codeData.source ?? 'history'} → ${fileName} ` +
    `(${bytes} bytes, exact B-rep via ${language})` +
    (savedTo !== undefined ? `; saved to ${savedTo}.` : '; returned as data.stepBase64.');
  const meta = {
    format: 'step',
    fileName,
    bytes,
    language,
    ...(savedTo !== undefined ? { savedTo } : {}),
  };
  const shaped = shapeToolCallContent({ summary, affected: [], isError: false, data: meta });
  return { ...shaped, structuredContent: { ...meta, stepBase64: run.stepBase64 } };
}

async function importStep(
  deps: ExchangeDeps,
  port: CadExchangePort,
  args: Record<string, unknown>,
): Promise<McpShapedResult> {
  const stepBase64 = await readInput(
    port,
    stringArg(args, 'stepBase64'),
    stringArg(args, 'path'),
    'base64',
  );
  const { bodies } = await port.importStep(stepBase64);
  const result = deps.applyCommand('import_mesh', { bodies });
  return shapeToolCallContent({
    summary: `import_step: ${result.summary}`,
    affected: result.affected,
    isError: result.isError || result.affected.length === 0,
  });
}

async function importCode(
  deps: ExchangeDeps,
  port: CadExchangePort,
  args: Record<string, unknown>,
): Promise<McpShapedResult> {
  if (!deps.allowCodeExecution) {
    return failure(
      'import_code: running Python is disabled on this server. Start it with LLULL_ALLOW_CODE_EXECUTION=1 ' +
        '(only on a machine you trust the MCP clients of — the script runs with server privileges).',
    );
  }
  const language = languageArg(args);
  if (language === null) return failure('import_code: language must be "cadquery" or "build123d".');
  const mode = args.mode === 'append' ? 'append' : 'replace';
  const source = await readInput(port, stringArg(args, 'code'), stringArg(args, 'path'), 'utf8');
  const run = await port.runProgram({ language, source, step: false });
  const result = deps.applyCommand('apply_code_trace', { trace: run.trace, mode });
  const kind = run.traced
    ? 'parametric (feature history + parameters rebuilt)'
    : 'non-llull script: result shapes imported as meshes (wrap shapes with the llull runtime to keep them editable)';
  const log = run.log.trim() !== '' ? ` Script output: ${run.log.trim().slice(-2000)}` : '';
  return shapeToolCallContent({
    summary: `import_code (${language}, ${kind}): ${result.summary}${log}`,
    affected: result.affected,
    isError: result.isError || result.affected.length === 0,
  });
}

/**
 * Dispatch an exchange tool call; returns null for any other tool name.
 * @layer core/mcp
 * @failure missing Python, disabled execution, script/bridge errors → isError result, document unchanged
 */
export async function applyExchangeToolCall(
  toolName: string,
  rawArgs: unknown,
  deps: ExchangeDeps,
): Promise<McpShapedResult | null> {
  if (!EXCHANGE_TOOLS.has(toolName)) return null;
  if (deps.port === null) return failure(`${toolName} ${NO_PYTHON}`);
  const args =
    rawArgs !== null && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
  try {
    if (toolName === 'export_step') return await exportStep(deps, deps.port, args);
    if (toolName === 'import_step') return await importStep(deps, deps.port, args);
    return await importCode(deps, deps.port, args);
  } catch (error) {
    return failure(`${toolName} failed: ${errorText(error)}`);
  }
}
