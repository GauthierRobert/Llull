// The stress analysis of the store document for one model, computed once per document change and shared by the overlay and the panel
// (the analysis is a read-only query that rebuilds the finite element model: never run it per render or per consumer).

import type { CadDocument } from '@core/model/types';
import { runQuery } from '@ui/services/localQuery';
import { parseStressView, type StressOutcome } from './stressView';

let cached: { readonly document: CadDocument; readonly modelId: string; readonly outcome: StressOutcome } | null = null;

/** A refused analysis (no conditions, unstable model, non-finite results, ...) is `{ ok: false, summary }`: failure summary, no data. */
export function stressOutcome(document: CadDocument, modelId: string): StressOutcome {
  if (cached !== null && cached.document === document && cached.modelId === modelId) return cached.outcome;
  const result = runQuery('analyze_pipe_stress', { modelId, include: ['stresses'] });
  const view = parseStressView(result.data);
  const outcome: StressOutcome = view === null ? { ok: false, summary: result.summary } : { ok: true, view };
  cached = { document, modelId, outcome };
  return outcome;
}
