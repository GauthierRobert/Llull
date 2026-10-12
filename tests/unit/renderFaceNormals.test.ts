import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { tessellateEntity } from '@core/commands/render/polygons';
import { centroid3, dot3, sub3 } from '@lib/vec3';

/** The single entity a primitive command adds to an empty document. */
function added(command: string, params: Record<string, unknown>): Entity {
  const doc = execute(createEmptyDocument(), command, params).document;
  const id = doc.order[0];
  if (id === undefined) throw new Error(`${command} added nothing`);
  const entity = doc.entities[id];
  if (entity === undefined) throw new Error(`${command} lost ${id}`);
  return entity;
}

// render_view Lambert-shades each face by its normal: an inward normal lights the hidden back
// faces and leaves the visible top / front at ambient.
describe('render_view face normals', () => {
  it.each([
    ['add_box', { size: [4, 3, 2], position: [10, -5, 1] }],
    ['add_wedge', { size: [4, 3, 2], position: [10, -5, 1] }],
  ])('%s faces point away from the solid', (command, params) => {
    const polygons = tessellateEntity(added(command, params));
    expect(polygons.length).toBeGreaterThan(0);
    const center = centroid3(polygons.flatMap((polygon) => polygon.verts));
    for (const polygon of polygons) {
      const outward = sub3(centroid3(polygon.verts), center);
      expect(dot3(polygon.normal, outward)).toBeGreaterThan(0);
    }
  });
});
