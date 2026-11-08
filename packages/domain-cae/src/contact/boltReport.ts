/** Bolt part of contact_report / check_contact: forces, bending, shortening, clamp-zone closure and separations of the pretensioned bolts of a solved case. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { toAnalysisLength } from '../decks/units';
import {
  boltCuts,
  boltRows,
  clampRows,
  lastClampRows,
  separations,
  type BoltRow,
  type ClampRow,
  type Separation,
} from './pretensionResults';

export interface BoltReport {
  readonly bolts: readonly BoltRow[];
  /** Clamp-zone closure of each (bolt, pair) in the last increment of each step. */
  readonly clamp: readonly ClampRow[];
  /** Joints that separate: the first increment in which the whole clamp zone of a pair around a bolt is open. */
  readonly separated: readonly Separation[];
}

/**
 * Bolt rows (`increments`), the clamp-zone closure and the separations of every pretensioned bolt of `analysis`.
 * @invariant empty report for a case without pretensions; pure
 * @failure a bolt whose cut cannot be made on the mesh -> { code, message, ids }
 */
export function boltReport(
  doc: CadDocument,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  increments: 'summary' | 'all',
): BoltReport | { readonly code: string; readonly message: string; readonly ids: readonly string[] } {
  if (analysis.pretension === undefined) return { bolts: [], clamp: [], separated: [] };
  const scale = toAnalysisLength(doc, analysis.unitSystem, 1);
  const cuts = boltCuts(analysis, mesh, scale);
  if (!Array.isArray(cuts)) return cuts;
  const clamp = clampRows(analysis, mesh, results, cuts);
  const preloadStep = new Map(cuts.map((cut) => [cut.bolt.id, cut.bolt.preloadStepId]));
  return {
    bolts: boltRows(analysis, mesh, results, cuts, scale, increments),
    clamp: lastClampRows(clamp),
    separated: separations(clamp, preloadStep),
  };
}
