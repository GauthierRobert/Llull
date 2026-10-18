// Snap candidates are cursor-independent but O(segments²): SnapIndicator and DrawInteraction both need them, so the
// result is computed once per (entities, inputs) and shared. Keyed by the `entities` record (WeakMap: freed with it).

import type { CadDocument, Vec2 } from '@core/model/types';
import { isEntityVisible } from '../../entityVisibility';
import { collectSnapCandidates } from './candidates';
import type { SnapPoint } from './types';

export interface SnapCandidateInputs {
  readonly document: Pick<CadDocument, 'entities' | 'order' | 'components' | 'layers'>;
  readonly hiddenLayerIds: ReadonlySet<string>;
  readonly hiddenEntityIds: ReadonlySet<string>;
  readonly drawOrigin: Vec2 | null;
  readonly cutDepth: number | undefined;
}

interface CacheEntry {
  readonly inputs: SnapCandidateInputs;
  readonly candidates: SnapPoint[];
}

const MAX_ENTRIES_PER_DOCUMENT = 4;
const cache = new WeakMap<object, CacheEntry[]>();

function sameOrigin(a: Vec2 | null, b: Vec2 | null): boolean {
  return a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1]);
}

function sameInputs(a: SnapCandidateInputs, b: SnapCandidateInputs): boolean {
  return (
    a.document.order === b.document.order &&
    a.document.components === b.document.components &&
    a.document.layers === b.document.layers &&
    a.hiddenLayerIds === b.hiddenLayerIds &&
    a.hiddenEntityIds === b.hiddenEntityIds &&
    a.cutDepth === b.cutDepth &&
    sameOrigin(a.drawOrigin, b.drawOrigin)
  );
}

export function sharedSnapCandidates(inputs: SnapCandidateInputs): SnapPoint[] {
  const entries = cache.get(inputs.document.entities) ?? [];
  const hit = entries.find((entry) => sameInputs(entry.inputs, inputs));
  if (hit !== undefined) return hit.candidates;
  const { document, hiddenLayerIds, hiddenEntityIds, drawOrigin, cutDepth } = inputs;
  const candidates = collectSnapCandidates(
    document,
    {
      extensions: false,
      nearest: false,
      isVisible: (entity) => isEntityVisible(entity, document.layers, hiddenLayerIds, hiddenEntityIds),
      cutDepth,
    },
    drawOrigin,
    null,
  );
  cache.set(inputs.document.entities, [{ inputs, candidates }, ...entries].slice(0, MAX_ENTRIES_PER_DOCUMENT));
  return candidates;
}
