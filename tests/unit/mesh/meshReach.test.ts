/**
 * 07 MSH FR-MSH-02, TECHNICAL_SPEC 13.11: a command that reads triangles sees the full-resolution asset of every mesh its params reach,
 * not only the ones they name by id. Display meshes here are 1-unit cubes and the stored meshes 10-unit cubes, so every result differs
 * between the two.
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { runWithFullMeshes } from '@core/commands/meshAssetView';
import { execute } from '@core/commands/registry';
import { newEntity } from '@core/commands/entity/newEntity';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { MESH_FULL_READ_TRIANGLE_CAP } from '@core/geometry/mesh/assets';
import { type CadDocument, createEmptyDocument, type Entity, type MeshSolidEntity } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { fastMeasure } from '@core/geometry/mesh/fastMeasure';
import { icosphere } from '../../helpers/meshFixtures';
import { memoryMeshAssets } from '../../helpers/memoryMeshAssets';
import { cube, scene, type Backed } from '../../helpers/assetScene';
import { caseParams, ok, prepare } from '../aero/cfd/fixtures';
import { fakeKernel, TETRA } from '../../helpers/fakeKernel';
import { exactFacePoint } from '@design/anchors';

const sizeOf = (result: CommandResult): number => (result.data as { size: number[] }).size[0] as number;
const bbox = (doc: CadDocument, ctx: ExecutionContext, params: object): CommandResult => execute(doc, 'measure_bounding_box', params, ctx);
const mass = (doc: CadDocument, ctx: ExecutionContext, entityId: string): CommandResult =>
  execute(doc, 'mass_properties', { entityId }, ctx);
const volumeOf = (result: CommandResult): number => (result.data as { volume: number }).volume;

/** Edge of the mesh `view` holds in the slot of each id (1 = the display cube, 10 = the stored one). */
function seenBy(doc: CadDocument, ctx: ExecutionContext, params: object, whole = false): Record<string, number> | CommandResult {
  const seen: Record<string, number> = {};
  const result = runWithFullMeshes(doc, 'probe', params, ctx, whole, false, (view) => {
    for (const [id, entity] of Object.entries(view.entities)) if (entity.kind === 'mesh') seen[id] = Math.max(...entity.mesh.positions);
    for (const component of Object.values(view.components))
      for (const [id, entity] of Object.entries(component.entities))
        if (entity.kind === 'mesh') seen[`${component.id}/${id}`] = Math.max(...entity.mesh.positions);
    return { document: view, summary: 'ok', affected: [] };
  });
  return result.rejected === true || result.error !== undefined ? result : seen;
}

describe('a named entity (baseline)', () => {
  it('mass_properties on the id reads the stored mesh, and leaves the display mesh in the document', () => {
    const { doc, ctx } = scene([{ id: 'scan' }]);
    const result = mass(doc, ctx, 'scan');
    expect(volumeOf(result)).toBeCloseTo(1000, 6);
    expect(result.document).toBe(doc);
    expect(Math.max(...(doc.entities['scan'] as MeshSolidEntity).mesh.positions)).toBe(1);
  });

  it('measure_bounding_box answers from the bounds of the asset, with no read of it and no cap', () => {
    const { doc, ctx } = scene([{ id: 'scan', claimed: MESH_FULL_READ_TRIANGLE_CAP * 2 }]);
    const reads: string[] = [];
    const port = ctx.meshAssets as NonNullable<ExecutionContext['meshAssets']>;
    const counting: ExecutionContext = {
      ...ctx,
      meshAssets: {
        ...port,
        readMesh: (key) => {
          reads.push(key);
          return port.readMesh(key);
        },
      },
    };
    expect(sizeOf(bbox(doc, counting, { entityId: 'scan' }))).toBe(10);
    expect(sizeOf(bbox(doc, counting, {}))).toBe(10);
    expect(reads).toEqual([]);
  });
});

