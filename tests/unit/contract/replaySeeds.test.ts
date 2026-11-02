/** Plugin replay seeds compose: disjoint leaves merge (also inside one top-level key), a real conflict is reported, and every installed seed composes on a rich document. */

import { describe, expect, it } from 'vitest';
import { mergeReplaySeeds } from '@core/commands/history/replaySeeds';
import type { CadDocument } from '@core/model/types';
import { documentExtensions } from '@core/plugins/host';
import { signedPlantDoc } from '../../helpers/signedPlantDoc';

const seedOf = (value: unknown): Partial<CadDocument> => value as Partial<CadDocument>;

describe('mergeReplaySeeds', () => {
  it('merges sub-slices of the same top-level key without losing either', () => {
    const a = seedOf({ plant: { spec: { approvals: [1] } } });
    const b = seedOf({ plant: { fabrication: { issueLedger: [2] } }, building: { uid: 'u' } });
    const { seed, conflicts } = mergeReplaySeeds([a, b]);
    expect(seed).toEqual({ plant: { spec: { approvals: [1] }, fabrication: { issueLedger: [2] } }, building: { uid: 'u' } });
    expect(conflicts).toEqual([]);
    expect(a).toEqual({ plant: { spec: { approvals: [1] } } });
  });

  it('reports a leaf two plugins seed differently and keeps the first; an identical leaf is no conflict', () => {
    const { seed, conflicts } = mergeReplaySeeds([
      seedOf({ plant: { spec: { x: 1, y: 2 } } }),
      seedOf({ plant: { spec: { x: 9, y: 2 } } }),
    ]);
    expect(conflicts).toEqual(['plant.spec.x']);
    expect(seed).toEqual({ plant: { spec: { x: 1, y: 2 } } });
  });

  it('every installed plugin seed of a document holding all ledgers composes without conflict and keeps both ledgers', () => {
    const base = signedPlantDoc();
    const { seed, conflicts } = mergeReplaySeeds(documentExtensions().map((extension) => extension.replaySeed?.(base) ?? {}));
    expect(conflicts).toEqual([]);
    expect(seed.plant?.spec?.approvals).toHaveLength(1);
    expect(seed.plant?.fabrication?.issueLedger).toHaveLength(1);
  });
});
