/**
 * FE pipeline tools (transport-level, hand-written schemas like the exchange tools): meshing (Gmsh) and solving (CalculiX) run on
 * the host behind the injected `FeaToolsPort` (server/); every document change still goes through registry commands
 * (`record_fe_mesh` / `record_fea_results`) via the injected `applyCommand`.
 *   fea_mesh    analysed solids -> tet mesh artifact -> record_fe_mesh
 *   fea_solve   mesh artifact -> input deck -> CalculiX -> results artifact -> record_fea_results
 *   fea_export  the CalculiX input deck (text + sha256), nothing run
 *   fea_import_field  a CSV `x,y,z,T` -> table artifact -> set_temperature_field (PHY-04 TR-TMC-14)
 */
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { nonEmptyString } from '@lib/nonEmptyString';
import type { CadDocument } from '@core/model/types';
import type { ToolDefinition } from './tools';
import { shapeToolCallContent, type ShapedToolResult } from './toolResult';
import type { CommandOutcome } from './restProtocol';

export type FeaToolResult = Omit<CommandOutcome, 'changed'>;

/** The host document and the command bus the transports record their results through. */
export interface FeaHost {
  readonly getDoc: () => CadDocument;
  readonly applyCommand: (name: string, params: unknown) => FeaToolResult;
}

/** A temperature table as the agent gave it: CSV text and the units it declares. */
export interface FieldTableInput {
  readonly csv: string;
  readonly coordinatesUnit: string;
  readonly temperatureUnit: string;
}

/** Port to the FE transports (implemented in `server/`). Failures are results (`isError`, summary starts `<tool> <CODE>`), not throws. */
export interface FeaToolsPort {
  mesh(analysisId: string, host: FeaHost): Promise<FeaToolResult>;
  solve(analysisId: string, options: { readonly timeoutS?: number }, host: FeaHost): Promise<FeaToolResult>;
  exportDeck(analysisId: string, host: FeaHost): Promise<FeaToolResult>;
  importField(analysisId: string, table: FieldTableInput, host: FeaHost): Promise<FeaToolResult>;
}

/** Bounds of the solver wall-clock limit (seconds): schema `minimum` / `maximum`, enforced again by the transport. */
export const FEA_SOLVE_TIMEOUT_S = { min: 1, max: 86400 } as const;

const ANALYSIS_ID = { type: 'string' as const, description: 'Id of the analysis case (create_analysis).' };

const FEA_TOOL_NAMES = ['fea_mesh', 'fea_solve', 'fea_export', 'fea_import_field'] as const;

export function buildFeaToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'fea_mesh',
      description:
        'Mesh the solid parts of a finite-element analysis (Gmsh tetrahedra, set_mesh_controls): the parts are exported from the geometry ' +
        'kernel (exact STEP with the OCC kernel, else a faceted STL), the constraint / load / refinement points are resolved to the ' +
        'nearest faces and nodes, and the mesh is stored as a content-addressed artifact and recorded with record_fe_mesh. ' +
        'Run it after the set-up commands and before fea_solve; any set-up change makes the mesh stale. Needs Python with gmsh on the server.',
      inputSchema: { type: 'object', properties: { analysisId: ANALYSIS_ID }, required: ['analysisId'] },
      annotations: { idempotentHint: true },
    },
    {
      name: 'fea_solve',
      description:
        'Solve a meshed analysis with CalculiX (ccx): writes the input deck from the document, runs the solver, reads the results into ' +
        'a content-addressed artifact and records their summary with record_fea_results (then use fea_report / check_analysis / ' +
        'thermal_report). Refuses a missing or stale mesh (run fea_mesh). Needs ccx on the server (LLULL_CCX).',
      inputSchema: {
        type: 'object',
        properties: {
          analysisId: ANALYSIS_ID,
          timeoutS: {
            type: 'number',
            minimum: FEA_SOLVE_TIMEOUT_S.min,
            maximum: FEA_SOLVE_TIMEOUT_S.max,
            description: `Solver wall-clock limit in seconds, ${FEA_SOLVE_TIMEOUT_S.min} to ${FEA_SOLVE_TIMEOUT_S.max} (default 600); values outside are clamped.`,
          },
        },
        required: ['analysisId'],
      },
      annotations: { idempotentHint: true },
    },
    {
      name: 'fea_export',
      description:
        'Write the CalculiX input deck (.inp) of a meshed analysis without running the solver. Returns data.text (the deck), ' +
        'data.sha256 and data.fileName; with the llull CLI use --save <path> to write it. Refuses a missing or stale mesh.',
      inputSchema: { type: 'object', properties: { analysisId: ANALYSIS_ID }, required: ['analysisId'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'fea_import_field',
      description:
        'Import a temperature table for a thermo_static analysis: CSV lines "x,y,z,T" (optional header x,y,z,T; # comments) with the ' +
        'units you DECLARE (coordinatesUnit mm | m | in ...; temperatureUnit degC | K | degF). The table is stored as a content-addressed ' +
        'artifact and the analysis field is set to it (set_temperature_field kind table). At deck time every mesh node must have a row ' +
        'within 1e-6 of the model size, else the solve is refused with TMC_FIELD_TABLE_UNMATCHED (nearest-node match, no interpolation). ' +
        'Give the CSV inline (csv) or as a file in the server exchange directory (path); the llull CLI reads a local file with file=<path>. ' +
        'Run it after fea_mesh when the rows should follow the mesh nodes (the node coordinates are in the mesh artifact). Next: check_thermo_mechanical.',
      inputSchema: {
        type: 'object',
        properties: {
          analysisId: { ...ANALYSIS_ID, description: 'Id of a thermo_static analysis (create_analysis).' },
          csv: { type: 'string', description: 'CSV text, one "x,y,z,T" row per line.' },
          path: { type: 'string', description: 'CSV file inside the server exchange directory (alternative to csv).' },
          coordinatesUnit: { type: 'string', description: 'Length unit of the x, y, z columns, e.g. "mm". Required, no default.' },
          temperatureUnit: { type: 'string', enum: ['degC', 'K', 'degF'], description: 'Unit of the T column. Required, no default.' },
        },
        required: ['analysisId', 'coordinatesUnit', 'temperatureUnit'],
      },
      annotations: { idempotentHint: true },
    },
  ];
}

