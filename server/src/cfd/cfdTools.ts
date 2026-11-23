/**
 * The flow transports of the `llull` CLI and the backend (12 CFD; schemas in `@protocol/cfdTools` and `@protocol/nativeTools`):
 *   cfd_solve        flow case -> llull-compute flow -> cfd_result bundle + field file -> record_cfd_results (`flowSolve.ts`)
 *   cfd_solve gridStudy   three solves at ratio 2 -> record_cfd_results (finest) + record_cfd_grid_study (`flowGridStudy.ts`)
 *   cfd_stop         kills the running solves of a case in this host; nothing is recorded (`flowSolve.ts`)
 *   cfd_probe / cfd_slice / cfd_streamlines   llull-compute flow-query on the recorded field (`flowQuery.ts`), read-only
 *   cfd_render       render_view with a slice / streamlines of the recorded result drawn over it (`flowRender.ts`)
 */

import type { FeaHost } from '@protocol/index';
import type { CommandOutcome } from '@protocol/restProtocol';
import { isRecord } from '@lib/isRecord';
import { nonEmptyString } from '@lib/nonEmptyString';
import type { NativeDeps } from '../native/fatigueField';
import { runCfdRender } from './flowRender';
import { runCfdQuery } from './flowQuery';
import { runCfdGridStudy } from './flowGridStudy';
import { runCfdSolve, runCfdStop, type CfdSolveOptions } from './flowSolve';

export const CFD_TOOL_NAMES: readonly string[] = ['cfd_solve', 'cfd_stop', 'cfd_probe', 'cfd_slice', 'cfd_streamlines', 'cfd_render'];

const QUERY_OPS = { cfd_probe: 'probe', cfd_slice: 'slice', cfd_streamlines: 'streamlines' } as const;

const failure = (summary: string): CommandOutcome => ({ summary, affected: [], isError: true, changed: false });

/**
 * Runs the flow transport `name`.
 * @failure missing caseId -> isError outcome; transport failures are outcomes (never throws)
 */
export async function runCfdTool(
  name: string,
  params: unknown,
  host: FeaHost,
  deps: NativeDeps,
  signal?: AbortSignal,
): Promise<CommandOutcome> {
  const args = isRecord(params) ? params : {};
  const finite = (key: string): number | undefined => (typeof args[key] === 'number' && Number.isFinite(args[key]) ? args[key] : undefined);
  if (name === 'cfd_render') return { ...(await runCfdRender(params, host, deps, signal)), changed: false };
  if (name === 'cfd_probe' || name === 'cfd_slice' || name === 'cfd_streamlines')
    return { ...(await runCfdQuery(QUERY_OPS[name], params, host, deps, { signal })), changed: false };
  const caseId = nonEmptyString(args['caseId']);
  if (caseId === undefined) return failure(`${name}: caseId is required.`);
  if (name === 'cfd_stop') return { ...runCfdStop(caseId), changed: false };
  const device = args['device'];
  const quantity = args['quantity'];
  const options: CfdSolveOptions = {
    ...(finite('timeoutS') !== undefined ? { timeoutS: finite('timeoutS') as number } : {}),
    ...(finite('deviceMemoryBytes') !== undefined ? { deviceMemoryBytes: finite('deviceMemoryBytes') as number } : {}),
    ...(finite('maxSteps') !== undefined ? { maxSteps: finite('maxSteps') as number } : {}),
    ...(finite('latticeMach') !== undefined ? { latticeMach: finite('latticeMach') as number } : {}),
    ...(typeof args['les'] === 'boolean' ? { les: args['les'] } : {}),
    ...(args['gridStudy'] === true ? { gridStudy: true } : {}),
    ...(quantity === 'cd' || quantity === 'cl' || quantity === 'cdAM2' ? { quantity } : {}),
    ...(finite('safetyFactor') !== undefined ? { safetyFactor: finite('safetyFactor') as number } : {}),
    ...(device === 'cpu' || device === 'gpu' || device === 'auto' ? { device } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
  const before = host.getDoc();
  const result = await (options.gridStudy === true ? runCfdGridStudy : runCfdSolve)(caseId, options, host, deps);
  return { ...result, changed: host.getDoc() !== before };
}
