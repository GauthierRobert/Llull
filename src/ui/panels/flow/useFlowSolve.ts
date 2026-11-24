// Runs `cfd_solve` (optionally with the grid study) and `cfd_stop` for one case and reports their state. The solve is a long native job:
// the answer arrives when it ends, so the panel shows the elapsed time meanwhile; the result is recorded by the transport. The state lives
// in the flow view store, per case, so it survives picking another case.

import { useEffect, useReducer } from 'react';
import { useStore } from '@ui/store';
import { useFlowViewStore, type FlowSolveEntry, type FlowSolveState } from '@ui/store/flowViewStore';
import { callFlowTool, OFFLINE } from './flowTransport';

export interface FlowSolveOptions {
  readonly gridStudy: boolean;
  readonly device: 'cpu' | 'gpu' | 'auto';
}

interface FlowSolve {
  readonly state: FlowSolveState;
  /** Seconds since the running solve started (0 when none runs). */
  readonly elapsedS: number;
  /** Why a solve cannot start; null when it can. */
  readonly disabledReason: string | null;
  /** Answer of the last `cfd_stop`, shown while the solve winds down. */
  readonly stopNote: string;
  start(options: FlowSolveOptions): void;
  stop(): void;
}

const IDLE: FlowSolveEntry = { state: { status: 'idle' }, stopNote: '' };

export function useFlowSolve(caseId: string): FlowSolve {
  const online = useStore((s) => s.liveStatus === 'connected');
  const { state, stopNote } = useFlowViewStore((s) => s.solves[caseId] ?? IDLE);
  const running = state.status === 'running';

  // A tick per second re-renders the elapsed time while running; the time itself comes from the stored start.
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running]);

  const start = (options: FlowSolveOptions): void => {
    const { setSolve } = useFlowViewStore.getState();
    setSolve(caseId, { state: { status: 'running', startedAt: Date.now(), gridStudy: options.gridStudy }, stopNote: '' });
    const params = {
      caseId,
      ...(options.gridStudy ? { gridStudy: true } : {}),
      ...(options.device === 'auto' ? {} : { device: options.device }),
    };
    void callFlowTool('cfd_solve', params).then((outcome) => {
      let value: FlowSolveState;
      if (outcome.ok) value = { status: 'done', summary: outcome.summary };
      else if (outcome.code === 'BACKEND_MISSING') value = { status: 'missing', reason: outcome.summary };
      else if (outcome.code === 'CFD_CANCELLED') value = { status: 'cancelled', summary: outcome.summary };
      else value = { status: 'failed', summary: outcome.summary, code: outcome.code, remediation: outcome.remediation };
      setSolve(caseId, { state: value });
    });
  };

  const stop = (): void => {
    void callFlowTool('cfd_stop', { caseId }).then((outcome) =>
      useFlowViewStore.getState().setSolve(caseId, { stopNote: outcome.summary }),
    );
  };

  const disabledReason = !online ? OFFLINE : state.status === 'missing' ? state.reason : running ? 'Solving…' : null;
  const elapsedS = state.status === 'running' ? Math.max(0, Math.round((Date.now() - state.startedAt) / 1000)) : 0;
  return { state, elapsedS, disabledReason, stopNote, start, stop };
}
