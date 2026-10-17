import { describe, expect, it } from 'vitest';
import { featureNotes } from '@core/codegen/featureNotes';
import type { FeatureRecipe } from '@core/geometry/featureLowering';

const hole = (modelled: boolean): FeatureRecipe =>
  ({
    op: 'feature',
    feature: 'hole',
    source: {
      op: 'solid',
      entity: { id: 'b', kind: 'box', position: [0, 0, 0], rotation: [0, 0, 0], size: [10, 10, 10], layerId: 'l', color: '#ffffff' },
    },
    frame: { origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] },
    points: [[0, 0]],
    hole: {
      kind: 'simple',
      diameter: 4.9174682,
      thread: { designation: 'M6x1', family: 'M', ...(modelled ? { modelled: true, pitch: 1, majorDiameter: 6 } : {}) },
    },
    extent: { kind: 'through_all' },
  }) as unknown as FeatureRecipe;

describe('export_code thread note (VC-FTR-28 / VC-FTR-36)', () => {
  it('a cosmetic thread is noted as having no geometry', () => {
    expect(featureNotes(hole(false)).join('\n')).toContain('thread M6x1 (cosmetic, no geometry)');
  });

  it('a modelled thread is not called cosmetic', () => {
    const text = featureNotes(hole(true)).join('\n');
    expect(text).toContain('thread M6x1 (modelled helical groove');
    expect(text).not.toContain('cosmetic');
  });
});
