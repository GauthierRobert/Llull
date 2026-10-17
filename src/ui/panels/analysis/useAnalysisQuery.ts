// One read-only analysis query (check_analysis, compute_margins, fea_report …) for the panel: runs on the server while connected (where
// the mesh and results artifacts are), else on the page; keeps its parsed view, marked stale once the case it ran on changes.

import { useCallback, useState } from 'react';
import type { AnalysisCase } from '@core/model/analysis';
import { runAnalysisQuery } from '@ui/services/analysisRun';

interface Outcome<T> {
  readonly view: T | null;
  readonly summary: string;
  readonly source: AnalysisCase | null;
}

export interface AnalysisQuery<T> {
  readonly view: T | null;
  readonly summary: string;
  readonly running: boolean;
  readonly stale: boolean;
  run(): void;
}

export function useAnalysisQuery<T>(command: string, analysis: AnalysisCase, parse: (data: unknown) => T | null): AnalysisQuery<T> {
  const [outcome, setOutcome] = useState<Outcome<T>>({ view: null, summary: '', source: null });
  const [running, setRunning] = useState(false);
  const run = useCallback((): void => {
    setRunning(true);
    void runAnalysisQuery(command, { analysisId: analysis.id }).then((result) => {
      setOutcome({ view: parse(result.data), summary: result.summary, source: analysis });
      setRunning(false);
    });
  }, [command, analysis, parse]);
  const stale = outcome.source !== null && outcome.source !== analysis;
  return { view: outcome.view, summary: outcome.summary, running, stale, run };
}