describe('through the current selection and the default scope', () => {
  it('a selection-driven or param-less command reads every asset (the selection is a subset); a whole-document command ignores the params', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, { id: 'twin' }]);
    const selected = { ...doc, selection: ['scan'] };
    expect(seenBy(selected, ctx, { useSelection: true })).toEqual({ scan: 10, twin: 10 });
    expect(seenBy(selected, ctx, {})).toEqual({ scan: 10, twin: 10 });
    expect(seenBy(selected, ctx, { entityId: 'scan' }, true)).toEqual({ scan: 10, twin: 10 });
    expect(seenBy(selected, ctx, { entityId: 'scan' })).toEqual({ scan: 10, twin: 1 });
  });
});

describe('through an instance and its component', () => {
  const made = (): { doc: CadDocument; ctx: ExecutionContext; instance: string } => {
    const { doc, ctx } = scene([{ id: 'scan' }]);
    const created = execute(doc, 'create_component', { name: 'part', entityIds: ['scan'] }, ctx);
    return { doc: created.document, ctx, instance: created.affected[0] as string };
  };

  it('mass_properties of the instance reads the stored mesh of the component entity, measure_bounding_box its bounds', () => {
    const { doc, ctx, instance } = made();
    expect(Object.keys(doc.entities)).toEqual([instance]);
    expect(sizeOf(bbox(doc, ctx, { entityId: instance }))).toBe(10);
    const measured = mass(doc, ctx, instance);
    expect(volumeOf(measured)).toBeCloseTo(1000, 6);
    expect(measured.document).toBe(doc);
  });

  it('a mutating reader on the instance gets the stored mesh and the display mesh is back in the component afterwards', () => {
    const { doc, ctx, instance } = made();
    const componentId = Object.keys(doc.components)[0] as string;
    const display = (doc.components[componentId]?.entities['scan'] as MeshSolidEntity).mesh;
    let during = 0;
    expectPure(doc, () => {
      const result = runWithFullMeshes(doc, 'probe', { target: instance }, ctx, false, false, (view) => {
        during = Math.max(...(view.components[componentId]?.entities['scan'] as MeshSolidEntity).mesh.positions);
        return { document: { ...view, nextStepNumber: 99 }, summary: 'ok', affected: [instance] };
      });
      expect(result.document.nextStepNumber).toBe(99);
      expect((result.document.components[componentId]?.entities['scan'] as MeshSolidEntity).mesh).toBe(display);
    });
    expect(during).toBe(10);
  });

  it('a component id and the nested instance of a component reach the entity inside', () => {
    const { doc, ctx } = made();
    const componentId = Object.keys(doc.components)[0] as string;
    expect(seenBy(doc, ctx, { componentId })).toEqual({ [`${componentId}/scan`]: 10 });
    const outer = execute(doc, 'create_component', { name: 'outer', entityIds: Object.keys(doc.entities) }, ctx);
    expect(seenBy(outer.document, ctx, { target: outer.affected[0] })).toEqual({ [`${componentId}/scan`]: 10 });
  });

  it('refuses by name when the asset inside a component cannot be read', () => {
    const { doc, instance } = made();
    const empty: ExecutionContext = { ...defaultContext(), meshAssets: memoryMeshAssets() };
    const result = mass(doc, empty, instance);
    expect(result.error).toBeUndefined();
    expect((result.data as { lodOnly?: string[] }).lodOnly).toEqual(['scan']);
    expect(result.summary).toContain('MESH_ASSET_LOD_ONLY');
    expect(result.document).toBe(doc);
  });
});

