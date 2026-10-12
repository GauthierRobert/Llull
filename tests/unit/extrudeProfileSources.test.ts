/** extrude_profile: one command for inline points and for drawn sketches (id / ids). */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, ExtrusionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';

function withRectangle(position: [number, number, number]): { doc: CadDocument; id: string } {
  const drawn = execute(createEmptyDocument(), 'draw_rectangle', {
    width: 4,
    height: 2,
    position,
  });
  return { doc: drawn.document, id: drawn.affected[0]! };
}

describe('extrude_profile sources', () => {
  it('extrudes a drawn shape at the source position and keeps the source', () => {
    const { doc, id } = withRectangle([1, 2, 3]);
    const result = execute(doc, 'extrude_profile', { id, depth: 5 });
    const extrusion = result.document.entities[result.affected[0]!] as ExtrusionEntity;
    expect(extrusion.kind).toBe('extrusion');
    expect(extrusion.position).toEqual([1, 2, 3]);
    expect(extrusion.depth).toBe(5);
    expect(result.document.entities[id]).toBeDefined();
  });

  it('lets an explicit position and axis override the source placement', () => {
    const { doc, id } = withRectangle([1, 2, 3]);
    const result = execute(doc, 'extrude_profile', {
      id,
      depth: 5,
      position: [9, 9, 9],
      axis: [1, 0, 0],
    });
    const extrusion = result.document.entities[result.affected[0]!] as ExtrusionEntity;
    expect(extrusion.position).toEqual([9, 9, 9]);
    expect(extrusion.rotation).not.toEqual([0, 0, 0]);
  });

  it('extrudes an inline profile at position (default origin)', () => {
    const result = execute(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [0, 0],
        [4, 0],
        [2, 3],
      ],
      depth: 2,
    });
    const extrusion = result.document.entities[result.affected[0]!] as ExtrusionEntity;
    expect(extrusion.position).toEqual([0, 0, 0]);
    expect(result.summary).toContain('3-point profile');
  });

  it('is a no-op when more than one source is given', () => {
    const { doc, id } = withRectangle([0, 0, 0]);
    const both = execute(doc, 'extrude_profile', {
      id,
      profile: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      depth: 1,
    });
    expect(both.affected).toEqual([]);
    expect(both.document).toBe(doc);
    expect(both.summary).toContain('only one');
  });

  it('is a no-op for a zero-length axis on a sketch source', () => {
    const { doc, id } = withRectangle([0, 0, 0]);
    const result = execute(doc, 'extrude_profile', { id, depth: 1, axis: [0, 0, 0] });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });
});
