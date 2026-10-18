import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { bracket } from './helpers';
import { apply, expectRefusal, ok } from '../../../helpers/commandAssertions';

describe('materialize_flat_pattern', () => {
  it('draws the outline, cutouts and bend lines as plain 2D entities on FLAT layers', () => {
    const { doc, part } = bracket();
    const circle = ok(doc, 'draw_arc', { center: [10, 25], radius: 4 });
    const cut = apply(circle.document, 'add_sheet_cutout', { id: part, face: { near: [10, 25, 0] }, profileId: circle.affected[0] });
    const result = ok(cut, 'materialize_flat_pattern', { id: part });
    expect(result.affected).toHaveLength(3);
    const entities = result.affected.map((id) => result.document.entities[id]);
    expect(entities.map((entity) => entity?.kind)).toEqual(['polyline', 'circle', 'line']);
    expect(entities.map((entity) => result.document.layers[entity?.layerId ?? '']?.name)).toEqual([
      `FLAT-${part}`,
      `FLAT-${part}-CUT`,
      `FLAT-${part}-BEND-UP`,
    ]);
    expect(entities.every((entity) => entity?.tags?.includes(`flatpattern:${part}`))).toBe(true);
    const outline = entities[0];
    expect(outline?.kind === 'polyline' && outline.closed).toBe(true);
    expect(outline?.position[0]).toBeGreaterThan(40);
    expect(result.summary).toContain('not approved');
  });

  it('replaces the previous snapshot of the same part and honours origin', () => {
    const { doc, part } = bracket();
    const first = ok(doc, 'materialize_flat_pattern', { id: part });
    const second = ok(first.document, 'materialize_flat_pattern', { id: part, origin: [0, -100] });
    expect(Object.values(second.document.entities).filter((entity) => entity.tags?.includes(`flatpattern:${part}`))).toHaveLength(2);
    const outline = second.document.entities[second.affected[0] as string];
    expect(outline?.position).toEqual([0, -100, 0]);
    expect(first.affected.some((id) => second.document.entities[id] !== undefined)).toBe(false);
  });

  it('leaves the part untouched, is pure and refuses unknown parts', () => {
    const { doc, part } = bracket();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'materialize_flat_pattern', { id: part });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document.sheetMetal).toBe(doc.sheetMetal);
    expect(result.document.entities[part]).toBe(doc.entities[part]);
    expectRefusal(createEmptyDocument(), 'materialize_flat_pattern', { id: 'nope' }, 'FTR_PART_NOT_FOUND', 'id');
  });
});
