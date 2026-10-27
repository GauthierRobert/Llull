/**
 * TECHNICAL_SPEC 13.11: an entity's asset reference is valid only while its geometry is what the asset describes. scale_entity runs on the
 * stored mesh and writes a new asset; mirror_entity moves the entity without touching the mesh; a deformation makes a new mesh entity.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { runWithFullMeshes } from '@core/commands/meshAssetView';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { MESH_INLINE_TRIANGLE_CAP, setMeshAssetPort } from '@core/geometry/mesh/assets';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { newEntity } from '@core/commands/entity/newEntity';
import { type CadDocument, createEmptyDocument, type Entity, type MeshSolidEntity } from '@core/model/types';
import { bigScan } from '../../helpers/bigScan';
import { memoryMeshAssets } from '../../helpers/memoryMeshAssets';
import { cube, scene } from '../../helpers/assetScene';

const volumeOf = (data: unknown): number => (data as { volume: number }).volume;
const sizeOf = (data: unknown): number[] => (data as { size: number[] }).size;

describe('scale_entity on an asset-backed mesh', () => {
  const { doc, ctx, id, assets } = bigScan();
  const before = doc.entities[id] as MeshSolidEntity;
  const scaled = execute(doc, 'scale_entity', { id, factor: 2 }, ctx);
  const after = scaled.document.entities[id] as MeshSolidEntity;

  it('writes a new asset for the scaled triangles; bounds, mass and the display mesh agree with it', () => {
    expect(scaled.rejected, scaled.summary).toBeUndefined();
    expect(after.asset?.key).not.toBe(before.asset?.key);
    expect(after.asset?.triangles).toBe(before.asset?.triangles);
    const stored = assets.readMesh(after.asset?.key as string);
    expect(stored?.positions.length).toBe(assets.readMesh(before.asset?.key as string)?.positions.length as number);
    expect(after.asset?.bounds.max[0]).toBeCloseTo((before.asset?.bounds.max[0] as number) * 2, 9);
    const sizeBefore = sizeOf(execute(doc, 'measure_bounding_box', { entityId: id }, ctx).data);
    const sizeAfter = sizeOf(execute(scaled.document, 'measure_bounding_box', { entityId: id }, ctx).data);
    expect(sizeAfter[0]).toBeCloseTo((sizeBefore[0] as number) * 2, 9);
    const volumeBefore = volumeOf(execute(doc, 'mass_properties', { entityId: id }, ctx).data);
    const volumeAfter = volumeOf(execute(scaled.document, 'mass_properties', { entityId: id }, ctx).data);
    expect(volumeAfter / volumeBefore).toBeCloseTo(8, 6);
    expect(Math.max(...after.mesh.positions)).toBeCloseTo(Math.max(...before.mesh.positions) * 2, 9);
    expect(after.mesh.indices.length / 3).toBeLessThan(MESH_INLINE_TRIANGLE_CAP);
  });

  it('refuses by name without the asset, and replays to the same document', () => {
    const lacking: ExecutionContext = { ...defaultContext(), meshAssets: memoryMeshAssets() };
    const refused = execute(doc, 'scale_entity', { id, factor: 2 }, lacking);
    expect(refused.error?.code).toBe('MESH_ASSET_LOD_ONLY');
    expect(refused.document).toBe(doc);
    const replayed = execute(scaled.document, 'replay_history', {}, ctx);
    expect(replayed.document.entities).toEqual(scaled.document.entities);
  });
});

describe('the other edits of an asset-backed mesh', () => {
  it('mirror_entity moves the entity and keeps the mesh and the asset; the bounds follow the position', () => {
    const { doc, ctx } = scene([{ id: 'scan' }]);
    const moved = execute(
      { ...doc, entities: { scan: { ...(doc.entities['scan'] as MeshSolidEntity), position: [5, 0, 0] } } },
      'mirror_entity',
      { id: 'scan', axis: 'x' },
      ctx,
    );
    const after = moved.document.entities['scan'] as MeshSolidEntity;
    expect(after.asset).toBe((doc.entities['scan'] as MeshSolidEntity).asset);
    expect(after.mesh).toBe((doc.entities['scan'] as MeshSolidEntity).mesh);
    expect(after.position).toEqual([-5, 0, 0]);
    expect((execute(moved.document, 'measure_bounding_box', { entityId: 'scan' }, ctx).data as { min: number[] }).min[0]).toBe(-5);
  });

  it('a deformation reads the stored mesh and makes a new mesh entity with no asset to go stale', () => {
    const { doc, ctx } = scene([{ id: 'scan' }]);
    const result = execute(doc, 'scale_nonuniform', { id: 'scan', factors: [2, 1, 1] }, ctx);
    expect(result.rejected, result.summary).toBeUndefined();
    const made = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    expect(made.asset).toBeUndefined();
    expect(volumeOf(execute(result.document, 'mass_properties', { entityId: made.id }, ctx).data)).toBeCloseTo(2000, 4);
  });
});

describe('a recorded asset reference is checked against the store at load', () => {
  const build = (): { text: string; tamper: (bounds: number) => string } => {
    const assets = memoryMeshAssets();
    setMeshAssetPort(assets);
    const ref = assets.writeMesh(cube(10));
    const entity = newEntity('mesh', 'scan', { mesh: cube(1), asset: ref }, [0, 0, 0], '#cccccc');
    const doc: CadDocument = { ...createEmptyDocument(), entities: { scan: entity }, order: ['scan'] };
    const withBounds = (max: number): string =>
      serializeDocument({
        ...doc,
        entities: {
          scan: { ...entity, asset: { ...ref, bounds: { min: ref.bounds.min, max: [max, max, max] } } },
        } as CadDocument['entities'],
      });
    return { text: serializeDocument(doc), tamper: withBounds };
  };

  it('loads a true reference, refuses one whose bounds disagree with the store by name, and trusts it where the asset is not held', () => {
    const { text, tamper } = build();
    expect(() => deserializeDocument(text)).not.toThrow();
    expect(() => deserializeDocument(tamper(99))).toThrow(/MESH_ASSET_REF_MISMATCH/);
    setMeshAssetPort(null);
    expect(() => deserializeDocument(tamper(99))).not.toThrow();
  });
});

describe('a scaled instance of a component holding an asset-backed mesh', () => {
  it('expands through the stored mesh (volume x8) and takes its bounds from the asset bounds (size x2)', () => {
    const { doc, ctx } = scene([{ id: 'scan' }]);
    const made = execute(doc, 'create_component', { name: 'part', entityIds: ['scan'] }, ctx);
    const instanceId = made.affected[0] as string;
    const instance = made.document.entities[instanceId] as Entity;
    const scaled: CadDocument = { ...made.document, entities: { [instanceId]: { ...instance, scale: [2, 2, 2] } as Entity } };
    expect(volumeOf(execute(scaled, 'mass_properties', { entityId: instanceId }, ctx).data)).toBeCloseTo(8000, 4);
    expect(sizeOf(execute(scaled, 'measure_bounding_box', { entityId: instanceId }, ctx).data)[0]).toBeCloseTo(20, 9);
  });
});

describe('explode_instance on a component holding a stored mesh', () => {
  const { doc, ctx, id, assets } = bigScan();
  const made = execute(doc, 'create_component', { name: 'part', entityIds: [id] }, ctx);
  const instanceId = made.affected[0] as string;
  const withScale = (scale: [number, number, number]): CadDocument => ({
    ...made.document,
    entities: { [instanceId]: { ...(made.document.entities[instanceId] as Entity), scale } as Entity },
  });
  const volume = (document: CadDocument, entityId: string): number =>
    volumeOf(execute(document, 'mass_properties', { entityId }, ctx).data);

  it.each([
    ['uniform [2,2,2]', [2, 2, 2] as [number, number, number], 8],
    ['non-uniform [2,1,1] (baked)', [2, 1, 1] as [number, number, number], 2],
  ])(
    'a %s instance explodes into a stored asset: same volume, bounds that match its mesh, display mesh in the document',
    (_name, scale, factor) => {
      const instance = withScale(scale);
      const expected = volume(instance, instanceId);
      const unscaled = volume(withScale([1, 1, 1]), instanceId);
      expect(expected / unscaled).toBeCloseTo(factor, 6);
      const exploded = execute(instance, 'explode_instance', { id: instanceId }, ctx);
      expect(exploded.rejected, exploded.summary).toBeUndefined();
      const part = exploded.document.entities[exploded.affected[0] as string] as MeshSolidEntity;
      expect(part.asset?.triangles).toBe(327680);
      expect(part.mesh.indices.length / 3).toBeLessThan(MESH_INLINE_TRIANGLE_CAP);
      expect(volume(exploded.document, part.id) / expected).toBeCloseTo(1, 9);
      const stored = assets.readMesh(part.asset?.key as string);
      const bounds = part.asset?.bounds;
      const xs = stored?.positions.filter((_, index) => index % 3 === 0) ?? [];
      expect(xs.reduce((a, b) => Math.max(a, b), -Infinity)).toBeCloseTo(bounds?.max[0] as number, 9);
      expect(xs.reduce((a, b) => Math.min(a, b), Infinity)).toBeCloseTo(bounds?.min[0] as number, 9);
    },
  );

  it('an unscaled instance keeps the asset of the component entity and the display mesh', () => {
    const exploded = execute(withScale([1, 1, 1]), 'explode_instance', { id: instanceId }, ctx);
    const part = exploded.document.entities[exploded.affected[0] as string] as MeshSolidEntity;
    expect(part.asset?.key).toBe((doc.entities[id] as MeshSolidEntity).asset?.key);
    expect(part.mesh.indices.length / 3).toBeLessThan(MESH_INLINE_TRIANGLE_CAP);
  });

  it('refuses by name without the store, and replays to the same document', () => {
    const lacking: ExecutionContext = { ...defaultContext(), meshAssets: memoryMeshAssets() };
    const refused = execute(withScale([2, 2, 2]), 'explode_instance', { id: instanceId }, lacking);
    expect(refused.error?.code).toBe('MESH_ASSET_LOD_ONLY');
  });
});

describe('a new entity built from the stored mesh of the view', () => {
  const { doc, ctx, id } = bigScan();
  const source = doc.entities[id] as MeshSolidEntity;
  const probe = (build: (view: MeshSolidEntity) => MeshSolidEntity): MeshSolidEntity => {
    const result = runWithFullMeshes(doc, 'probe', { target: id }, ctx, false, false, (view) => {
      const copy = build(view.entities[id] as MeshSolidEntity);
      return {
        document: { ...view, entities: { ...view.entities, copy }, order: [...view.order, 'copy'] },
        summary: 'ok',
        affected: ['copy'],
      };
    });
    expect(result.rejected, result.summary).toBeUndefined();
    return result.document.entities['copy'] as MeshSolidEntity;
  };

  it('a copy that keeps the asset gets the display mesh back', () => {
    const copy = probe((view) => ({ ...view, id: 'copy' }));
    expect(copy.asset?.key).toBe(source.asset?.key);
    expect(copy.mesh).toBe(source.mesh);
  });

  it('a copy that holds the stored mesh without its asset is written through the store: the asset and the display mesh come back', () => {
    const copy = probe((view) => {
      const { asset: _asset, ...bare } = view;
      void _asset;
      return { ...bare, id: 'copy' };
    });
    expect(copy.asset?.key).toBe(source.asset?.key);
    expect(copy.mesh.indices.length / 3).toBeLessThan(MESH_INLINE_TRIANGLE_CAP);
  });

  it('a copy that holds the stored mesh under the asset of another mesh is re-stored under the right one', () => {
    const copy = probe((view) => ({
      ...view,
      id: 'copy',
      asset: { ...(source.asset as NonNullable<typeof source.asset>), key: 'c'.repeat(64) },
    }));
    expect(copy.asset?.key).toBe(source.asset?.key);
    expect(copy.mesh.indices.length / 3).toBeLessThan(MESH_INLINE_TRIANGLE_CAP);
  });
});

describe('explode_instance of an instance that only places its component', () => {
  it('explodes wherever the document is, also when the asset is not held, and keeps the asset', () => {
    const { doc, ctx, id } = bigScan();
    const made = execute(doc, 'create_component', { name: 'part', entityIds: [id] }, ctx);
    const instanceId = made.affected[0] as string;
    const lacking: ExecutionContext = { ...defaultContext(), meshAssets: memoryMeshAssets() };
    for (const scale of [undefined, [1, 1, 1]] as const) {
      const instance = made.document.entities[instanceId] as Entity;
      const placed: CadDocument = {
        ...made.document,
        entities: { [instanceId]: (scale === undefined ? instance : { ...instance, scale }) as Entity },
      };
      const exploded = execute(placed, 'explode_instance', { id: instanceId }, lacking);
      expect(exploded.rejected, exploded.summary).toBeUndefined();
      const part = exploded.document.entities[exploded.affected[0] as string] as MeshSolidEntity;
      expect(part.asset?.key).toBe((doc.entities[id] as MeshSolidEntity).asset?.key);
      expect(part.mesh.indices.length / 3).toBeLessThan(MESH_INLINE_TRIANGLE_CAP);
    }
    const scaled: CadDocument = {
      ...made.document,
      entities: { [instanceId]: { ...(made.document.entities[instanceId] as Entity), scale: [2, 1, 1] } as Entity },
    };
    expect(execute(scaled, 'explode_instance', { id: instanceId }, lacking).error?.code).toBe('MESH_ASSET_LOD_ONLY');
  });
});