const failure = (message: string): ShapedToolResult => shapeToolCallContent({ summary: message, affected: [], isError: true });

/** What `applyFeaToolCall` needs: the port (null = not configured) + the host. */
interface FeaDeps extends FeaHost {
  readonly fea?: FeaToolsPort | null;
  /** Exchange-directory reader for `path` (the same port the STEP / code imports use). */
  readonly port?: { readonly readExchangeFile?: (path: string, encoding: 'base64' | 'utf8') => Promise<string> } | null;
}

/** The CSV of a fea_import_field call: inline `csv`, else the exchange-directory file `path`. */
async function tableInput(args: Record<string, unknown>, deps: FeaDeps): Promise<FieldTableInput | string> {
  const { coordinatesUnit, temperatureUnit } = args;
  if (typeof coordinatesUnit !== 'string' || coordinatesUnit === '' || typeof temperatureUnit !== 'string' || temperatureUnit === '')
    return 'coordinatesUnit and temperatureUnit are required (no default)';
  const inline = typeof args['csv'] === 'string' ? args['csv'] : undefined;
  const file = nonEmptyString(args['path']);
  if (inline === undefined && file === undefined) return 'provide csv (text) or path (a file in the exchange directory)';
  if (inline !== undefined) return { csv: inline, coordinatesUnit, temperatureUnit };
  if (deps.port?.readExchangeFile === undefined || file === undefined)
    return 'path is unavailable: the server has no exchange directory (LLULL_EXCHANGE_DIR); pass csv';
  return { csv: await deps.port.readExchangeFile(file, 'utf8'), coordinatesUnit, temperatureUnit };
}

/**
 * Dispatch an FE tool call; null for any other tool name.
 * @failure no port, missing analysisId, transport throw -> isError result, document unchanged
 */
export async function applyFeaToolCall(toolName: string, rawArgs: unknown, deps: FeaDeps): Promise<ShapedToolResult | null> {
  if (!(FEA_TOOL_NAMES as readonly string[]).includes(toolName)) return null;
  const args = isRecord(rawArgs) ? rawArgs : {};
  const analysisId = nonEmptyString(args['analysisId']);
  if (analysisId === undefined) return failure(`${toolName}: analysisId is required.`);
  if (deps.fea === undefined || deps.fea === null) {
    return failure(
      `${toolName} FEA_TOOL_MISSING: the FE transports are not configured on this host (needs the llull server with gmsh and ccx).`,
    );
  }
  const requested = args['timeoutS'];
  const timeoutS =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.min(FEA_SOLVE_TIMEOUT_S.max, Math.max(FEA_SOLVE_TIMEOUT_S.min, requested))
      : undefined;
  try {
    if (toolName === 'fea_import_field') {
      const table = await tableInput(args, deps);
      return typeof table === 'string'
        ? failure(`${toolName}: ${table}.`)
        : shapeToolCallContent(await deps.fea.importField(analysisId, table, deps));
    }
    const result =
      toolName === 'fea_mesh'
        ? await deps.fea.mesh(analysisId, deps)
        : toolName === 'fea_solve'
          ? await deps.fea.solve(analysisId, timeoutS === undefined ? {} : { timeoutS }, deps)
          : await deps.fea.exportDeck(analysisId, deps);
    return shapeToolCallContent(result);
  } catch (error) {
    return failure(`${toolName} failed: ${errorMessage(error)}`);
  }
}
