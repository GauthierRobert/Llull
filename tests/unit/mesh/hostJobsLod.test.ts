/**
 * TECHNICAL_SPEC 13.11: the pure builders of host jobs (CFD flow, topology optimization) read a document without `execute`. An asset-backed
 * body that the document holds only as its display level of detail is refused by name (MESH_ASSET_LOD_ONLY); a host that hands over a
 * full-resolution document (`withFullResolution`) gets the job built from the stored mesh.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { collectExportParts, withFullResolution } from '@core/geometry/entityTriangles';
import { assetLeaves } from '@core/geometry/recipeLeaves';
import { newEntity } from '@core/commands/entity/newEntity';
import type { CadDocument, MeshSolidEntity, ShapeRecipe } from '@core/model/types';
import { memoryMeshAssets } from '../../helpers/memoryMeshAssets';
import { displayOnlyMeshIds } from '@core/geometry/mesh/displayOnly';
import type { TopologyStudy } from '@core/model/topology';
import { buildFlowJob, cfdCaseOf } from '@aero/index';
import { buildTopologyJob } from '@cae/index';
import { icosphere } from '../../helpers/meshFixtures';
import { cube, scene } from '../../helpers/assetScene';

const stored = icosphere(10, 3); // 1280 stored triangles, 12 in the display cube
const fixture = (): ReturnType<typeof scene> => scene([{ id: 'ball', fullMesh: stored, claimed: 1280 }]);

describe('displayOnlyMeshIds', () => {
  it('names a body held as its display mesh, also through an instance, and not one handed over at full resolution', () => {
    const { doc, ctx } = fixture();
    expect(displayOnlyMeshIds(doc, ['ball'])).toEqual(['ball']);
    expect(displayOnlyMeshIds(doc, ['nothing', 'constructor'])).toEqual([]);
    const made = execute(doc, 'create_component', { name: 'part', entityIds: ['ball'] }, ctx);
    const instance = made.affected[0] as string;
    expect(displayOnlyMeshIds(made.document, [instance])).toEqual(['ball']);
    expect(displayOnlyMeshIds(withFullResolution(made.document, [instance], ctx.meshAssets), [instance])).toEqual([]);
    expect(displayOnlyMeshIds(withFullResolution(doc, ['ball'], ctx.meshAssets), ['ball'])).toEqual([]);
  });
});

describe('buildFlowJob', () => {
  const caseParams = {
    id: 're100',
    entityIds: ['ball'],
    freestream: { speedMS: 1, air: { densityKgM3: 1, temperatureK: 288.15, viscosityPaS: 0.01 } },
    reference: { areaM2: 1, lengthM: 1 },
    cellsPerReferenceLength: 8,
  };

  it('refuses the display mesh by name, and builds from the stored one', () => {
    const { doc, ctx } = fixture();
    const withCase = execute(doc, 'create_cfd_case', caseParams, ctx).document;
    const cfdCase = cfdCaseOf(withCase, 're100');
    expect(cfdCase).toBeDefined();
    if (cfdCase === undefined) return;
    const refused = buildFlowJob(withCase, cfdCase, null);
    expect(refused).toMatchObject({ ok: false, code: 'MESH_ASSET_LOD_ONLY', ids: ['ball'] });
    const full = buildFlowJob(withFullResolution(withCase, ['ball'], ctx.meshAssets), cfdCase, null);
    expect(full.ok || full.code !== 'MESH_ASSET_LOD_ONLY').toBe(true);
  });
});

describe('buildTopologyJob', () => {
  const study = (extra: Partial<TopologyStudy> = {}): TopologyStudy =>
    ({ id: 'ts-1', analysisId: 'a', designDomain: ['ball'], keepIn: [], keepOut: [], ...extra }) as unknown as TopologyStudy;

  it('refuses a design domain or a region held as its display mesh, and gets past the check with the stored mesh', () => {
    const { doc, ctx } = fixture();
    expect(buildTopologyJob(doc, study())).toMatchObject({ ok: false, code: 'MESH_ASSET_LOD_ONLY', ids: ['ball'] });
    const region = study({ designDomain: [], keepIn: [{ kind: 'entity', entityId: 'ball' }] as unknown as TopologyStudy['keepIn'] });
    expect(buildTopologyJob(doc, region)).toMatchObject({ ok: false, code: 'MESH_ASSET_LOD_ONLY', ids: ['ball'] });
    const full = withFullResolution(doc, ['ball'], ctx.meshAssets);
    expect(buildTopologyJob(full, study())).toMatchObject({ ok: false, code: 'TOP_ANALYSIS_MISSING' });
  });
});

describe('asset leaves of a kernel result and unreadable instances', () => {
  const resultOver = (leaf: MeshSolidEntity): MeshSolidEntity => ({
    ...(newEntity('mesh', 'result', { mesh: cube(1) }, [0, 0, 0], '#cccccc') as MeshSolidEntity),
    brep: { op: 'solid', entity: leaf },
  });

  it('displayOnlyMeshIds and withFullResolution follow the asset-backed leaves of a construction tree', () => {
    const { doc, ctx } = fixture();
    const leaf = doc.entities['ball'] as MeshSolidEntity;
    const withResult: CadDocument = { ...doc, entities: { result: resultOver(leaf) }, order: ['result'] };
    expect(displayOnlyMeshIds(withResult, ['result'])).toEqual(['result']);
    const full = withFullResolution(withResult, ['result'], ctx.meshAssets);
    const swapped = full.entities['result'] as MeshSolidEntity;
    expect(assetLeaves(swapped.brep as ShapeRecipe)[0]?.mesh).toBe(ctx.meshAssets?.readMesh(leaf.asset?.key as string));
    expect(swapped.mesh).toBe((withResult.entities['result'] as MeshSolidEntity).mesh);
    expect(displayOnlyMeshIds(full, ['result'])).toEqual([]);
    expect(withFullResolution(withResult, ['result'], memoryMeshAssets())).toBe(withResult);
  });

  it('an instance whose component asset cannot be read stays as it is, and its export is refused by code', () => {
    const { doc, ctx } = fixture();
    const made = execute(doc, 'create_component', { name: 'part', entityIds: ['ball'] }, ctx);
    const instance = made.affected[0] as string;
    const empty = memoryMeshAssets();
    expect(withFullResolution(made.document, [instance], empty)).toBe(made.document);
    expect(collectExportParts(made.document, [instance], empty).unreadable).toEqual([{ id: instance, code: 'MESH_ASSET_MISSING' }]);
    expect(collectExportParts(made.document, [instance], null).unreadable).toEqual([{ id: instance, code: 'MESH_ASSET_UNAVAILABLE' }]);
    expect(collectExportParts(made.document, [instance], undefined).unreadable[0]?.code).toBe('MESH_ASSET_UNAVAILABLE');
    expect(collectExportParts(made.document, [instance], ctx.meshAssets).unreadable).toEqual([]);
  });
});
