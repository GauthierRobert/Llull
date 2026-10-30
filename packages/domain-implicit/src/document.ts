/**
 * Derivation guard and document extension of the implicit plugin (05 IMP D3): a body's mesh is derived geometry, read-only, omitted from saved
 * files and derived again on load (the saved file keeps the field recipe and the content hash).
 */

import type { DerivationGuard, GuardRefusal } from '@core/commands/derivation';
import { commandError } from '@core/commands/noop';
import { getFieldEngine, resolveFieldEngine } from '@core/geometry/field/engine';
import { MESH_LOD_TRIANGLES, getMeshAssetPort } from '@core/geometry/mesh/assets';
import { lodMesh } from '@core/geometry/mesh/lod';
import type { CadDocument, MeshData } from '@core/model/types';
import type { DocumentExtension } from '@core/plugins/plugin';
import { canonicalJson } from '@lib/canonicalJson';
import { isRecord } from '@lib/isRecord';
import { bodyEntity, triangleBudget } from './bodyCommand';
import { storeBodyMesh } from './bodyMesh';
import { type ImplicitBody, type ImplicitModel, entitySources, implicitOf, inputsOf } from './model';
import { readsEntity } from './rederive';
import { realiseField } from './realise';

const OPS = new Set(['primitive', 'solid', 'boolean', 'offset', 'shell', 'transform', 'tpms', 'struts', 'graph', 'voronoi', 'scalar']);
const SHAPES = new Set(['sphere', 'box', 'cylinder', 'capsule', 'torus', 'cone', 'plane']);
const TPMS_KINDS = new Set(['gyroid', 'schwarz_p', 'diamond', 'neovius', 'iwp', 'lidinoid', 'fischer_koch_s', 'split_p']);
const STRUT_CELLS = new Set(['cubic', 'bcc', 'fcc', 'octet', 'kelvin', 'diamond', 'bccz', 'fccz', 'reentrant']);
const SCALAR_KINDS = new Set(['coordinate', 'distance', 'ramp', 'mix', 'arith', 'noise', 'topology_density', 'fea_result']);
const isFiniteNumber = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const isLaw = (value: unknown): boolean => typeof value === 'number' || typeof value === 'string';
const isVec3 = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 3 && value.every((c) => typeof c === 'number' && Number.isFinite(c));

/** Entity ids of the solid nodes a body's field depends on. */
function sourcesOf(model: ReturnType<typeof implicitOf>, root: string): string[] {
  const seen = new Set<string>();
  const sources = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id) || !Object.hasOwn(model.fields, id)) return;
    seen.add(id);
    const node = model.fields[id];
    if (node === undefined) return;
    entitySources(node).forEach((entity) => sources.add(entity));
    inputsOf(node).forEach(visit);
  };
  visit(root);
  return [...sources];
}

const withoutLayer = (value: unknown): string => canonicalJson({ ...(value as Record<string, unknown>), layerId: undefined });

const sourceRefusal = (body: string, source: string, what: string): GuardRefusal => ({
  reason: `IMP_SOURCE_IN_USE — '${source}' is the source solid of implicit body '${body}' and cannot be ${what}; delete the body's fields or rebuild them first`,
  error: commandError(
    'IMP_SOURCE_IN_USE',
    'create a new field_from_solid on the edited solid and a new body; the existing body keeps its source',
    [source, body],
  ),
});

const refusal = (id: string, why: string): GuardRefusal => ({
  reason: `IMP_DERIVED_READ_ONLY — '${id}' ${why}; edit the field nodes and run create_implicit_body again`,
  error: commandError('IMP_DERIVED_READ_ONLY', 'edit the field nodes and run create_implicit_body again', [id]),
});

/**
 * @invariant the mesh entity of a body changes only together with its body record (a new contentHash) or is removed with it; every other edit (move, delete, modify, replace) is refused with IMP_DERIVED_READ_ONLY
 */
export const implicitGuard: DerivationGuard = {
  domain: 'implicit',
  check(previous: CadDocument, next: CadDocument): GuardRefusal | null {
    for (const body of Object.values(implicitOf(previous).bodies)) {
      if (!Object.hasOwn(previous.entities, body.id)) continue;
      const after = Object.hasOwn(implicitOf(next).bodies, body.id) ? implicitOf(next).bodies[body.id] : undefined;
      const entityNow = Object.hasOwn(next.entities, body.id) ? next.entities[body.id] : undefined;
      if (after === undefined) {
        if (entityNow !== undefined) return refusal(body.id, 'outlived its body record');
        continue;
      }
      if (after.contentHash !== body.contentHash) continue;
      for (const source of sourcesOf(implicitOf(previous), body.field)) {
        const was = Object.hasOwn(previous.entities, source) ? previous.entities[source] : undefined;
        const now = Object.hasOwn(next.entities, source) ? next.entities[source] : undefined;
        if (was === undefined) continue;
        if (now === undefined) return sourceRefusal(body.id, source, 'deleted');
        if (now !== was && withoutLayer(now) !== withoutLayer(was)) return sourceRefusal(body.id, source, 'modified or moved');
      }
      const before = previous.entities[body.id];
      if (entityNow === undefined) return refusal(body.id, 'is the derived mesh of an implicit body and cannot be deleted');
      if (entityNow !== before && canonicalJson(entityNow) !== canonicalJson(before))
        return refusal(body.id, 'is the derived mesh of an implicit body and is read-only');
    }
    return null;
  },
};

