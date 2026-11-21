/**
 * Pair phase of `check_assembly` (TECHNICAL_SPEC 5.3 steps 2-7): broad phase, mesh narrow phase, kernel classification through the symmetry
 * reduction and the pair cache, items and links of every classified pair.
 * @invariant kernel-optional: the mesh phase never needs the kernel; `narrowPhase: 'exact'` needs an exact (native OCC) kernel and reports
 *   not_run (FPR_KERNEL_UNSUPPORTED) on a mesh kernel, `auto` classifies with whatever kernel is installed (mesh-accurate on Manifold)
 * @invariant pairs are classified in (i < j) order of the part list: deterministic; a scoped run still reports only pairs with a subject part
 */

import type { CadDocument } from '../../model/types';
import type { CheckItem } from '../../model/checkResult';
import type { GeometryKernel, ShapeAnalysis } from '../kernel';
import { intentOf } from '../assemblyGraph';
import type { GeometryQueryEngine } from '../geometryQueries';
import type { SpatialIndexPort } from '../spatialIndex';
import type { AssemblyPart, CheckTolerances } from './partTypes';
import { kernelUnsupportedItem, makeItem } from './partValidity';
import { pairItem } from './pairClassify';
import { broadPhasePairs } from './broadPhase';
import { meshClearPairs } from './meshNarrowPhase';
import type { PairCache } from './pairCache';
import { createPairEvaluator } from './pairEvaluation';

/** Candidate pairs the broad phase may hand on (TECHNICAL_SPEC 8: 20,000 parts x k ~ 8). */
const MAX_PAIRS = 200_000;

export type NarrowPhaseMode = 'auto' | 'exact';

export interface PairPhaseInput {
  readonly doc: CadDocument;
  readonly kernel: GeometryKernel;
  readonly parts: readonly AssemblyPart[];
  readonly subjects: ReadonlySet<string>;
  readonly excluded: ReadonlySet<string>;
  /** Pairs inside one rigid body are skipped unless the body itself is the scope. */
  readonly sameBody: (a: string, b: string) => boolean;
  readonly analyses: ReadonlyMap<string, ShapeAnalysis>;
  readonly tolerances: CheckTolerances;
  readonly symmetry: boolean;
  readonly cache: PairCache | null;
  readonly narrowPhase: NarrowPhaseMode;
  readonly engine: GeometryQueryEngine;
  readonly spatialIndex: SpatialIndexPort | null | undefined;
}

export interface PairPhaseOutput {
  readonly refusal: string | null;
  readonly items: CheckItem[];
  readonly strongLinks: Array<readonly [string, string]>;
  readonly touchLinks: Array<readonly [string, string]>;
  readonly data: {
    readonly pairsChecked: number;
    readonly narrowPhase: {
      readonly mode: NarrowPhaseMode;
      readonly exactKernel: boolean;
      readonly candidates: number;
      readonly meshCulled: number;
      readonly classified: number;
    };
    readonly symmetry: { readonly pairsSkipped: number; readonly cacheHits: number; readonly pairsEvaluated: number };
  };
}

/** True for the native exact kernel (OCC); the Manifold kernel works on meshes. */
function isExactKernel(kernel: GeometryKernel): boolean {
  const info = kernel.info?.();
  return info?.active === 'occt-native' || (info?.active === undefined && kernel.name?.startsWith('occt') === true);
}

const empty = (input: PairPhaseInput, exactKernel: boolean, candidates: number, refusal: string | null): PairPhaseOutput => ({
  refusal,
  items: [],
  strongLinks: [],
  touchLinks: [],
  data: {
    pairsChecked: 0,
    narrowPhase: { mode: input.narrowPhase, exactKernel, candidates, meshCulled: 0, classified: 0 },
    symmetry: { pairsSkipped: 0, cacheHits: 0, pairsEvaluated: 0 },
  },
});

