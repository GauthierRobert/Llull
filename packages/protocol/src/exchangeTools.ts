/**
 * CAD exchange tools (transport-level, hand-written schemas): Python I/O behind the injected `CadExchangePort`
 * (server/); every document change still goes through registry commands via the injected `applyCommand`.
 *   export_step  doc → export_code (CadQuery) → port runs it → exact B-rep STEP
 *   import_step  STEP → port tessellates (names + colours kept) → import_mesh
 *   import_dwg   DWG → DwgConverterPort (LibreDWG / ODA) → ASCII DXF → import_dxf | import_survey_dxf
 *   import_code  CadQuery/build123d source → port runs it → LLULL_TRACE → apply_code_trace
 */
import type { CadDocument } from '@core/model/types';
import type { PythonBackend } from '@core/codegen/pythonRuntime';
import { execute } from '@core/commands/registry';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { nonEmptyString } from '@lib/nonEmptyString';
import { safeFileName } from '@lib/safeFileName';
import type { ToolDefinition } from './tools';
import { applyFeaToolCall, type FeaToolsPort } from './feaTools';
import { applyLibraryToolCall, type MaterialLibraryStorePort } from './libraryTools';
import { shapeToolCallContent, type ShapedToolResult } from './toolResult';
import type { CommandOutcome } from './restProtocol';

export interface ProgramRun {
  readonly trace: unknown; // LLULL_TRACE (llull runtime) or an import_mesh trace
  readonly traced: boolean; // used the llull runtime (parametric); false = tessellated fallback
  readonly stepBase64?: string;
  readonly log: string; // script stdout (truncated)
}

/** Port to the Python exchange process. Implementations throw Error with an agent-readable message. */
export interface CadExchangePort {
  runProgram(request: { language: PythonBackend; source: string; step: boolean }): Promise<ProgramRun>;
  importStep(stepBase64: string): Promise<{ bodies: unknown[] }>;
  readExchangeFile?(path: string, encoding: 'base64' | 'utf8'): Promise<string>; // inside the exchange directory
  /** Returns the absolute path written. */
  writeExchangeFile?(fileName: string, base64: string): Promise<string>;
}

/** Port to a DWG → ASCII DXF converter (implemented in `server/`). Throws Error with an agent-readable message. */
export interface DwgConverterPort {
  convertDwg(dwgBase64: string): Promise<string>;
  readExchangeFile?(path: string): Promise<string>;
}

export type ExchangeCommandResult = Omit<CommandOutcome, 'changed'>;

/** null ports: the tools explain how to enable them. */
export interface ExchangeDeps {
  readonly port: CadExchangePort | null;
  readonly dwg?: DwgConverterPort | null;
  readonly fea?: FeaToolsPort | null; // fea_mesh / fea_solve / fea_export transports
  readonly libraries?: MaterialLibraryStorePort | null; // register_material_library
  readonly getDoc: () => CadDocument;
  readonly applyCommand: (name: string, params: unknown) => ExchangeCommandResult; // the command bus (undo + broadcast)
  readonly allowCodeExecution: boolean; // import_code runs arbitrary Python
}

const LANGUAGE_SCHEMA = {
  type: 'string' as const,
  description: 'Python CAD library the code targets: "cadquery" (default) or "build123d".',
  enum: ['cadquery', 'build123d'],
};

