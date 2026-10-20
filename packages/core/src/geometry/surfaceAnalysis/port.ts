/**
 * Injected surface-analysis port (02 SRF M4, TECHNICAL_SPEC §3 `kernel.analysis`): curvature, continuity, deviation and draft queries over
 * NURBS patches / curves / triangle meshes in WORLD coordinates. The TS engine (`tsSurfaceAnalysis`) is exact for NURBS input and
 * tessellation-based for meshes and is always available; a host with an exact kernel may install a faster or B-rep-aware one on
 * `ExecutionContext.surfaceAnalysis`. Commands read it from the context and fall back to the default through `resolveSurfaceAnalysis`.
 * @invariant every method is pure, synchronous and returns the same numbers for the same input (no randomness)
 */

import { surfaceSample } from '../../lib/nurbs/surfaceCurvature';
import { analyzeContinuity } from './continuity';
import { measureDeviation } from './deviation';
import { analyzeDraft } from './draft';
import type { SurfaceAnalysisEngine } from './types';

/** The always-available TS engine. */
export const tsSurfaceAnalysis: SurfaceAnalysisEngine = {
  provenance: { engine: 'ts-nurbs', exact: true },
  curvature: (surface, parameters) => parameters.map(([u, v]) => surfaceSample(surface, u, v)),
  continuity: analyzeContinuity,
  deviation: measureDeviation,
  draft: analyzeDraft,
};

/** The engine a command should use: the context's, else the default TS engine. */
export function resolveSurfaceAnalysis(engine: SurfaceAnalysisEngine | null | undefined): SurfaceAnalysisEngine {
  return engine ?? tsSurfaceAnalysis;
}