describe('through a group, a layer, a reference between entities and a record', () => {
  const unrelated: Backed = { id: 'ghost', held: false };

  it('a group id reaches its members, not the other assets', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, { id: 'twin' }, unrelated]);
    const grouped = execute(doc, 'group_entities', { ids: ['scan', 'twin'] }, ctx);
    const groupId = Object.keys(grouped.document.groups)[0] as string;
    expect(seenBy(grouped.document, ctx, { target: groupId })).toEqual({ scan: 10, twin: 10, ghost: 1 });
    expect(seenBy(grouped.document, ctx, { entityIds: [groupId] })).toEqual({ scan: 10, twin: 10, ghost: 1 });
  });

  it('a layer id reaches the entities on that layer', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, unrelated]);
    const onLayer = {
      ...doc,
      layers: { ...doc.layers, L2: { id: 'L2', name: 'Scans', visible: true, locked: false } },
      entities: { ...doc.entities, scan: { ...(doc.entities['scan'] as Entity), layerId: 'L2' } },
    };
    expect(seenBy(onLayer, ctx, { layer: 'L2' })).toEqual({ scan: 10, ghost: 1 });
  });

  it('an entity that refers to another (a dimension) reaches the referred mesh', () => {
    const dimension = newEntity('dimension', 'dim', { dimensionKind: 'linear', entityIds: ['scan'] }, [0, 0, 0], '#ffffff');
    const { doc, ctx } = scene([{ id: 'scan' }, unrelated], [dimension]);
    expect(sizeOf(bbox(doc, ctx, { entityId: 'dim' }))).toBe(20);
    expect(seenBy(doc, ctx, { entityId: 'dim' })).toEqual({ scan: 10, ghost: 1 });
  });

  it('the id of a plugin record that names entities (a CFD case) reaches them: prepare_cfd_case measures the stored body', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, unrelated]);
    const withCase = ok(doc, 'create_cfd_case', caseParams(['scan']), ctx).document;
    const full = prepare(withCase, {}, ctx);
    const reference = scene([{ id: 'scan', full: 1 }]);
    const display = prepare(ok(reference.doc, 'create_cfd_case', caseParams(['scan']), reference.ctx).document, {}, reference.ctx);
    expect(full.frontalAreaM2).toBeCloseTo(100, 6);
    expect(display.frontalAreaM2).toBeCloseTo(1, 6);
    expect(seenBy(withCase, ctx, { caseId: 'c1' })).toEqual({ scan: 10, ghost: 1 });
  });

  it('a params key that is an entity id counts (map-shaped params)', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, unrelated]);
    expect(seenBy(doc, ctx, { perEntity: { scan: { gain: 2 } } })).toEqual({ scan: 10, ghost: 1 });
  });

  it('naming a non-mesh entity reaches no asset, and a prototype key is not an id', () => {
    const box = newEntity('box', 'box-1', { size: [1, 1, 1] }, [0, 0, 0], '#ffffff');
    const { doc, ctx } = scene([unrelated], [box]);
    expect(seenBy(doc, ctx, { entityId: 'box-1', other: 'constructor', key: '__proto__' })).toEqual({ ghost: 1 });
  });

  it('with no param naming anything every asset is read, and an unreadable one refuses by name', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, unrelated]);
    const result = seenBy(doc, ctx, { unit: 'mm' }) as CommandResult;
    expectNoOp(result, doc);
    expect(result.error?.code).toBe('MESH_ASSET_LOD_ONLY');
    expect(result.error?.ids).toEqual(['ghost']);
  });
});

describe('a plan reference', () => {
  it('build_project resolves $alias to the instance, and the step reads the stored mesh', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, { id: 'ghost', held: false }]);
    const plan = execute(
      doc,
      'build_project',
      {
        actions: [
          { command: 'create_component', params: { name: 'part', entityIds: ['scan'] }, as: 'inst' },
          { command: 'mass_properties', params: { entityId: '$inst' } },
        ],
      },
      ctx,
    );
    expect(plan.summary).not.toContain('MESH_ASSET_LOD_ONLY');
    expect(Number(/"volume":([0-9.e+-]+)/.exec(JSON.stringify(plan.data))?.[1])).toBeCloseTo(1000, 6);
  });
});

