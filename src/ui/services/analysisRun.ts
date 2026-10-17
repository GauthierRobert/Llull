// FE queries and transports for the Analysis panel. Mesh and results artifacts live in the server's artifact store, so while the app is
// connected every read-only analysis query (check_analysis, compute_margins, fea_report …) runs there; offline it runs on the page
// document. Meshing (Gmsh) and solving (CalculiX) are host transports: server only (POST /exchange), recorded by command.

import { useStore } from '@ui/store';
import { runQuery } from '@ui/services/localQuery';
import { postCommand, postExchange, ServerCommandError } from '@ui/store/serverCommands';

export interface AnalysisRun {
  readonly summary: string;
  readonly data: unknown;
  readonly ok: boolean;
}

const failure = (command: string, error: unknown): AnalysisRun => ({
  summary: `${command} failed on the server: ${error instanceof ServerCommandError ? error.message : String(error)}`,
  data: undefined,
  ok: false,
});

const isServerConnected = (): boolean => useStore.getState().liveStatus === 'connected';

export async function runAnalysisQuery(command: string, params: Record<string, unknown>): Promise<AnalysisRun> {
  if (!isServerConnected()) {
    const result = runQuery(command, params);
    return { summary: result.summary, data: result.data, ok: result.error === undefined };
  }
  try {
    const response = await postCommand(command, params);
    return { summary: response.summary, data: response.data, ok: !response.isError };
  } catch (error: unknown) {
    return failure(command, error);
  }
}

/** fea_mesh then fea_solve on the server; stops at the first refusal. @param onStatus progress line */
export async function meshAndSolve(analysisId: string, onStatus: (status: string) => void): Promise<AnalysisRun> {
  for (const [tool, label] of [
    ['fea_mesh', 'Meshing with Gmsh…'],
    ['fea_solve', 'Solving with CalculiX…'],
  ] as const) {
    onStatus(label);
    try {
      const outcome = await postExchange(tool, { analysisId });
      if (outcome.isError) return { summary: outcome.summary, data: outcome.data, ok: false };
      if (tool === 'fea_solve') return { summary: outcome.summary, data: outcome.data, ok: true };
    } catch (error: unknown) {
      return failure(tool, error);
    }
  }
  return { summary: '', data: undefined, ok: false };
}
