import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { derivedEntityIds } from '@core/plugins/host';
import { xy } from '../../helpers/xy';

describe('document partition', () => {
  it('lists building-generated entities as derived, plain entities as not', () => {
    let doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const boxId = doc.order[0] ?? '';
    doc = execute(doc, 'draw_walls', { points: xy(0, 0, 5000, 0) }).document;
    const derived = derivedEntityIds(doc);
    expect(derived.size).toBeGreaterThan(0);
    expect(derived.has(boxId)).toBe(false);
    expect(derivedEntityIds(createEmptyDocument()).size).toBe(0);
  });
});