describe('a reach too large to load', () => {
  const huge = MESH_FULL_READ_TRIANGLE_CAP + 1;

  it('refuses the named mesh by name and leaves the document alone', () => {
    const { doc, ctx } = scene([{ id: 'big', claimed: huge }, { id: 'small' }]);
    const result = mass(doc, ctx, 'big');
    expectNoOp(result, doc);
    expect(result.error?.code).toBe('MESH_ASSET_TOO_LARGE');
    expect(result.error?.ids).toEqual(['big']);
    expect(result.summary).toContain("entity 'big' (16000001 triangles)");
    expect(volumeOf(mass(doc, ctx, 'small'))).toBeCloseTo(1000, 6);
  });

  it('counts the sum over the reach, once per asset, and names every mesh of it', () => {
    const half = MESH_FULL_READ_TRIANGLE_CAP / 2 + 1;
    const { doc, ctx } = scene([
      { id: 'a', claimed: half },
      { id: 'b', claimed: half },
    ]);
    const both = seenBy(doc, ctx, {}) as CommandResult;
    expect(both.error?.code).toBe('MESH_ASSET_TOO_LARGE');
    expect(both.error?.ids).toEqual(['a', 'b']);
    expect(volumeOf(mass(doc, ctx, 'a'))).toBeCloseTo(1000, 6);
    const alike = {
      ...doc,
      entities: {
        ...doc.entities,
        b: { ...(doc.entities['b'] as MeshSolidEntity), asset: (doc.entities['a'] as MeshSolidEntity).asset } as Entity,
      },
    };
    expect(seenBy(alike, ctx, {})).toEqual({ a: 10, b: 10 });
  });

  it('three imports of 1.5 million triangles each are an ordinary whole-document read', () => {
    const { doc, ctx } = scene([1, 2, 3].map((n) => ({ id: `scan${n}`, claimed: 1_500_000 })));
    expect(sizeOf(bbox(doc, ctx, {}))).toBe(10);
    expect(seenBy(doc, ctx, {})).toEqual({ scan1: 10, scan2: 10, scan3: 10 });
  });
});

describe('replay', () => {
  it('replay_history of an instance made from an asset gives the same document, and mass_properties of it is the stored volume before and after', () => {
    const assets = memoryMeshAssets();
    const ctx: ExecutionContext = { ...defaultContext(), meshAssets: assets };
    const sphere = icosphere(10, 7);
    const triangles = sphere.indices.length / 3;
    const bytes = new Uint8Array(84 + triangles * 50);
    const view = new DataView(bytes.buffer);
    view.setUint32(80, triangles, true);
    for (let t = 0; t < triangles; t++)
      for (let k = 0; k < 3; k++)
        for (let a = 0; a < 3; a++)
          view.setFloat32(
            84 + t * 50 + 12 + k * 12 + a * 4,
            sphere.positions[(sphere.indices[t * 3 + k] as number) * 3 + a] as number,
            true,
          );
    const imported = execute(createEmptyDocument(), 'import_mesh_file', { fileKey: assets.putFile(bytes), units: 'mm', name: 'scan' }, ctx);
    const scanId = imported.affected[0] as string;
    const display = (imported.document.entities[scanId] as MeshSolidEntity).mesh;
    const made = execute(imported.document, 'create_component', { name: 'part', entityIds: [scanId] }, ctx);
    const instance = made.affected[0] as string;
    const volumeOf = (document: CadDocument): number =>
      (execute(document, 'mass_properties', { entityId: instance }, ctx).data as { volume: number }).volume;
    const stored = fastMeasure(sphere).volume as number;
    expect(Math.abs(volumeOf(made.document) - stored) / stored).toBeLessThan(1e-6);
    expect(Math.abs((fastMeasure(display).volume as number) - stored) / stored).toBeGreaterThan(1e-6);
    const replayed = execute(made.document, 'replay_history', {}, ctx);
    expect(replayed.error).toBeUndefined();
    expect(replayed.document.featureHistory.map((step) => step.name)).toEqual(['import_mesh_file', 'create_component']);
    expect(replayed.document.entities).toEqual(made.document.entities);
    expect(replayed.document.components).toEqual(made.document.components);
    expect(volumeOf(replayed.document)).toBe(volumeOf(made.document));
  });
});