export function buildExchangeToolDefinitions(): ToolDefinition[] {
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
            description: 'Also write <name>.step into the server exchange directory (default true when configured).',
          },
          confirmExportControlled: {
            type: 'boolean',
            description:
              'Documents that use ITAR / EAR material records are refused (MAT_EXPORT_CONTROLLED). Only a human signature in the desktop app lifts this; an agent passing true gets MAT_HUMAN_GATE.',
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
      name: 'import_dwg',
      description:
        'Import an AutoCAD DWG file: the server converts it to ASCII DXF (LibreDWG dwg2dxf or the ODA File ' +
        'Converter) and runs import_dxf (target "drawing": editable 2D entities on their layers) or ' +
        'import_survey_dxf (target "survey": a terrain point group). Pass dwgBase64, or path relative to the ' +
        'server exchange directory. Needs a DWG converter installed on the server.',
      inputSchema: {
        type: 'object',
        properties: {
          dwgBase64: { type: 'string', description: 'The DWG file content, base64-encoded.' },
          path: { type: 'string', description: 'File path inside the server exchange directory.' },
          target: {
            type: 'string',
            description: '"drawing" (default; import_dxf) or "survey" (import_survey_dxf).',
            enum: ['drawing', 'survey'],
          },
          sourceUnit: { type: 'string', description: 'Drawing unit when $INSUNITS is missing or wrong (e.g. "m", "mm", "ft").' },
          layers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only import these layers (case-insensitive). Default: every layer.',
          },
          name: { type: 'string', description: 'Survey point group name (target "survey").' },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Survey: what becomes a point (points, vertices, faces, text).',
          },
          keepZeroElevation: { type: 'boolean', description: 'Survey: keep points at z = 0. Default false.' },
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
          path: { type: 'string', description: 'Script path inside the server exchange directory.' },
          language: LANGUAGE_SCHEMA,
          mode: { type: 'string', description: '"replace" (default) or "append".', enum: ['replace', 'append'] },
        },
        required: [],
      },
      annotations: { destructiveHint: true },
    },
  ];
}

const failure = (message: string): ShapedToolResult => shapeToolCallContent({ summary: message, affected: [], isError: true });

/** `language` (default cadquery), or null for another library. */
function pythonLanguage(raw: unknown): PythonBackend | null {
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
  if (path === undefined) throw new Error(`provide ${encoding === 'base64' ? 'stepBase64' : 'code'} or path`);
  if (port.readExchangeFile === undefined)
    throw new Error('path is unavailable: the server has no exchange directory (LLULL_EXCHANGE_DIR)');
  return port.readExchangeFile(path, encoding);
}

interface StepFile {
  readonly stepBase64: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly summary: string;
  readonly savedTo?: string;
}

const NO_STEP_BACKEND = 'STEP export needs the Python bridge (LLULL_PYTHON is off) or the exact OCC kernel (LLULL_KERNEL=occt-native).';

/** Without the Python bridge the exact kernel writes the STEP (`export_step_ap242`). */
function exportStepExact(getDoc: () => CadDocument, name?: string, confirmation?: unknown): StepFile | { error: string } {
  const simple = { schema: 'ap214', includeValidationProperties: false };
  const exact = execute(
    getDoc(),
    'export_step_ap242',
    confirmation === undefined ? simple : { ...simple, confirmExportControlled: confirmation },
  );
  const data = exact.data as { step?: string; solidCount?: number } | undefined;
  if (data?.step === undefined) return { error: `${NO_STEP_BACKEND} Kernel export: ${exact.summary}` };
  const fileName = `${safeFileName(name, 'model')}.step`;
  const bytes = data.step.length;
  return {
    stepBase64: btoa(data.step),
    fileName,
    bytes,
    summary:
      `export_step: ${data.solidCount ?? 0} solid(s) → ${fileName} ` +
      `(${bytes} bytes, exact B-rep via the OCC kernel); returned as data.stepBase64.`,
  };
}

/** The last non-empty line of an error message (a Python traceback ends with the raised error). */
function lastLine(message: string): string {
  return (
    message
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .pop()
      ?.trim() ?? ''
  );
}

/**
 * The model's STEP: export_code → Python port → exact B-rep (export_step tool + GET /export/step).
 * @failure no solids / bad language / bridge error → { error } (port errors propagate as throws)
 */
