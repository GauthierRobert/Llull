// Calls a flow host transport (`cfd_solve`, `cfd_stop`, `cfd_slice`, `cfd_streamlines`) over POST /exchange, like `topology_solve`:
// not a document command. Never throws; a solve's result reaches the document through the transport's own record commands (live stream).

import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { postExchange, ServerCommandError } from '@ui/store/serverCommands';

export interface FlowOutcome {
  readonly ok: boolean;
  readonly summary: string;
  /** The transport's CFD_* code, or `BACKEND_MISSING` when this backend has no such tool, or null. */
  readonly code: string | null;
  readonly remediation: string;
  readonly data: unknown;
}

export const OFFLINE =
  'Needs the llull backend: open the desktop app (or run `llull serve`) to solve; offline only the set-up can be edited.';

const MISSING_TOOL = /unknown (command|tool)|not (available|found|installed)|TOOL_MISSING/i;

const dataCode = (data: unknown): string | null => (isRecord(data) && typeof data['code'] === 'string' ? data['code'] : null);

export async function callFlowTool(name: string, params: Record<string, unknown>): Promise<FlowOutcome> {
  try {
    const response = await postExchange(name, params);
    const code = response.error?.code ?? dataCode(response.data);
    const missing = response.isError && MISSING_TOOL.test(`${code ?? ''} ${response.summary}`);
    return {
      ok: !response.isError,
      summary: response.summary,
      code: missing ? 'BACKEND_MISSING' : code,
      remediation: response.error?.remediation ?? '',
      data: response.data,
    };
  } catch (err) {
    const gone = err instanceof ServerCommandError && err.kind === 'http' && err.status === 404;
    return {
      ok: false,
      summary: gone ? `This backend has no ${name} tool.` : `${name} failed: ${errorMessage(err)}`,
      code: gone ? 'BACKEND_MISSING' : null,
      remediation: '',
      data: null,
    };
  }
}
