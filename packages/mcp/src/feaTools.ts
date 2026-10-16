/**
 * FE pipeline tools (transport-level, hand-written schemas like the exchange tools): meshing (Gmsh) and solving (CalculiX) run on
 * the host behind the injected `FeaToolsPort` (server/); every document change still goes through registry commands
 * (`record_fe_mesh` / `record_fea_results`) via the injected `applyCommand`.
 *   fea_mesh    analysed solids -> tet mesh artifact -> record_fe_mesh
 *   fea_solve   mesh artifact -> input deck -> CalculiX -> results artifact -> record_fea_results
 *   fea_export  the CalculiX input deck (text + sha256), nothing run
 */
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { nonEmptyString } from '@lib/nonEmptyString';
import type { CadDocument } from '@core/model/types';
import type { McpToolDefinition } from './tools';
import { shapeToolCallContent, type McpShapedResult } from './dispatch';
import type { CommandOutcome } from './restProtocol';

export type FeaToolResult = Omit<CommandOutcome, 'changed'>;

/** The host document and the command bus the transports record their results through. */
export interface FeaHost {
  readonly getDoc: () => CadDocument;
  readonly applyCommand: (name: string, params: unknown) => FeaToolResult;
}

/** Port to the FE transports (implemented in `server/`). Failures are results (`isError`, summary starts `<tool> <CODE>`), not throws. */
export interface FeaToolsPort {
  mesh(analysisId: string, host: FeaHost): Promise<FeaToolResult>;
  solve(analysisId: string, options: { readonly timeoutS?: number }, host: FeaHost): Promise<FeaToolResult>;
  exportDeck(analysisId: string, host: FeaHost): Promise<FeaToolResult>;
}

const ANALYSIS_ID = { type: 'string' as const, description: 'Id of the analysis case (create_analysis).' };

const FEA_TOOL_NAMES = ['fea_mesh', 'fea_solve', 'fea_export'] as const;

export function buildFeaToolDefinitions(): McpToolDefinition[] {
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
          timeoutS: { type: 'number', description: 'Solver wall-clock limit in seconds (default 600).' },
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
  ];
}

const failure = (message: string): McpShapedResult => shapeToolCallContent({ summary: message, affected: [], isError: true });

/** What `applyFeaToolCall` needs: the port (null = not configured) + the host. */
interface FeaDeps extends FeaHost {
  readonly fea?: FeaToolsPort | null;
}

/**
 * Dispatch an FE tool call; null for any other tool name.
 * @failure no port, missing analysisId, transport throw -> isError result, document unchanged
 */
export async function applyFeaToolCall(toolName: string, rawArgs: unknown, deps: FeaDeps): Promise<McpShapedResult | null> {
  if (!(FEA_TOOL_NAMES as readonly string[]).includes(toolName)) return null;
  const args = isRecord(rawArgs) ? rawArgs : {};
  const analysisId = nonEmptyString(args['analysisId']);
  if (analysisId === undefined) return failure(`${toolName}: analysisId is required.`);
  if (deps.fea === undefined || deps.fea === null) {
    return failure(
      `${toolName} FEA_TOOL_MISSING: the FE transports are not configured on this host (needs the llull server with gmsh and ccx).`,
    );
  }
  const timeoutS = typeof args['timeoutS'] === 'number' && args['timeoutS'] > 0 ? args['timeoutS'] : undefined;
  try {
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
