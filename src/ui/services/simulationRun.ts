// simulate_motion for the Physics panel. Online it runs on the server (MuJoCo under Node): the served app's CSP has no
// 'unsafe-eval', which MuJoCo's WASM bindings need at load, so the in-page engine cannot start there. Offline it runs in the page.

import { ensurePhysicsEngine } from '@app/physics';
import { useStore } from '@ui/store';
import { runQuery } from '@ui/services/localQuery';
import { postCommand, ServerCommandError } from '@ui/store/serverCommands';

export interface SimulationRun {
  readonly summary: string;
  readonly data: unknown;
}

async function runOnServer(params: Record<string, unknown>): Promise<SimulationRun> {
  try {
    const response = await postCommand('simulate_motion', params);
    return { summary: response.summary, data: response.data };
  } catch (error: unknown) {
    const reason = error instanceof ServerCommandError ? error.message : String(error);
    return { summary: `simulate_motion failed on the server: ${reason}`, data: undefined };
  }
}

/** @param onStatus progress line while the engine loads / the run starts */
export async function runSimulation(params: Record<string, unknown>, onStatus: (status: string) => void): Promise<SimulationRun> {
  if (useStore.getState().liveStatus === 'connected') return runOnServer(params);
  onStatus('Loading the MuJoCo physics engine…');
  if (!(await ensurePhysicsEngine())) return { summary: 'The physics engine could not be loaded (see the console).', data: undefined };
  // let the status paint before the synchronous run
  await new Promise((resolve) => setTimeout(resolve, 0));
  const run = runQuery('simulate_motion', params);
  return { summary: run.summary, data: run.data };
}