describe('only real records name entities (the superset invariant)', () => {
  const box = newEntity('box', 'box-1', { size: [1, 1, 1] }, [0, 0, 0], '#ffffff');
  const withSlice = (doc: CadDocument, slice: object): CadDocument => ({ ...doc, plugin: slice }) as unknown as CadDocument;

  it('a param value equal to a nested key of a slice does not shrink the default scope; a real record is followed', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, { id: 'twin' }], [box]);
    const nested = withSlice(doc, { x: { settings: { entityIds: ['box-1'] } } });
    expect(seenBy(nested, ctx, { mode: 'settings' })).toEqual({ scan: 10, twin: 10 });
    const real = withSlice(doc, { cases: { c1: { id: 'c1', entityIds: ['scan'] } } });
    expect(seenBy(real, ctx, { caseId: 'c1' })).toEqual({ scan: 10, twin: 1 });
  });

  it('an item of an array of records is found by its id: a drawing view reaches its entityIds', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, { id: 'twin' }]);
    const sheet = execute(doc, 'create_sheet', { name: 'A' }, ctx);
    const view = execute(
      sheet.document,
      'create_drawing_view',
      { sheetId: sheet.affected[0], direction: 'front', entityIds: ['scan'] },
      ctx,
    );
    expect(view.affected).toHaveLength(1);
    expect(seenBy(view.document, ctx, { viewId: view.affected[0] })).toEqual({ scan: 10, twin: 1 });
  });

  it('a long numeric array in a named record is not walked', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, { id: 'twin' }]);
    let reads = 0;
    const samples = new Proxy(new Array<number>(1_000_000).fill(1), {
      get(target, key, receiver): unknown {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const big = withSlice(doc, { recs: { r1: { id: 'r1', samples, entityIds: ['scan'] } } });
    expect(seenBy(big, ctx, { recordId: 'r1', typed: new Float64Array(1_000_000) })).toEqual({ scan: 10, twin: 1 });
    expect(reads).toBeLessThan(10);
  });
});

describe('drawings', () => {
  const sheetSvg = (doc: CadDocument, ctx: ExecutionContext): CommandResult => {
    const sheet = execute(doc, 'create_sheet', { name: 'A' }, ctx);
    const sheetId = sheet.affected[0] as string;
    const view = execute(sheet.document, 'create_drawing_view', { sheetId, direction: 'front' }, ctx);
    return execute(view.document, 'export_sheet_svg', { sheetId }, ctx);
  };
  const inlineCube = (size: number): CadDocument => scene([], [newEntity('mesh', 'scan', { mesh: cube(size) }, [0, 0, 0], '#cccccc')]).doc;

  it('creating a view reads no triangle: it succeeds when this machine lacks an asset', () => {
    const { doc, ctx } = scene([{ id: 'ghost', held: false }]);
    const sheet = execute(doc, 'create_sheet', { name: 'A' }, ctx);
    const view = execute(sheet.document, 'create_drawing_view', { sheetId: sheet.affected[0], direction: 'front' }, ctx);
    expect(view.rejected).toBeUndefined();
    expect(view.affected).toHaveLength(1);
    const section = execute(view.document, 'add_section_view', { sheetId: sheet.affected[0], direction: 'right', offset: 0 }, ctx);
    expect(section.rejected).toBeUndefined();
    const exported = execute(view.document, 'export_sheet_svg', { sheetId: sheet.affected[0] }, ctx);
    expect(exported.error?.code).toBe('MESH_ASSET_LOD_ONLY');
  });

  it('export_sheet_svg reaches the whole document only when a view shows every solid; otherwise the listed ids', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, { id: 'ghost', held: false }]);
    const sheet = execute(doc, 'create_sheet', { name: 'A' }, ctx);
    const sheetId = sheet.affected[0] as string;
    const listed = execute(sheet.document, 'create_drawing_view', { sheetId, direction: 'front', entityIds: ['scan'] }, ctx);
    const sheetOf = (d: CadDocument): number => d.drawings?.sheets[sheetId]?.views.length ?? 0;
    const onlyListed = {
      ...listed.document,
      drawings: {
        ...listed.document.drawings!,
        sheets: {
          [sheetId]: {
            ...listed.document.drawings!.sheets[sheetId]!,
            views: listed.document.drawings!.sheets[sheetId]!.views.filter((view) => view.entityIds !== undefined),
          },
        },
      },
    } as CadDocument;
    expect(sheetOf(onlyListed)).toBe(1);
    expect(execute(onlyListed, 'export_sheet_svg', { sheetId }, ctx).error).toBeUndefined();
    const everySolid = execute(onlyListed, 'create_drawing_view', { sheetId, direction: 'top' }, ctx);
    expect(execute(everySolid.document, 'export_sheet_svg', { sheetId }, ctx).error?.code).toBe('MESH_ASSET_LOD_ONLY');
  });

  it('export_sheet_svg of a stored-10 / display-1 cube draws the stored outline', () => {
    const { doc, ctx } = scene([{ id: 'scan' }]);
    const stored = (sheetSvg(doc, ctx).data as { svg: string }).svg;
    const reference = (sheetSvg(inlineCube(10), ctx).data as { svg: string }).svg;
    const display = (sheetSvg(inlineCube(1), ctx).data as { svg: string }).svg;
    expect(stored).toBe(reference);
    expect(stored).not.toBe(display);
  });
});