export function runPairPhase(input: PairPhaseInput): PairPhaseOutput {
  const { doc, kernel, parts, subjects, excluded, tolerances } = input;
  const exactKernel = isExactKernel(kernel);
  const margin = tolerances.clearance + tolerances.epsTouch;
  const candidates = broadPhasePairs(parts, margin, input.spatialIndex).filter(([i, j]) => {
    const [a, b] = [parts[i], parts[j]];
    if (a === undefined || b === undefined || (!subjects.has(a.id) && !subjects.has(b.id))) return false;
    return !excluded.has(a.id) && !excluded.has(b.id) && !input.sameBody(a.id, b.id);
  });
  if (candidates.length > MAX_PAIRS)
    return empty(input, exactKernel, candidates.length, `${candidates.length} candidate pairs, limit ${MAX_PAIRS}`);
  if (input.narrowPhase === 'exact' && !exactKernel) {
    const out = empty(input, exactKernel, candidates.length, null);
    return { ...out, items: [kernelUnsupportedItem([...subjects], 'exact pair confirmation (narrowPhase "exact")')] };
  }
  const clear = meshClearPairs(parts, candidates, margin, input.engine);
  const evaluator = createPairEvaluator({
    kernel,
    tolerances,
    symmetry: input.symmetry,
    cache: input.cache,
    salt: `${input.narrowPhase}:${exactKernel}`,
  });
  const items: CheckItem[] = [];
  const strongLinks: Array<readonly [string, string]> = [];
  const touchLinks: Array<readonly [string, string]> = [];
  let notRun = false;
  let classified = 0;
  candidates.forEach(([i, j], index) => {
    if (clear[index] === true) return;
    const [a, b] = [parts[i] as AssemblyPart, parts[j] as AssemblyPart];
    const [analysisA, analysisB] = [input.analyses.get(a.id), input.analyses.get(b.id)];
    const pair = analysisA === undefined || analysisB === undefined ? null : evaluator.evaluate(a, b, analysisA.volume, analysisB.volume);
    if (pair === null) {
      notRun = true;
      return;
    }
    if (pair === undefined) return;
    classified++;
    const intent = intentOf(doc, a.id, b.id);
    const item = pairItem(
      pair,
      [a.id, b.id],
      tolerances,
      intent === undefined ? undefined : { id: intent.id, kind: intent.kind, reason: intent.reason, declaredBy: intent.declaredBy },
    );
    const overlapping = pair.kind === 'hard' || pair.kind === 'containment';
    const fastenerPair =
      overlapping && intent === undefined && (doc.entities[a.id]?.fastener === true) !== (doc.entities[b.id]?.fastener === true);
    items.push(
      fastenerPair
        ? {
            ...item,
            code: 'FPR_FASTENER_THREAD',
            status: 'info',
            findingKey: makeItem('FPR_FASTENER_THREAD', 'info', [a.id, b.id], '').findingKey,
            remediation:
              'A fastener overlaps its host (thread / press fit): reported apart from clashes; untag with set_fastener if it is a real clash.',
            note: 'fastener-to-host overlap: one part carries the fastener tag',
          }
        : item,
    );
    if (pair.kind === 'touch') touchLinks.push([a.id, b.id]);
    else if (pair.kind !== 'clearance') strongLinks.push([a.id, b.id]);
  });
  if (notRun) items.push(kernelUnsupportedItem([...subjects], 'pair classification (distance / analyze)'));
  const { stats } = evaluator;
  return {
    refusal: null,
    items,
    strongLinks,
    touchLinks,
    data: {
      pairsChecked: candidates.length,
      narrowPhase: {
        mode: input.narrowPhase,
        exactKernel,
        candidates: candidates.length,
        meshCulled: clear.filter(Boolean).length,
        classified,
      },
      symmetry: { pairsSkipped: stats.reused, cacheHits: stats.cacheHits, pairsEvaluated: stats.evaluated },
    },
  };
}
