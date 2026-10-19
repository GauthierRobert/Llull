/**
 * The native transports in the `llull` CLI (RS1 §2: CLI-first, local only): hand-written schemas like the FE tools, run in-process
 * against the local document. They never change the document: results are artifacts read back by read-only registry commands.
 *   fatigue_field  FE fatigue case -> llull-compute post fatigue (every node) -> FatigueField artifact -> compute_fatigue
 *   fea_map_field  thermo_static interpolate field -> llull-compute post map -> mapped-field artifact (read by the fea_solve deck)
 *   fea_render     render_fea_results with the pixel raster in llull-compute raster (raster=auto|ts|cpu|gpu)
 */

import type { ToolDefinition } from '@protocol/tools';
import type { FeaHost } from '@protocol/index';
import type { CommandOutcome } from '@protocol/restProtocol';
import { getCommand } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';
import { nonEmptyString } from '@lib/nonEmptyString';
import { defaultFeArtifactStore } from '../fea/artifactStore';
import { createComputeRunner } from './computeJob';
import { runFatigueField, type NativeDeps } from './fatigueField';
import { runMapField } from './mapField';
import { runFeaRender } from './renderField';

const TIMEOUT = {
  type: 'number' as const,
  minimum: 1,
  maximum: 86400,
  description: 'Wall-clock limit of the native job in seconds (default 600).',
};

export function nativeToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'fatigue_field',
      description:
        'Run the all-node fatigue job of an FE fatigue case (create_fatigue_case with analysisId) in the native llull-compute binary: superposed ' +
        'load cases, stress measure, rainflow, mean-stress correction and Miner damage on EVERY mesh node (no pre-selection), stored as a ' +
        'content-addressed FatigueField bound to the case inputs. compute_fatigue then ranks the hot spots by damage and recomputes each row ' +
        'in TypeScript (the reference); this tool returns that result too. verify: true also runs the TypeScript reference on every node and ' +
        'reports the agreement. Needs a solved, current analysis (fea_solve). Without llull-compute: NATIVE_TOOL_MISSING.',
      inputSchema: {
        type: 'object',
        properties: {
          caseId: { type: 'string', description: 'Fatigue case id (affected[0] of create_fatigue_case).' },
          timeoutS: TIMEOUT,
          verify: {
            type: 'boolean',
            description: 'Also compute the TypeScript reference on every node and compare (slower). Default false.',
          },
        },
        required: ['caseId'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    {
      name: 'fea_map_field',
      description:
        'Map the thermal result of a thermo_static analysis whose field is thermal_result with mapping "interpolate" onto its mechanical mesh in ' +
        'the native llull-compute binary (same rules as the TypeScript mapping: lowest containing element, nearest-point projection outside). ' +
        'The mapped field is stored bound to the thermal results and the mechanical mesh hash; fea_solve checks both and writes it into the deck ' +
        '(fea_solve also does this by itself on large meshes). Run after fea_mesh. Without llull-compute: NATIVE_TOOL_MISSING (fea_solve maps in TypeScript).',
      inputSchema: {
        type: 'object',
        properties: { analysisId: { type: 'string', description: 'Id of the thermo_static analysis.' }, timeoutS: TIMEOUT },
        required: ['analysisId'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    renderToolDefinition(),
  ];
}

/** fea_render: the params of render_fea_results plus `raster` (read from the registry, so both stay one schema). */
function renderToolDefinition(): ToolDefinition {
  const schema = getCommand('render_fea_results')?.paramsSchema ?? { type: 'object' as const, properties: {}, required: [] };
  return {
    name: 'fea_render',
    description:
      'render_fea_results (same params, same data: svg, field, unit, min, max, levels, ...) with the pixel raster drawn by the native llull-compute ' +
      'binary for large headless plots (save with --save plot.png). raster: auto (default: TypeScript below 1e6 supersampled pixels, native CPU ' +
      'above), ts (the TypeScript reference and hash path), cpu (native CPU twin, bit-identical to ts), gpu (wgpu offscreen; a picture, not ' +
      'bit-identical: data.raster.deterministic false). data.raster = { engine ts | native-cpu | native-gpu, deterministic, device?, reason?, ' +
      'elapsedMs }; a missing binary or GPU falls back to the TypeScript raster and says why.',
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        raster: { type: 'string', enum: ['auto', 'ts', 'cpu', 'gpu'], description: 'Raster engine (default auto).' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  };
}

const NAMES: ReadonlySet<string> = new Set(['fatigue_field', 'fea_map_field', 'fea_render']);

export const isNativeTool = (name: string): boolean => NAMES.has(name);

function defaultDeps(env: NodeJS.ProcessEnv): NativeDeps {
  return { store: defaultFeArtifactStore(), runner: createComputeRunner(env), env };
}

const failure = (summary: string): CommandOutcome => ({ summary, affected: [], isError: true, changed: false });

/**
 * Runs a native transport against `host`; null for any other tool name.
 * @failure missing id parameter -> isError outcome; transport failures are outcomes (never throws)
 */
export async function runNativeTool(
  name: string,
  params: unknown,
  host: FeaHost,
  deps: NativeDeps = defaultDeps(process.env),
): Promise<CommandOutcome | null> {
  if (!isNativeTool(name)) return null;
  if (name === 'fea_render') return { ...(await runFeaRender(params, host, deps)), changed: false };
  const args = isRecord(params) ? params : {};
  const timeout = typeof args['timeoutS'] === 'number' && Number.isFinite(args['timeoutS']) ? { timeoutS: args['timeoutS'] } : {};
  if (name === 'fatigue_field') {
    const caseId = nonEmptyString(args['caseId']);
    if (caseId === undefined) return failure('fatigue_field: caseId is required.');
    return { ...(await runFatigueField(caseId, { ...timeout, verify: args['verify'] === true }, host, deps)), changed: false };
  }
  const analysisId = nonEmptyString(args['analysisId']);
  if (analysisId === undefined) return failure(`${name}: analysisId is required.`);
  return { ...(await runMapField(analysisId, timeout, host, deps)), changed: false };
}
