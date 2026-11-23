// Runs `cfd_solve` (optionally with the grid study) and `cfd_stop` for one case and reports their state. The solve is a long native job:
// the answer arrives when it ends, so the panel shows the elapsed time meanwhile; the result is recorded by the transport.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '@ui/store';
import { callFlowTool, OFFLINE } from './flowTransport';

type FlowSolveState =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly elapsedS: number; readonly gridStudy: boolean }
  | { readonly status: 'done'; readonly summary: string }
  | { readonly status: 'cancelled'; readonly summary: string }
  | { readonly status: 'failed'; readonly summary: string; readonly code: string | null; readonly remediation: string }
  | { readonly status: 'missing'; readonly reason: string };

export interface FlowSolveOptions {
  readonly gridStudy: boolean;
  readonly device: 'cpu' | 'gpu' | 'auto';
}

interface FlowSolve {
  readonly state: FlowSolveState;
  /** Why a solve cannot start; null when it can. */
  readonly disabledReason: string | null;
  /** Answer of the last `cfd_stop`, shown while the solve winds down. */
  readonly stopNote: string;
  start(options: FlowSolveOptions): void;
  stop(): void;
}

const IDLE: FlowSolveState = { status: 'idle' };

/** A change of `caseId` resets the state: a run belongs to one case. */
export function useFlowSolve(caseId: string): FlowSolve {
  const online = useStore((s) => s.liveStatus === 'connected');
  const [held, setHeld] = useState<{ caseId: string; value: FlowSolveState; stopNote: string }>({ caseId, value: IDLE, stopNote: '' });
  const startedAt = useRef(0);
  const own = held.caseId === caseId;
  const current = own ? held.value : IDLE;
  const running = current.status === 'running';

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setHeld((previous) =>
        previous.value.status === 'running'
          ? { ...previous, value: { ...previous.value, elapsedS: Math.round((Date.now() - startedAt.current) / 1000) } }
          : previous,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  const start = (options: FlowSolveOptions): void => {
    startedAt.current = Date.now();
    setHeld({ caseId, value: { status: 'running', elapsedS: 0, gridStudy: options.gridStudy }, stopNote: '' });
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
      setHeld((previous) => ({ caseId, value, stopNote: previous.caseId === caseId ? previous.stopNote : '' }));
    });
  };

  const stop = (): void => {
    void callFlowTool('cfd_stop', { caseId }).then((outcome) => {
      setHeld((previous) => (previous.caseId === caseId ? { ...previous, stopNote: outcome.summary } : previous));
    });
  };

  const disabledReason = !online ? OFFLINE : current.status === 'missing' ? current.reason : running ? 'Solving…' : null;
  return { state: current, disabledReason, stopNote: own ? held.stopNote : '', start, stop };
}