function nodeError(key: string, node: unknown): string | null {
  if (!isRecord(node) || node['id'] !== key || typeof node['op'] !== 'string' || !OPS.has(node['op']))
    return `field '${key}' is not a valid node`;
  const checks: Record<string, boolean> = {
    primitive:
      typeof node['shape'] === 'string' &&
      SHAPES.has(node['shape']) &&
      isRecord(node['dims']) &&
      Object.values(node['dims']).every((dim) => isFiniteNumber(dim) || isVec3(dim)) &&
      (node['rounding'] === undefined || isFiniteNumber(node['rounding'])) &&
      isVec3(node['position']) &&
      isVec3(node['rotation']),
    solid: typeof node['entityId'] === 'string',
    boolean: Array.isArray(node['operands']) && node['operands'].every((o) => typeof o === 'string'),
    offset: typeof node['source'] === 'string' && isLaw(node['distance']),
    shell: typeof node['source'] === 'string' && isLaw(node['thickness']),
    transform:
      typeof node['source'] === 'string' && isVec3(node['position']) && isVec3(node['rotation']) && typeof node['scale'] === 'number',
    tpms:
      typeof node['kind'] === 'string' &&
      TPMS_KINDS.has(node['kind']) &&
      isVec3(node['cellSize']) &&
      isVec3(node['origin']) &&
      isVec3(node['rotation']) &&
      (node['form'] === 'sheet' || node['form'] === 'network') &&
      (node['normalize'] === 'gradient' || node['normalize'] === 'none') &&
      isRecord(node['control']),
    struts:
      typeof node['cell'] === 'string' &&
      STRUT_CELLS.has(node['cell']) &&
      isVec3(node['cellSize']) &&
      isVec3(node['origin']) &&
      isVec3(node['rotation']) &&
      isLaw(node['radius']),
    graph:
      Array.isArray(node['sourceIds']) &&
      node['sourceIds'].every((o) => typeof o === 'string') &&
      typeof node['radiusStart'] === 'number' &&
      typeof node['radiusEnd'] === 'number' &&
      typeof node['chord'] === 'number' &&
      typeof node['mergeTolerance'] === 'number',
    voronoi:
      isVec3(node['min']) &&
      isVec3(node['max']) &&
      typeof node['density'] === 'number' &&
      node['density'] > 0 &&
      typeof node['seed'] === 'number' &&
      typeof node['radius'] === 'number',
    scalar:
      typeof node['kind'] === 'string' &&
      SCALAR_KINDS.has(node['kind']) &&
      (node['kind'] !== 'topology_density' || typeof node['studyId'] === 'string') &&
      (node['kind'] !== 'fea_result' ||
        (typeof node['caseId'] === 'string' && (node['quantity'] === 'von_mises' || node['quantity'] === 'u_mag'))),
  };
  return checks[node['op']] === true ? null : `field '${key}' (${node['op']}) has malformed parameters`;
}

/** Whether a raw mesh asset reference is well formed (sha256 key, counts, bounds). */
const isAssetRef = (asset: unknown): boolean =>
  isRecord(asset) &&
  typeof asset['key'] === 'string' &&
  /^[0-9a-f]{64}$/.test(asset['key']) &&
  typeof asset['triangles'] === 'number' &&
  typeof asset['vertices'] === 'number' &&
  isRecord(asset['bounds']) &&
  isVec3(asset['bounds']['min']) &&
  isVec3(asset['bounds']['max']);

