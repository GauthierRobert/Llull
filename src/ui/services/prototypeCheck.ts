// check_prototype for the Review tab (read-only query: kernel + physics). Online it runs on the server (same reason as simulationRun:
// the served app's CSP blocks the in-page MuJoCo load); offline it runs in the page.

import { ensurePhysicsEngine } from '@app/physics';
import { useStore } from '@ui/store';
import { runQuery } from '@ui/services/localQuery';
import { postCommand, ServerCommandError } from '@ui/store/serverCommands';

export const CHECK_COMMAND = 'check_prototype';

interface PrototypeCheckRun {
  readonly summary: string;
  readonly data: unknown;
}

async function runOnServer(params: Record<string, unknown>): Promise<PrototypeCheckRun> {
  try {
    const response = await postCommand(CHECK_COMMAND, params);
    return { summary: response.summary, data: response.data };
  } catch (error: unknown) {
    const reason = error instanceof ServerCommandError ? error.message : String(error);
    return { summary: `${CHECK_COMMAND} failed on the server: ${reason}`, data: undefined };
  }
}

export async function runPrototypeCheck(params: Record<string, unknown>, onStatus: (status: string) => void): Promise<PrototypeCheckRun> {
  if (useStore.getState().liveStatus === 'connected') return runOnServer(params);
  onStatus('Loading the physics engine…');
  if (!(await ensurePhysicsEngine())) return { summary: 'The physics engine could not be loaded (see the console).', data: undefined };
  await new Promise((resolve) => setTimeout(resolve, 0));
  const run = runQuery(CHECK_COMMAND, params);
  return { summary: run.summary, data: run.data };
}
