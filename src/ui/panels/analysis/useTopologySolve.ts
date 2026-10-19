// Runs the `topology_solve` host tool (like fea_solve: a server-side transport, not a document command) and reports its progress.
// The result reaches the document through the transport's own record_topology_result, arriving over the live stream.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '@ui/store';
import { postExchange, ServerCommandError } from '@ui/store/serverCommands';
import { errorMessage } from '@lib/errorMessage';

export type TopologySolveState =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly elapsedS: number }
  | { readonly status: 'done'; readonly summary: string }
  | { readonly status: 'failed'; readonly summary: string; readonly code: string | null; readonly remediation: string }
  | { readonly status: 'missing'; readonly reason: string };

interface TopologySolve {
  readonly state: TopologySolveState;
  /** Why the button is disabled; null when a solve can start. */
  readonly disabledReason: string | null;
  start(): void;
}

const OFFLINE = 'Needs the llull backend: open the desktop app (or run `llull serve`) to solve; offline only the set-up can be edited.';
const MISSING_TOOL = /unknown (command|tool)|not (available|found|installed)|TOOL_MISSING/i;

/** The transport's TOP_* code (`data.code`) when it reports no `error`. */
function dataCode(data: unknown): string | null {
  return typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string' ? data.code : null;
}

/** `studyId` changes reset the state: a result belongs to one study. */
export function useTopologySolve(studyId: string): TopologySolve {
  const online = useStore((s) => s.liveStatus === 'connected');
  const [state, setState] = useState<{ studyId: string; value: TopologySolveState }>({ studyId, value: { status: 'idle' } });
  const startedAt = useRef(0);
  const current: TopologySolveState = state.studyId === studyId ? state.value : { status: 'idle' };
  const running = current.status === 'running';

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setState((previous) =>
        previous.value.status === 'running'
          ? { studyId: previous.studyId, value: { status: 'running', elapsedS: Math.round((Date.now() - startedAt.current) / 1000) } }
          : previous,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  const start = (): void => {
    startedAt.current = Date.now();
    setState({ studyId, value: { status: 'running', elapsedS: 0 } });
    postExchange('topology_solve', { studyId })
      .then((response) => {
        const code = response.error?.code ?? dataCode(response.data);
        if (!response.isError) setState({ studyId, value: { status: 'done', summary: response.summary } });
        else if (MISSING_TOOL.test(`${code ?? ''} ${response.summary}`))
          setState({ studyId, value: { status: 'missing', reason: response.summary } });
        else
          setState({
            studyId,
            value: { status: 'failed', summary: response.summary, code, remediation: response.error?.remediation ?? '' },
          });
      })
      .catch((err: unknown) => {
        const gone = err instanceof ServerCommandError && err.kind === 'http' && err.status === 404;
        setState({
          studyId,
          value: gone
            ? { status: 'missing', reason: 'This backend has no topology_solve tool (needs a build with llull-compute topopt).' }
            : { status: 'failed', summary: `topology_solve failed: ${errorMessage(err)}`, code: null, remediation: '' },
        });
      });
  };

  const disabledReason = !online ? OFFLINE : current.status === 'missing' ? current.reason : running ? 'Solving…' : null;
  return { state: current, disabledReason, start };
}
