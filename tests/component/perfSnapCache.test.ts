import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { sharedSnapCandidates } from '@ui/viewport/2d/snapping/sharedCandidates';

const NONE_HIDDEN: ReadonlySet<string> = new Set();

describe('sharedSnapCandidates', () => {
  const doc = execute(
    execute(createEmptyDocument(), 'draw_polyline', {
      points: [
        [0, 0],
        [10, 0],
      ],
    }).document,
    'draw_polyline',
    {
      points: [
        [5, -5],
        [5, 5],
      ],
    },
  ).document;
  const inputs = (document: typeof doc, drawOrigin: [number, number] | null = null): Parameters<typeof sharedSnapCandidates>[0] => ({
    document,
    hiddenLayerIds: NONE_HIDDEN,
    hiddenEntityIds: NONE_HIDDEN,
    drawOrigin,
    cutDepth: undefined,
  });

  it('computes once per document and inputs, shared across callers; selection-only changes hit the cache', () => {
    const first = sharedSnapCandidates(inputs(doc));
    expect(first.some((c) => c.type === 'intersection' && c.x === 5 && c.y === 0)).toBe(true);
    expect(sharedSnapCandidates(inputs({ ...doc, selection: [doc.order[0] as string] }))).toBe(first);
  });

  it('recomputes when entities or the draw origin change', () => {
    const first = sharedSnapCandidates(inputs(doc));
    expect(sharedSnapCandidates(inputs(doc, [1, 1]))).not.toBe(first);
    const edited = execute(doc, 'draw_polyline', {
      points: [
        [0, 5],
        [10, 5],
      ],
    }).document;
    expect(sharedSnapCandidates(inputs(edited))).not.toBe(first);
    expect(sharedSnapCandidates(inputs(doc))).toBe(first);
  });
});