export async function exportStepFile(
  getDoc: () => CadDocument,
  port: CadExchangePort | null,
  options: { name?: string; language?: unknown; save?: boolean; confirmExportControlled?: unknown },
): Promise<StepFile | { error: string }> {
  if (port === null) return exportStepExact(getDoc, options.name, options.confirmExportControlled);
  const language = pythonLanguage(options.language);
  if (language === null) return { error: 'export_step: language must be "cadquery" or "build123d".' };
  const code = execute(getDoc(), 'export_code', {
    language,
    name: options.name ?? 'model',
    ...(options.confirmExportControlled !== undefined ? { confirmExportControlled: options.confirmExportControlled } : {}),
  });
  const codeData = code.data as { text: string; fileName: string; solidCount: number; source: string } | undefined;
  if (codeData === undefined) return { error: `export_step: ${code.summary}` };
  if (codeData.solidCount === 0) return { error: 'export_step: the model has no 3D solids to export.' };
  let run: Awaited<ReturnType<CadExchangePort['runProgram']>>;
  try {
    run = await port.runProgram({ language, source: codeData.text, step: true });
  } catch (error) {
    // a sweep / loft the code could not build (the script's last line is "ValueError: SWG_CODEGEN_UNSUPPORTED: ..."): the native kernel still has its exact faces
    const failure = lastLine(error instanceof Error ? error.message : String(error));
    if (!/(^|\s)ValueError: SWG_CODEGEN_UNSUPPORTED: /.test(failure)) throw error;
    const exact = exportStepExact(getDoc, options.name, options.confirmExportControlled);
    if ('error' in exact) return { error: `${exact.error} (the ${language} code failed first: ${failure})` };
    const savedTo =
      options.save !== false && port.writeExchangeFile !== undefined
        ? await port.writeExchangeFile(exact.fileName, exact.stepBase64)
        : undefined;
    const cause = `The ${language} code could not build a sweep or loft (SWG_CODEGEN_UNSUPPORTED), so the exact OCC kernel wrote this STEP`;
    // like the normal path: a saved file is not also "returned as data.stepBase64"
    const summary =
      savedTo === undefined
        ? `${exact.summary} ${cause}.`
        : `${exact.summary.replace('; returned as data.stepBase64.', '.')} ${cause}; saved to ${savedTo}.`;
    return { ...exact, summary, ...(savedTo !== undefined ? { savedTo } : {}) };
  }
  if (run.stepBase64 === undefined) return { error: 'export_step: the Python bridge returned no STEP data.' };
  // export_code already sanitised the base name; only the extension changes.
  const fileName = codeData.fileName.replace(/\.[^.]+$/, '.step');
  const savedTo =
    options.save !== false && port.writeExchangeFile !== undefined ? await port.writeExchangeFile(fileName, run.stepBase64) : undefined;
  const bytes = Math.floor((run.stepBase64.length * 3) / 4);
  const summary =
    `export_step: ${codeData.solidCount} solid(s) from ${codeData.source} → ${fileName} ` +
    `(${bytes} bytes, exact B-rep via ${language})` +
    (savedTo !== undefined ? `; saved to ${savedTo}.` : '; returned as data.stepBase64.');
  return { stepBase64: run.stepBase64, fileName, bytes, summary, ...(savedTo !== undefined ? { savedTo } : {}) };
}

