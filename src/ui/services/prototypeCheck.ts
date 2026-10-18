// check_prototype for the Review tab (read-only query: kernel + physics). Online it runs on the server (same reason as simulationRun:
// the served app's CSP blocks the in-page MuJoCo load); offline it runs in the page. Where check_prototype is not registered, the tab
// runs check_assembly (the same check-result envelope, kernel only) and wraps it as a review whose other checks read "not run".

import { getCommand } from '@core/commands/registry';
import { ensurePhysicsEngine } from '@app/physics';
import { useStore } from '@ui/store';
import { runQuery } from '@ui/services/localQuery';
import { postCommand, ServerCommandError } from '@ui/store/serverCommands';

export const CHECK_COMMAND = 'check_prototype';
const ASSEMBLY_COMMAND = 'check_assembly';

/** The command the Review tab runs: check_prototype, else check_assembly, else none. */
export function reviewCheckCommand(): string | null {
  if (getCommand(CHECK_COMMAND) !== undefined) return CHECK_COMMAND;
  return getCommand(ASSEMBLY_COMMAND) !== undefined ? ASSEMBLY_COMMAND : null;
}

/** check_assembly's single check result as a review envelope (the other three checks are absent: the checklist shows them not run). */
function asReview(data: unknown, summary: string): unknown {
  return data === undefined || data === null ? data : { checks: [data], ownerSummary: summary };
}

interface PrototypeCheckRun {
  readonly summary: string;
  readonly data: unknown;
}

async function runOnServer(command: string, params: Record<string, unknown>): Promise<PrototypeCheckRun> {
  try {
    const response = await postCommand(command, params);
    return { summary: response.summary, data: response.data };
  } catch (error: unknown) {
    const reason = error instanceof ServerCommandError ? error.message : String(error);
    return { summary: `${command} failed on the server: ${reason}`, data: undefined };
  }
}

async function runAssemblyCheck(params: Record<string, unknown>): Promise<PrototypeCheckRun> {
  const run =
    useStore.getState().liveStatus === 'connected' ? await runOnServer(ASSEMBLY_COMMAND, params) : runQuery(ASSEMBLY_COMMAND, params);
  return { summary: run.summary, data: asReview(run.data, run.summary) };
}

export async function runPrototypeCheck(params: Record<string, unknown>, onStatus: (status: string) => void): Promise<PrototypeCheckRun> {
  if (reviewCheckCommand() === ASSEMBLY_COMMAND) return runAssemblyCheck(params);
  if (useStore.getState().liveStatus === 'connected') return runOnServer(CHECK_COMMAND, params);
  onStatus('Loading the physics engine…');
  if (!(await ensurePhysicsEngine())) return { summary: 'The physics engine could not be loaded (see the console).', data: undefined };
  await new Promise((resolve) => setTimeout(resolve, 0));
  const run = runQuery(CHECK_COMMAND, params);
  return { summary: run.summary, data: run.data };
}