/** Value errors in the raw `implicit` slice. */
function implicitErrors(raw: Record<string, unknown>): string[] {
  const slice = raw['implicit'];
  if (slice === undefined) return [];
  if (!isRecord(slice) || slice['version'] !== 1 || !isRecord(slice['fields']) || !isRecord(slice['bodies']))
    return ['implicit: malformed slice (version 1 with fields and bodies expected)'];
  const errors = Object.entries(slice['fields']).flatMap(([key, node]) => nodeError(key, node) ?? []);
  for (const [key, body] of Object.entries(slice['bodies'])) {
    const valid =
      isRecord(body) &&
      body['id'] === key &&
      typeof body['field'] === 'string' &&
      typeof body['voxel'] === 'number' &&
      body['voxel'] > 0 &&
      isRecord(body['bounds']) &&
      isVec3(body['bounds']['min']) &&
      isVec3(body['bounds']['max']) &&
      typeof body['contentHash'] === 'string' &&
      typeof body['name'] === 'string' &&
      typeof body['engine'] === 'string' &&
      (body['mesher'] === 'tetra' || body['mesher'] === 'dual_contouring') &&
      typeof body['color'] === 'string' &&
      (body['explicitBounds'] === undefined || typeof body['explicitBounds'] === 'boolean') &&
      (body['asset'] === undefined || isAssetRef(body['asset']));
    if (!valid) errors.push(`implicit body '${key}' is malformed`);
  }
  return errors;
}

/** A display mesh for a stored body this host cannot realise at its voxel: the same field at 2, 4, 8 and 16 times the voxel, or null. */
function coarseDisplay(realiseAt: (voxel: number) => ReturnType<typeof realiseField>, voxel: number): MeshData | null {
  for (const factor of [2, 4, 8, 16]) {
    const coarse = realiseAt(voxel * factor);
    if (coarse.ok) return coarse.mesh;
  }
  return null;
}

/**
 * The raw `entities` and `components` with every asset-backed mesh that the solid sources `ids` read (themselves, or through the component of an instance, nested
 * ones included) carrying its stored mesh; null when this machine does not hold one of the assets.
 */
function storedMeshes(
  raw: Record<string, unknown>,
  entities: Record<string, unknown>,
  ids: readonly string[],
  port: ReturnType<typeof getMeshAssetPort>,
): { entities: Record<string, unknown>; components: Record<string, unknown> } | null {
  const components = isRecord(raw['components']) ? raw['components'] : {};
  const measured = { entities: { ...entities }, components: { ...components } };
  const stored = (entity: Record<string, unknown>): unknown => {
    const key = isRecord(entity['asset']) ? entity['asset']['key'] : undefined;
    const full = typeof key === 'string' ? (port?.readMesh(key) ?? null) : null;
    return full === null ? null : { ...entity, mesh: full };
  };
  const seen = new Set<string>();
  const visitComponent = (componentId: string): boolean => {
    const component = Object.hasOwn(components, componentId) ? components[componentId] : undefined;
    if (!isRecord(component) || !isRecord(component['entities']) || seen.has(componentId)) return true;
    seen.add(componentId);
    const children = { ...component['entities'] };
    for (const [childId, child] of Object.entries(component['entities'])) {
      if (!isRecord(child)) continue;
      if (child['kind'] === 'instance' && typeof child['componentId'] === 'string') {
        if (!visitComponent(child['componentId'])) return false;
      } else if (child['kind'] === 'mesh' && isRecord(child['asset'])) {
        const full = stored(child);
        if (full === null) return false;
        children[childId] = full;
      }
    }
    measured.components[componentId] = { ...component, entities: children };
    return true;
  };
  for (const id of ids) {
    const entity = entities[id];
    if (!isRecord(entity)) continue;
    if (entity['kind'] === 'instance' && typeof entity['componentId'] === 'string') {
      if (!visitComponent(entity['componentId'])) return null;
    } else if (entity['kind'] === 'mesh' && isRecord(entity['asset'])) {
      const full = stored(entity);
      if (full === null) return null;
      measured.entities[id] = full;
    }
  }
  return measured;
}

/**
 * Re-derive the omitted meshes of a raw document through the resolved field engine, in creation order against the entities restored so far (a body
 * may be built on another body). A body that the engine cannot realise stays listed in the draw order (saving loses nothing; a load that can realise it does so in place), leaves the selection and is reported by `afterLoad`
 * (IMP_BODY_STALE); a mesh that realises with another content hash (other engine) is kept and its record updated.
 */