describe('exporting an instance', () => {
  const sphere = icosphere(10, 2); // 320 triangles stored, 12 in the display cube
  const made = (): { doc: CadDocument; ctx: ExecutionContext; instance: string } => {
    const { doc, ctx } = scene([{ id: 'scan', fullMesh: sphere, claimed: 320 }]);
    const created = execute(doc, 'create_component', { name: 'part', entityIds: ['scan'] }, ctx);
    return { doc: created.document, ctx, instance: created.affected[0] as string };
  };

  it('writes the stored triangles of the component entities, in every format', () => {
    const { doc, ctx, instance } = made();
    const params = { entityIds: [instance] };
    expect((execute(doc, 'export_stl', { ...params, format: 'binary' }, ctx).data as { triangleCount: number }).triangleCount).toBe(320);
    expect(execute(doc, 'export_obj', params, ctx).summary).toContain('320 triangles');
    expect(execute(doc, 'export_3mf', params, ctx).summary).toContain('320');
    expect(execute(doc, 'export_gltf', { ...params, binary: true }, ctx).summary).toContain('320 triangles');
  });

  it('refuses by code when the asset of a component entity cannot be read', () => {
    const { doc, instance } = made();
    const params = { entityIds: [instance] };
    const empty: ExecutionContext = { ...defaultContext(), meshAssets: memoryMeshAssets() };
    const none: ExecutionContext = { ...defaultContext(), meshAssets: null };
    for (const name of ['export_stl', 'export_obj', 'export_3mf', 'export_gltf']) {
      expect(execute(doc, name, params, empty).error?.code, name).toBe('MESH_ASSET_MISSING');
      expect(execute(doc, name, params, none).error?.code, name).toBe('MESH_ASSET_UNAVAILABLE');
    }
  });
});

