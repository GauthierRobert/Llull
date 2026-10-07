import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { collectGridAnnotations, GRID_LAYER_NAME } from '@ui/viewport/3d/gridAnnotations';
import { minScreenScale } from '@ui/viewport/2d/useMinScreenSize';

describe('collectGridAnnotations', () => {
  it('turns add_grid_system entities into axes and labelled bubbles at readable size', () => {
    const doc = execute(createEmptyDocument(), 'add_grid_system', {
      xSpacings: [6000, 6000],
      ySpacings: [8000],
    }).document;
    const gridEntities = Object.values(doc.entities).filter(
      (entity) => doc.layers[entity.layerId]?.name === GRID_LAYER_NAME,
    );
    expect(gridEntities.length).toBeGreaterThan(0);
    const { axes, bubbles } = collectGridAnnotations(gridEntities);
    expect(axes.length).toBeGreaterThan(0);
    expect(bubbles.length).toBe(axes.length * 2);
    expect(bubbles.every((bubble) => bubble.label !== '')).toBe(true);
    const extent = 12000;
    expect(Math.min(...bubbles.map((bubble) => bubble.radius))).toBeGreaterThanOrEqual(
      extent * 0.012 * 0.99,
    );
  });
});

describe('minScreenScale', () => {
  it('only enlarges text that would be smaller than the minimum', () => {
    expect(minScreenScale(100, 1, 11)).toBe(1);
    expect(minScreenScale(1, 0.01, 11)).toBeCloseTo(1100);
    expect(minScreenScale(0, 1, 11)).toBe(1);
  });
});
