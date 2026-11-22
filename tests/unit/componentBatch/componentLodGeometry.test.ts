import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type Entity } from '@core/model/types';
import { buildBoxGeometry, buildCoarseGeometry } from '@ui/viewport/3d/componentBatch/componentLodGeometry';

function solid(command: string, params: Record<string, unknown>): Entity {
  const result = execute(createEmptyDocument(), command, params);
  const entity = result.document.entities[result.affected[0] ?? ''];
  if (entity === undefined) throw new Error(`no entity from ${command}`);
  return entity;
}

const triangles = (g: { getAttribute: (n: string) => { count: number } | undefined }): number =>
  (g.getAttribute('position')?.count ?? 0) / 3;

describe('buildCoarseGeometry', () => {
  it('decimates a large mesh child to well under its triangle count', () => {
    const sphere = solid('add_icosphere_mesh', { radius: 2, level: 4 }); // 5,120 triangles
    const coarse = buildCoarseGeometry(sphere);
    expect(coarse).toBeDefined();
    expect(triangles(coarse as never)).toBeGreaterThan(0);
    expect(triangles(coarse as never)).toBeLessThan(5120 / 2);
  });

  it('has no coarse mesh for a small mesh or a primitive', () => {
    expect(buildCoarseGeometry(solid('add_icosphere_mesh', { radius: 2, level: 1 }))).toBeUndefined();
    expect(buildCoarseGeometry(solid('add_box', { size: [1, 1, 1] }))).toBeUndefined();
  });
});

describe('buildBoxGeometry', () => {
  it('is the 12-triangle bounding box of the full geometry, same frame', () => {
    const full = new THREE.SphereGeometry(2, 16, 12).translate(10, 0, 0);
    const box = buildBoxGeometry(full);
    box.computeBoundingBox();
    expect((box.index?.count ?? 0) / 3).toBe(12);
    expect(box.boundingBox?.min.x).toBeCloseTo(8, 6);
    expect(box.boundingBox?.max.x).toBeCloseTo(12, 6);
  });

  it('is empty for an empty geometry', () => {
    expect(buildBoxGeometry(new THREE.BufferGeometry()).getAttribute('position')).toBeUndefined();
  });
});
