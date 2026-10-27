/**
 * TECHNICAL_SPEC 13.11 (round 3): an implicit field measures the triangles of a solid node's entity at compile time. For an asset-backed mesh
 * that is the stored mesh, not the display mesh: the body of a stored 10-cube has volume 1000, and it re-realises the same way on load.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { setMeshAssetPort } from '@core/geometry/mesh/assets';
import { implicitDocument } from '@implicit/document';
import { implicitOf } from '@implicit/model';
import type { CadDocument } from '@core/model/types';
import { scene } from '../../helpers/assetScene';
import { memoryMeshAssets } from '../../helpers/memoryMeshAssets';
import { cube } from '../../helpers/assetScene';

function body(): { doc: CadDocument; bodyId: string; assets: ReturnType<typeof memoryMeshAssets> } {
  const assets = memoryMeshAssets();
  const ref = assets.writeMesh(cube(10));
  const { doc, ctx } = scene([{ id: 'scan', full: 10 }]);
  const withRef = { ...doc, entities: { scan: { ...doc.entities['scan'], asset: ref } } } as CadDocument;
  const context = { ...ctx, meshAssets: assets };
  const field = execute(withRef, 'field_from_solid', { entityId: 'scan' }, context);
  const made = execute(field.document, 'create_implicit_body', { field: field.affected[0], voxel: 0.5 }, context);
  expect(made.rejected, made.summary).toBeUndefined();
  return { doc: made.document, bodyId: made.affected[0] as string, assets };
}

describe('an implicit body built on an asset-backed mesh', () => {
  it('is built from the stored mesh: volume 1000, not the display cube', () => {
    const { doc, bodyId, assets } = body();
    const properties = execute(doc, 'implicit_properties', { id: bodyId }, { ...scene([]).ctx, meshAssets: assets });
    expect(properties.rejected, properties.summary).toBeUndefined();
    const volume = (properties.data as { volume?: number }).volume;
    expect(volume).toBeGreaterThan(900);
    expect(volume).toBeLessThan(1100);
  });

  it('re-realises on load from the stored mesh (same hash), and stays stale by name without the asset', () => {
    const { doc, bodyId, assets } = body();
    const text = serializeDocument(doc);
    setMeshAssetPort(assets);
    const held = deserializeDocument(text);
    expect(Object.hasOwn(held.entities, bodyId)).toBe(true);
    expect(implicitOf(held).bodies[bodyId]?.contentHash).toBe(implicitOf(doc).bodies[bodyId]?.contentHash);
    setMeshAssetPort(memoryMeshAssets());
    const lacking = deserializeDocument(text);
    expect(Object.hasOwn(lacking.entities, bodyId)).toBe(false);
    expect(implicitOf(lacking).bodies[bodyId]?.contentHash).toBe(implicitOf(doc).bodies[bodyId]?.contentHash);
    const warning = implicitDocument.afterLoad?.(lacking)?.[0] ?? '';
    expect(warning).toContain('IMP_BODY_STALE');
    expect(warning).toContain('regenerate_implicit_bodies');
    expect(warning).toContain("'scan'");
  });
});

describe('the body stays listed while it is unrealised, so a file moved between machines loses nothing', () => {
  it('saved on a machine without the asset, loaded on one that holds it: the body is back, in place, with the same hash', () => {
    const { doc, bodyId, assets } = body();
    const text = serializeDocument(doc);
    setMeshAssetPort(memoryMeshAssets());
    const lacking = deserializeDocument(text);
    expect(lacking.order).toContain(bodyId);
    expect(Object.hasOwn(lacking.entities, bodyId)).toBe(false);
    const resaved = serializeDocument(lacking);
    setMeshAssetPort(assets);
    const back = deserializeDocument(resaved);
    expect(Object.hasOwn(back.entities, bodyId)).toBe(true);
    expect(back.order).toEqual(doc.order);
    expect(implicitOf(back).bodies[bodyId]?.contentHash).toBe(implicitOf(doc).bodies[bodyId]?.contentHash);
  });
});

describe('an implicit body built on an instance of a component holding an asset-backed mesh', () => {
  function instanceBody(): { doc: CadDocument; bodyId: string; assets: ReturnType<typeof memoryMeshAssets> } {
    const assets = memoryMeshAssets();
    const ref = assets.writeMesh(cube(10));
    const { doc, ctx } = scene([{ id: 'scan', full: 10 }]);
    const context = { ...ctx, meshAssets: assets };
    const withRef = { ...doc, entities: { scan: { ...doc.entities['scan'], asset: ref } } } as CadDocument;
    const made = execute(withRef, 'create_component', { name: 'part', entityIds: ['scan'] }, context);
    const field = execute(made.document, 'field_from_solid', { entityId: made.affected[0] }, context);
    const created = execute(field.document, 'create_implicit_body', { field: field.affected[0], voxel: 0.5 }, context);
    expect(created.rejected, created.summary).toBeUndefined();
    const volume = (execute(created.document, 'implicit_properties', { id: created.affected[0] }, context).data as { volume: number })
      .volume;
    expect(volume).toBeGreaterThan(900);
    return { doc: created.document, bodyId: created.affected[0] as string, assets };
  }

  it('re-realises on load from the stored mesh of the component entity (same hash), and stays stale by name without it', () => {
    const { doc, bodyId, assets } = instanceBody();
    const text = serializeDocument(doc);
    setMeshAssetPort(assets);
    const held = deserializeDocument(text);
    expect(implicitOf(held).bodies[bodyId]?.contentHash).toBe(implicitOf(doc).bodies[bodyId]?.contentHash);
    setMeshAssetPort(memoryMeshAssets());
    const lacking = deserializeDocument(text);
    expect(Object.hasOwn(lacking.entities, bodyId)).toBe(false);
    expect(implicitOf(lacking).bodies[bodyId]?.contentHash).toBe(implicitOf(doc).bodies[bodyId]?.contentHash);
    expect(implicitDocument.afterLoad?.(lacking)?.[0]).toContain('IMP_BODY_STALE');
  });
});
