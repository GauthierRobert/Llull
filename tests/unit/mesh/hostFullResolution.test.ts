/**
 * A host path that reads a document without `execute` (the FEA mesher, TECHNICAL_SPEC 13.21) gets the stored meshes of the asset-backed parts it names through the same reach
 * and cap as the commands, or a refusal by name. Display meshes here are 1-unit cubes and the stored meshes 10-unit cubes.
 */

import { describe, expect, it } from 'vitest';
import { fullResolutionView } from '@core/commands/meshHostView';
import { MESH_FULL_READ_TRIANGLE_CAP } from '@core/geometry/mesh/assets';
import type { CadDocument, MeshSolidEntity } from '@core/model/types';
import { expectPure } from '../../helpers/expectNoOp';
import { scene } from '../../helpers/assetScene';
import { execute } from '@core/commands/registry';

const edgeOf = (doc: CadDocument, id: string): number => Math.max(...(doc.entities[id] as MeshSolidEntity).mesh.positions);

describe('fullResolutionView', () => {
  it('puts the stored mesh of the parts it names in the view, and only those', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, { id: 'twin' }]);
    const view = fullResolutionView(doc, ['scan'], ctx.meshAssets);
    expect('code' in view).toBe(false);
    expect(edgeOf(view as CadDocument, 'scan')).toBe(10);
    expect(edgeOf(view as CadDocument, 'twin')).toBe(1);
    expect(edgeOf(doc, 'scan')).toBe(1);
  });

  it('reaches the component of an instance and the same document back when nothing named is asset-backed', () => {
    const { doc, ctx } = scene([{ id: 'scan' }]);
    const made = execute(doc, 'create_component', { name: 'Part', entityIds: ['scan'], componentId: 'comp-part' }, ctx);
    const inserted = execute(made.document, 'insert_instance', { componentId: 'comp-part', position: [0, 0, 0] }, ctx);
    const instance = inserted.affected[0] as string;
    const view = fullResolutionView(inserted.document, [instance], ctx.meshAssets) as CadDocument;
    const stored = Object.values(view.components['comp-part']?.entities ?? {}).find((entity) => entity.kind === 'mesh') as MeshSolidEntity;
    expect(Math.max(...stored.mesh.positions)).toBe(10);
    const plain = execute(createPlain(), 'add_box', { size: [1, 1, 1] }, ctx);
    expect(fullResolutionView(plain.document, plain.affected, ctx.meshAssets)).toBe(plain.document);
  });

  it('refuses by name a reach above the cap (distinct assets counted once) and an asset this machine does not hold', () => {
    const big = scene([
      { id: 'scan', claimed: MESH_FULL_READ_TRIANGLE_CAP },
      { id: 'twin', claimed: 1 },
    ]);
    expect(fullResolutionView(big.doc, ['scan', 'twin'], big.ctx.meshAssets)).toMatchObject({
      code: 'MESH_ASSET_TOO_LARGE',
      ids: ['scan', 'twin'],
    });
    const lost = scene([{ id: 'scan', held: false, claimed: 100 }]);
    expect(fullResolutionView(lost.doc, ['scan'], lost.ctx.meshAssets)).toMatchObject({ code: 'MESH_ASSET_LOD_ONLY', ids: ['scan'] });
    expect(fullResolutionView(lost.doc, ['scan'], null)).toMatchObject({ code: 'MESH_ASSET_LOD_ONLY' });
  });

  it('is pure', () => {
    const { doc, ctx } = scene([{ id: 'scan' }]);
    expectPure(doc, () => fullResolutionView(doc, ['scan'], ctx.meshAssets));
  });
});

function createPlain(): CadDocument {
  return scene([]).doc;
}

describe('fullResolutionView counts and checks what it swaps', () => {
  it('a mesh that a named entity only refers to is outside the cap and the view (a dimension naming a huge scan does not make the part too large)', () => {
    const { doc, ctx } = scene([{ id: 'scan', claimed: MESH_FULL_READ_TRIANGLE_CAP + 1, held: false }, { id: 'part' }]);
    const note = execute(doc, 'add_box', { size: [1, 1, 1] }, ctx);
    const box = note.affected[0] as string;
    const withRef = {
      ...note.document,
      entities: { ...note.document.entities, [box]: { ...(note.document.entities[box] as object), entityIds: ['scan'] } },
    } as CadDocument;
    const view = fullResolutionView(withRef, ['part', box], ctx.meshAssets);
    expect('code' in view).toBe(false);
    expect(edgeOf(view as CadDocument, 'part')).toBe(10);
    expect(edgeOf(view as CadDocument, 'scan')).toBe(1);
  });
});