describe('an asset this machine cannot read: a query degrades by name, a result that is written refuses', () => {
  const lacking = (): { doc: CadDocument; ctx: ExecutionContext } => scene([{ id: 'ghost', held: false }]);
  const expectDegraded = (result: CommandResult): void => {
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.error).toBeUndefined();
    const data = result.data as { lodOnly?: string[]; warnings?: Array<{ code: string; ids: string[]; assetKeys: string[] }> };
    expect(data.lodOnly).toEqual(['ghost']);
    expect(data.warnings?.[0]).toMatchObject({ code: 'MESH_ASSET_LOD_ONLY', ids: ['ghost'] });
    expect(data.warnings?.[0]?.assetKeys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(result.summary).toContain('WARNING MESH_ASSET_LOD_ONLY');
  };

  it('list_pmi, inspect_dynamics and mass_properties answer from the display mesh and say so', () => {
    const { doc, ctx } = lacking();
    expectDegraded(execute(doc, 'list_pmi', {}, ctx));
    expectDegraded(execute(doc, 'inspect_dynamics', {}, ctx));
    const measured = mass(doc, ctx, 'ghost');
    expectDegraded(measured);
    expect(volumeOf(measured)).toBeCloseTo(1, 6);
    expect(measured.document).toBe(doc);
  });

  it('a query without the unreadable asset in its reach carries no warning', () => {
    const { doc, ctx } = scene([{ id: 'scan' }, { id: 'ghost', held: false }]);
    const measured = mass(doc, ctx, 'scan');
    expect((measured.data as { lodOnly?: string[] }).lodOnly).toBeUndefined();
    expect(volumeOf(measured)).toBeCloseTo(1000, 6);
  });

  it('exports (readOnly but writing a result) refuse by name', () => {
    const { doc, ctx } = lacking();
    for (const name of [
      'export_code',
      'export_step_ap242',
      'export_iges',
      'export_building_dxf',
      'export_elevation_sheet',
      'export_urdf',
    ]) {
      const result = execute(doc, name, {}, ctx);
      if (result.error?.code === 'CMD_KERNEL_UNAVAILABLE' || result.error?.code === 'CMD_INVALID_PARAMS') continue;
      expect(result.error?.code, name).toBe('MESH_ASSET_LOD_ONLY');
      expect(result.document, name).toBe(doc);
    }
    const sheet = execute(doc, 'create_sheet', { name: 'A' }, ctx);
    const view = execute(sheet.document, 'create_drawing_view', { sheetId: sheet.affected[0], direction: 'front' }, ctx);
    expect(execute(view.document, 'export_sheet_svg', { sheetId: sheet.affected[0] }, ctx).error?.code).toBe('MESH_ASSET_LOD_ONLY');
  });

  it('a mutating command refuses by name and leaves the document alone', () => {
    const { doc, ctx } = lacking();
    const refused = execute(doc, 'scale_entity', { id: 'ghost', factor: 2 }, ctx);
    expectNoOp(refused, doc);
    expect(refused.error?.code).toBe('MESH_ASSET_LOD_ONLY');
    expect(refused.error?.ids).toEqual(['ghost']);
  });
});

describe('degrading happens only at the outermost call', () => {
  it('a query executed by another command refuses the unreadable asset instead of feeding it a display-mesh figure', () => {
    const { doc, ctx } = scene([{ id: 'ghost', held: false }]);
    expect((mass(doc, ctx, 'ghost').data as { lodOnly?: string[] }).lodOnly).toEqual(['ghost']);
    const nested = execute(doc, 'mass_properties', { entityId: 'ghost' }, { ...ctx, nested: true });
    expect(nested.error?.code).toBe('MESH_ASSET_LOD_ONLY');
    expect(nested.document).toBe(doc);
  });

  it('exactFacePoint (the anchor of apply_design) gets the refusal, so the anchor does not come from display faces', () => {
    const { doc, ctx } = scene([{ id: 'ghost', held: false }]);
    const kernel = fakeKernel({ solid: TETRA });
    const top = execute(doc, 'inspect_faces', { entityId: 'ghost', samples: 9 }, { ...ctx, kernel });
    expect(top.error?.code).not.toBe('MESH_ASSET_LOD_ONLY');
    const nested = execute(doc, 'inspect_faces', { entityId: 'ghost', samples: 9 }, { ...ctx, kernel, nested: true });
    expect(nested.error?.code).toBe('MESH_ASSET_LOD_ONLY');
    expect(exactFacePoint(doc, 'ghost', 'top', { ...ctx, kernel, nested: true })).toBeNull();
  });
});