async function exportStep(deps: ExchangeDeps, port: CadExchangePort | null, args: Record<string, unknown>): Promise<ShapedToolResult> {
  const name = nonEmptyString(args['name']);
  const file = await exportStepFile(deps.getDoc, port, {
    language: args.language,
    save: args.save !== false,
    ...(args['confirmExportControlled'] !== undefined ? { confirmExportControlled: args['confirmExportControlled'] } : {}),
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
function importOutcome(summary: string, result: ExchangeCommandResult): ShapedToolResult {
  return shapeToolCallContent({ summary, affected: result.affected, isError: result.isError || result.affected.length === 0 });
}

async function importStep(deps: ExchangeDeps, port: CadExchangePort, args: Record<string, unknown>): Promise<ShapedToolResult> {
  const stepBase64 = await readInput(port, nonEmptyString(args['stepBase64']), nonEmptyString(args['path']), 'base64');
  const { bodies } = await port.importStep(stepBase64);
  const result = deps.applyCommand('import_mesh', { bodies });
  return importOutcome(`import_step: ${result.summary}`, result);
}

const DWG_COMMAND_PARAMS = {
  drawing: ['sourceUnit', 'layers'],
  survey: ['name', 'layers', 'sources', 'sourceUnit', 'keepZeroElevation'],
} as const;

const NO_DWG =
  'requires a DWG converter on the server host: install LibreDWG (`apt install libredwg-tools`) or the ' +
  'ODA File Converter (LLULL_ODA_CONVERTER=<executable>) and leave LLULL_DWG2DXF unset/not "off" ' +
  '(see docs/CAD_EXCHANGE.md). Alternatively save the drawing as ASCII DXF and use import_dxf.';

async function importDwg(deps: ExchangeDeps, dwg: DwgConverterPort, args: Record<string, unknown>): Promise<ShapedToolResult> {
  const target = args.target ?? 'drawing';
  if (target !== 'drawing' && target !== 'survey') return failure('import_dwg: target must be "drawing" or "survey"; nothing was changed.');
  let dwgBase64 = nonEmptyString(args['dwgBase64']);
  if (dwgBase64 === undefined) {
    const file = nonEmptyString(args['path']);
    if (file === undefined) return failure('import_dwg: provide dwgBase64 or path.');
    if (dwg.readExchangeFile === undefined) {
      return failure('import_dwg: path is unavailable: the server has no exchange directory (LLULL_EXCHANGE_DIR).');
    }
    dwgBase64 = await dwg.readExchangeFile(file);
  }
  const text = await dwg.convertDwg(dwgBase64);
  const params: Record<string, unknown> = { text };
  for (const key of DWG_COMMAND_PARAMS[target]) if (args[key] !== undefined) params[key] = args[key];
  const command = target === 'survey' ? 'import_survey_dxf' : 'import_dxf';
  const result = deps.applyCommand(command, params);
  return importOutcome(`import_dwg (${command}): ${result.summary}`, result);
}

async function importCode(deps: ExchangeDeps, port: CadExchangePort, args: Record<string, unknown>): Promise<ShapedToolResult> {
  if (!deps.allowCodeExecution) {
    return failure(
      'import_code: running Python is disabled on this server. Start it with LLULL_ALLOW_CODE_EXECUTION=1 ' +
        '(only on a machine you trust — the script runs with backend privileges).',
    );
  }
  const language = pythonLanguage(args.language);
  if (language === null) return failure('import_code: language must be "cadquery" or "build123d".');
  if (args.mode !== undefined && args.mode !== 'replace' && args.mode !== 'append') {
    return failure(`import_code: mode must be "replace" or "append" (got ${JSON.stringify(args.mode)}); nothing was changed.`);
  }
  const mode = args.mode === 'append' ? 'append' : 'replace';
  const source = await readInput(port, nonEmptyString(args['code']), nonEmptyString(args['path']), 'utf8');
  const run = await port.runProgram({ language, source, step: false });
  const result = deps.applyCommand('apply_code_trace', { trace: run.trace, mode });
  const kind = run.traced
    ? 'parametric (feature history + parameters rebuilt)'
    : 'non-llull script: result shapes imported as meshes (wrap shapes with the llull runtime to keep them editable)';
  const log = run.log.trim() !== '' ? ` Script output: ${run.log.trim().slice(-2000)}` : '';
  return importOutcome(`import_code (${language}, ${kind}): ${result.summary}${log}`, result);
}

const EXCHANGE_HANDLERS = new Map([
  ['import_step', importStep],
  ['import_code', importCode],
]);

/**
 * Dispatch an exchange tool call; returns null for any other tool name.
 * @failure missing Python, disabled execution, script/bridge errors → isError result, document unchanged
 */
export async function applyExchangeToolCall(toolName: string, rawArgs: unknown, deps: ExchangeDeps): Promise<ShapedToolResult | null> {
  const fea = await applyFeaToolCall(toolName, rawArgs, deps);
  if (fea !== null) return fea;
  const library = applyLibraryToolCall(toolName, rawArgs, deps);
  if (library !== null) return library;
  if (toolName === 'import_dwg') {
    if (deps.dwg === undefined || deps.dwg === null) return failure(`import_dwg ${NO_DWG}`);
    try {
      return await importDwg(deps, deps.dwg, isRecord(rawArgs) ? rawArgs : {});
    } catch (error) {
      return failure(`import_dwg failed: ${errorMessage(error)}`);
    }
  }
  const args = isRecord(rawArgs) ? rawArgs : {};
  const handler = EXCHANGE_HANDLERS.get(toolName);
  if (handler === undefined && toolName !== 'export_step') return null;
  if (deps.port === null && handler !== undefined) return failure(`${toolName} ${NO_PYTHON}`);
  try {
    return handler === undefined || deps.port === null ? await exportStep(deps, deps.port, args) : await handler(deps, deps.port, args);
  } catch (error) {
    return failure(`${toolName} failed: ${errorMessage(error)}`);
  }
}
