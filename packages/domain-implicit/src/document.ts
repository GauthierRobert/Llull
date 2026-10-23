/**
 * Derivation guard and document extension of the implicit plugin (05 IMP D3): a body's mesh is derived geometry, read-only, omitted from saved
 * files and derived again on load (the saved file keeps the field recipe and the content hash).
 */

import type { DerivationGuard, GuardRefusal } from '@core/commands/derivation';
import { commandError } from '@core/commands/noop';
import { getFieldEngine, resolveFieldEngine } from '@core/geometry/field/engine';
import type { CadDocument } from '@core/model/types';
import type { DocumentExtension } from '@core/plugins/plugin';
import { canonicalJson } from '@lib/canonicalJson';
import { isRecord } from '@lib/isRecord';
import { bodyEntity } from './bodyCommand';
import { type ImplicitBody, implicitOf, inputsOf } from './model';
import { realiseField } from './realise';

const OPS = new Set(['primitive', 'solid', 'boolean', 'offset', 'shell', 'transform', 'tpms', 'struts']);
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
    if (node.op === 'solid') sources.add(node.entityId);
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
    primitive: isRecord(node['dims']) && isVec3(node['position']) && isVec3(node['rotation']),
    solid: typeof node['entityId'] === 'string',
    boolean: Array.isArray(node['operands']) && node['operands'].every((o) => typeof o === 'string'),
    offset: typeof node['source'] === 'string' && typeof node['distance'] === 'number',
    shell: typeof node['source'] === 'string' && typeof node['thickness'] === 'number',
    transform:
      typeof node['source'] === 'string' && isVec3(node['position']) && isVec3(node['rotation']) && typeof node['scale'] === 'number',
    tpms: isVec3(node['cellSize']) && isVec3(node['origin']) && isRecord(node['control']),
    struts: isVec3(node['cellSize']) && isVec3(node['origin']) && typeof node['radius'] === 'number',
  };
  return checks[node['op']] === true ? null : `field '${key}' (${node['op']}) has malformed parameters`;
}

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
      typeof body['color'] === 'string';
    if (!valid) errors.push(`implicit body '${key}' is malformed`);
  }
  return errors;
}

/**
 * Re-derive the omitted meshes of a raw document through the resolved field engine, in creation order against the entities restored so far (a body
 * may be built on another body). A body that the engine cannot realise is dropped from the draw order and selection and reported by `afterLoad`
 * (IMP_BODY_STALE); a mesh that realises with another content hash (other engine) is kept and its record updated.
 */
function restore(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw['implicit'] === undefined || implicitErrors(raw).length > 0) return raw;
  const slice = raw['implicit'] as { bodies: Record<string, ImplicitBody> };
  const entities = isRecord(raw['entities']) ? raw['entities'] : {};
  const missing = Object.values(slice.bodies).filter((body) => !Object.hasOwn(entities, body.id));
  if (missing.length === 0) return raw;
  const engine = resolveFieldEngine(getFieldEngine());
  const restored: Record<string, unknown> = { ...entities };
  const bodies: Record<string, ImplicitBody> = { ...slice.bodies };
  const dropped = new Set<string>();
  for (const body of missing) {
    const doc = { ...raw, units: typeof raw['units'] === 'string' ? raw['units'] : 'mm', entities: restored } as unknown as CadDocument;
    const realised = realiseField(
      doc,
      { field: body.field, voxel: body.voxel, bounds: body.bounds, maxTriangles: engine.limits.maxTriangles },
      engine,
    );
    if (!realised.ok) {
      dropped.add(body.id);
      continue;
    }
    restored[body.id] = bodyEntity(body.id, body.field, body.name, body.color, realised.mesh);
    if (realised.contentHash !== body.contentHash) bodies[body.id] = { ...body, contentHash: realised.contentHash, engine: engine.name };
  }
  const without = (value: unknown): unknown => (Array.isArray(value) ? value.filter((id) => !dropped.has(String(id))) : value);
  return { ...raw, entities: restored, implicit: { ...slice, bodies }, order: without(raw['order']), selection: without(raw['selection']) };
}

export const implicitDocument: DocumentExtension = {
  validate: implicitErrors,
  derivedEntityIds: (doc) => new Set(Object.keys(implicitOf(doc).bodies)),
  restore,
  afterLoad: (doc) =>
    Object.values(implicitOf(doc).bodies)
      .filter((body) => !Object.hasOwn(doc.entities, body.id))
      .map(
        (body) =>
          `IMP_BODY_STALE: implicit body '${body.id}' (field ${body.field}) could not be realised on this machine; run create_implicit_body again`,
      ),
};
