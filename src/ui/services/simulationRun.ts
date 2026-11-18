// simulate_motion for the Physics panel. Connected, it runs on the backend (MuJoCo under Node). Disconnected, it runs in the in-page
// physics worker (physicsRun.ts): the page itself cannot load the engine under the app's CSP, a dedicated worker can.

import { useStore } from '@ui/store';
import { runPhysicsQuery } from '@ui/services/physicsRun';
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

/** @param onStatus progress line while the in-page engine loads (disconnected only) */
export async function runSimulation(params: Record<string, unknown>, onStatus?: (status: string) => void): Promise<SimulationRun> {
  if (useStore.getState().liveStatus === 'connected') return runOnServer(params);
  return runPhysicsQuery('simulate_motion', params, onStatus);
}
