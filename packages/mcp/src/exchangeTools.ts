/**
 * @layer mcp
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
 *
 * Their schemas are hand-written because they are transport-level tools, not registry commands;
 * the registry commands they call keep `toToolSchemas()` as their contract (L5).
 */

import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';
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
      // Not read-only: it may write <name>.step into the exchange directory.
      annotations: { idempotentHint: true },
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

function failure(message: string): McpShapedResult {
  return shapeToolCallContent({ summary: message, affected: [], isError: true });
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A tool's `language` argument (default cadquery), or null when it names another library. */
function pythonLanguage(raw: unknown): PythonLanguage | null {
  const value = raw ?? 'cadquery';
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

interface StepFile {
  readonly stepBase64: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly summary: string;
  readonly savedTo?: string;
}

/**
 * Generate the model's STEP file: export_code → Python port → exact B-rep. Shared by the
 * export_step tool and the server's GET /export/step route.
 * @failure no solids / bad language / bridge error → { error } (port errors propagate as throws)
 */
export async function exportStepFile(
  getDoc: () => CadDocument,
  port: CadExchangePort,
  options: { name?: string; language?: unknown; save?: boolean },
): Promise<StepFile | { error: string }> {
  const language = pythonLanguage(options.language);
  if (language === null) {
    return { error: 'export_step: language must be "cadquery" or "build123d".' };
  }
  const code = execute(getDoc(), 'export_code', { language, name: options.name ?? 'model' });
  const codeData = code.data as
    | { text: string; fileName: string; solidCount: number; source: string }
    | undefined;
  if (codeData === undefined) return { error: `export_step: ${code.summary}` };
  if (codeData.solidCount === 0)
    return { error: 'export_step: the model has no 3D solids to export.' };

  const run = await port.runProgram({ language, source: codeData.text, step: true });
  if (run.stepBase64 === undefined) {
    return { error: 'export_step: the Python bridge returned no STEP data.' };
  }
  // export_code already sanitised the base name; only the extension changes.
  const fileName = codeData.fileName.replace(/\.[^.]+$/, '.step');
  const savedTo =
    options.save !== false && port.writeExchangeFile !== undefined
      ? await port.writeExchangeFile(fileName, run.stepBase64)
      : undefined;
  const bytes = Math.floor((run.stepBase64.length * 3) / 4);
  const summary =
    `export_step: ${codeData.solidCount} solid(s) from ${codeData.source} → ${fileName} ` +
    `(${bytes} bytes, exact B-rep via ${language})` +
    (savedTo !== undefined ? `; saved to ${savedTo}.` : '; returned as data.stepBase64.');
  return {
    stepBase64: run.stepBase64,
    fileName,
    bytes,
    summary,
    ...(savedTo !== undefined ? { savedTo } : {}),
  };
}

async function exportStep(
  deps: ExchangeDeps,
  port: CadExchangePort,
  args: Record<string, unknown>,
): Promise<McpShapedResult> {
  const name = stringArg(args, 'name');
  const file = await exportStepFile(deps.getDoc, port, {
    language: args.language,
    save: args.save !== false,
    ...(name !== undefined ? { name } : {}),
  });
  if ('error' in file) return failure(file.error);
  const { stepBase64, summary, ...meta } = file;
  const data = { format: 'step', language: pythonLanguage(args.language), ...meta };
  // The base64 payload travels only in structuredContent, never in the text an agent reads.
  const shaped = shapeToolCallContent({ summary, affected: [], isError: false, data });
  return { ...shaped, structuredContent: { ...data, stepBase64 } };
}

/** An import tool's outcome: a command that created nothing counts as a failure. */
function importOutcome(summary: string, result: ExchangeCommandResult): McpShapedResult {
  return shapeToolCallContent({
    summary,
    affected: result.affected,
    isError: result.isError || result.affected.length === 0,
  });
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
  return importOutcome(`import_step: ${result.summary}`, result);
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
  const language = pythonLanguage(args.language);
  if (language === null) return failure('import_code: language must be "cadquery" or "build123d".');
  const mode = args.mode === 'append' ? 'append' : 'replace';
  const source = await readInput(port, stringArg(args, 'code'), stringArg(args, 'path'), 'utf8');
  const run = await port.runProgram({ language, source, step: false });
  const result = deps.applyCommand('apply_code_trace', { trace: run.trace, mode });
  const kind = run.traced
    ? 'parametric (feature history + parameters rebuilt)'
    : 'non-llull script: result shapes imported as meshes (wrap shapes with the llull runtime to keep them editable)';
  const log = run.log.trim() !== '' ? ` Script output: ${run.log.trim().slice(-2000)}` : '';
  return importOutcome(`import_code (${language}, ${kind}): ${result.summary}${log}`, result);
}

const EXCHANGE_HANDLERS = new Map([
  ['export_step', exportStep],
  ['import_step', importStep],
  ['import_code', importCode],
]);

/**
 * Dispatch an exchange tool call; returns null for any other tool name.
 * @layer mcp
 * @failure missing Python, disabled execution, script/bridge errors → isError result, document unchanged
 */
export async function applyExchangeToolCall(
  toolName: string,
  rawArgs: unknown,
  deps: ExchangeDeps,
): Promise<McpShapedResult | null> {
  const handler = EXCHANGE_HANDLERS.get(toolName);
  if (handler === undefined) return null;
  if (deps.port === null) return failure(`${toolName} ${NO_PYTHON}`);
  try {
    return await handler(deps, deps.port, isRecord(rawArgs) ? rawArgs : {});
  } catch (error) {
    return failure(`${toolName} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