function restore(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw['implicit'] === undefined || implicitErrors(raw).length > 0) return raw;
  const slice = raw['implicit'] as { bodies: Record<string, ImplicitBody> };
  const entities = isRecord(raw['entities']) ? raw['entities'] : {};
  const missing = Object.values(slice.bodies).filter((body) => !Object.hasOwn(entities, body.id));
  if (missing.length === 0) return raw;
  const engine = resolveFieldEngine(getFieldEngine());
  const port = getMeshAssetPort();
  const restored: Record<string, unknown> = { ...entities };
  const bodies: Record<string, ImplicitBody> = { ...slice.bodies };
  const dropped = new Set<string>();
  /** Bodies shown by a coarse display mesh, and bodies that read one: their geometry would come from the proxy, so they stay unrealised (record and hash untouched, IMP_BODY_STALE). */
  const proxies = new Set<string>();
  for (const body of missing) {
    if (readsEntity(slice as unknown as ImplicitModel, body.field, proxies)) {
      proxies.add(body.id);
      dropped.add(body.id);
      continue;
    }
    const stored = body.asset === undefined ? null : (port?.readMesh(body.asset.key) ?? null);
    if (body.asset !== undefined && stored !== null) {
      restored[body.id] = bodyEntity(body.id, body.field, body.name, body.color, lodMesh(stored, MESH_LOD_TRIANGLES), body.asset);
      continue;
    }
    // A solid node measures its entity's triangles: an asset-backed mesh (also one inside the component of an instance) is read at its stored
    // resolution, never from its display mesh. Without the asset the body stays unrealised (IMP_BODY_STALE) and listed in the draw order: re-realising
    // it from the display mesh would rewrite its content hash with a wrong geometry.
    const measured = storedMeshes(raw, restored, sourcesOf(slice as unknown as ImplicitModel, body.field), port);
    if (measured === null) {
      dropped.add(body.id);
      continue;
    }
    const doc = { ...raw, units: typeof raw['units'] === 'string' ? raw['units'] : 'mm', ...measured } as unknown as CadDocument;
    const realiseAt = (voxel: number): ReturnType<typeof realiseField> =>
      realiseField(
        doc,
        {
          field: body.field,
          voxel,
          bounds: body.explicitBounds === true ? body.bounds : null,
          maxTriangles: triangleBudget(engine.limits, port),
          mesher: body.mesher,
        },
        engine,
      );
    const realised = realiseAt(body.voxel);
    if (!realised.ok) {
      const display = body.asset === undefined ? null : coarseDisplay(realiseAt, body.voxel);
      if (display === null || body.asset === undefined) dropped.add(body.id);
      else {
        restored[body.id] = bodyEntity(body.id, body.field, body.name, body.color, lodMesh(display, MESH_LOD_TRIANGLES), body.asset);
        proxies.add(body.id);
      }
      continue;
    }
    const again = storeBodyMesh(realised.mesh, port);
    restored[body.id] = bodyEntity(body.id, body.field, body.name, body.color, again.mesh, again.asset);
    const { asset: previousAsset, ...bare } = body;
    void previousAsset;
    if (realised.contentHash !== body.contentHash || again.asset?.key !== body.asset?.key)
      bodies[body.id] = {
        ...bare,
        contentHash: realised.contentHash,
        engine: realised.result.provenance.engine,
        ...(again.asset === undefined ? {} : { asset: again.asset }),
      };
  }
  const without = (value: unknown): unknown => (Array.isArray(value) ? value.filter((id) => !dropped.has(String(id))) : value);
  return { ...raw, entities: restored, implicit: { ...slice, bodies }, order: raw['order'], selection: without(raw['selection']) };
}

export const implicitDocument: DocumentExtension = {
  validate: implicitErrors,
  derivedEntityIds: (doc) => new Set(Object.keys(implicitOf(doc).bodies)),
  staleEntityIds: (doc) => new Set(Object.keys(implicitOf(doc).bodies).filter((id) => !Object.hasOwn(doc.entities, id))),
  restore,
  afterLoad: (doc) => {
    const port = getMeshAssetPort();
    const bodies = Object.values(implicitOf(doc).bodies);
    return [
      ...bodies
        .filter((body) => !Object.hasOwn(doc.entities, body.id))
        .map((body) => {
          const unheld = sourcesOf(implicitOf(doc), body.field).filter((id) => {
            const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
            return entity?.kind === 'mesh' && entity.asset !== undefined && (port === null || port.manifest(entity.asset.key) === null);
          });
          return unheld.length > 0
            ? `IMP_BODY_STALE: implicit body '${body.id}' (field ${body.field}) is built from the mesh asset of ${unheld.map((id) => `'${id}'`).join(', ')}, which this machine does not hold; run regenerate_implicit_bodies on a machine that holds the asset`
            : `IMP_BODY_STALE: implicit body '${body.id}' (field ${body.field}) could not be realised on this machine; run create_implicit_body again`;
        }),
      ...bodies
        .filter(
          (body) =>
            body.asset !== undefined && Object.hasOwn(doc.entities, body.id) && (port === null || port.manifest(body.asset.key) === null),
        )
        .map(
          (body) =>
            `IMP_ASSET_MISSING: implicit body '${body.id}' shows a coarse display mesh; its full mesh is not in this machine's mesh asset store (measurements and exports refuse until it is loaded)`,
        ),
    ];
  },
};
