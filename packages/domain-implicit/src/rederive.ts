/**
 * Dependency walks of the field DAG and re-derivation of implicit bodies (05 IMP FR-IMP-01, L8): editing a node re-derives every body whose field depends on
 * it, in creation order, against the entities re-derived so far (a body may be built on another body).
 * @invariant a body whose recomputed content hash equals its record is left untouched (same document object parts); a body the engine refuses makes the whole re-derivation fail, so no edit leaves a stale mesh
 */

import { resolveFieldEngine } from '@core/geometry/field/engine';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument, MeshSolidEntity } from '@core/model/types';
import { bodyEntity, triangleBudget } from './bodyCommand';
import { storeBodyMesh } from './bodyMesh';
import { compileField } from './compile';
import { type ImplicitBody, type ImplicitModel, entitySources, implicitOf, inputsOf } from './model';
import { bodyGrid, contentHashOf, realiseField } from './realise';

/** Ids of the fields `root` reads, directly or not, including `root`. */
function closureOf(model: ImplicitModel, root: string): Set<string> {
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id) || !Object.hasOwn(model.fields, id)) return;
    seen.add(id);
    const node = model.fields[id];
    if (node !== undefined) inputsOf(node).forEach(visit);
  };
  visit(root);
  return seen;
}

/** Whether `candidate` is read, directly or not, by field `reader` (so a node of `reader` that referred to `candidate`'s dependents would close a cycle). */
export const dependsOn = (model: ImplicitModel, reader: string, candidate: string): boolean => closureOf(model, reader).has(candidate);

/** Whether field `root` reads, directly or not, the mesh entity of any id in `entityIds` (through a solid, distance or graph node). */
export function readsEntity(model: ImplicitModel, root: string, entityIds: ReadonlySet<string>): boolean {
  if (entityIds.size === 0) return false;
  return [...closureOf(model, root)].some((id) => {
    const node = model.fields[id];
    return node !== undefined && entitySources(node).some((entity) => entityIds.has(entity));
  });
}

/** Field ids that read `id`, directly or not (not including `id`). */
export function dependentsOf(model: ImplicitModel, id: string): string[] {
  return Object.keys(model.fields).filter((other) => other !== id && closureOf(model, other).has(id));
}

/**
 * Bodies that must be re-derived when the fields `changed` change: bodies whose field depends on one, then (transitively) bodies that read the mesh entity of
 * an already stale body through a solid node. Creation order.
 */
export function staleBodies(model: ImplicitModel, changed: ReadonlySet<string>): string[] {
  const stale = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const body of Object.values(model.bodies)) {
      if (stale.has(body.id)) continue;
      const reads = closureOf(model, body.field);
      const direct = [...reads].some((id) => changed.has(id));
      const viaBody = [...reads].some((id) => {
        const node = model.fields[id];
        return node !== undefined && entitySources(node).some((entity) => stale.has(entity));
      });
      if (direct || viaBody) {
        stale.add(body.id);
        grew = true;
      }
    }
  }
  return Object.keys(model.bodies).filter((id) => stale.has(id));
}

/** `value` without its mesh asset reference. */
function withoutAsset<T extends { readonly asset?: unknown }>(value: T): Omit<T, 'asset'> {
  const { asset, ...rest } = value;
  void asset;
  return rest;
}

export type Rederived =
  | { readonly ok: true; readonly document: CadDocument; readonly changed: readonly string[]; readonly unchanged: readonly string[] }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly ids: readonly string[] };

/** Re-derive `bodyIds` of `doc` (in the order given) and return the document with the meshes and records that changed. */
export function rederiveBodies(doc: CadDocument, bodyIds: readonly string[], ctx: ExecutionContext | undefined): Rederived {
  const engine = resolveFieldEngine(ctx?.fieldEngine);
  let current = doc;
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const id of bodyIds) {
    const body = implicitOf(current).bodies[id] as ImplicitBody;
    const realised = realiseField(
      current,
      {
        field: body.field,
        voxel: body.voxel,
        bounds: body.explicitBounds === true ? body.bounds : null,
        maxTriangles: triangleBudget(engine.limits, ctx?.meshAssets),
        mesher: body.mesher,
      },
      engine,
    );
    if (!realised.ok) return { ok: false, code: realised.code, message: `body '${id}': ${realised.message}`, ids: [id, ...realised.ids] };
    if (realised.contentHash === body.contentHash && Object.hasOwn(current.entities, id)) {
      unchanged.push(id);
      continue;
    }
    const stored = storeBodyMesh(realised.mesh, ctx?.meshAssets);
    const previous = Object.hasOwn(current.entities, id) ? current.entities[id] : undefined;
    const base = bodyEntity(id, body.field, body.name, body.color, stored.mesh, stored.asset);
    const entity: MeshSolidEntity =
      previous?.kind === 'mesh'
        ? { ...withoutAsset(previous), mesh: base.mesh, ...(stored.asset === undefined ? {} : { asset: stored.asset }) }
        : base;
    const record: ImplicitBody = {
      ...withoutAsset(body),
      bounds: realised.bounds,
      engine: realised.result.provenance.engine,
      contentHash: realised.contentHash,
      ...(stored.asset === undefined ? {} : { asset: stored.asset }),
    };
    const model = implicitOf(current);
    current = {
      ...current,
      entities: { ...current.entities, [id]: entity },
      order: current.order.includes(id) ? current.order : [...current.order, id],
      implicit: { ...model, bodies: { ...model.bodies, [id]: record } },
    };
    changed.push(id);
  }
  return { ok: true, document: current, changed, unchanged };
}

/** Whether the stored content hash of `body` differs from what the resolved engine would produce now. */
export function isStale(doc: CadDocument, body: ImplicitBody, ctx: ExecutionContext | undefined): boolean {
  const engine = resolveFieldEngine(ctx?.fieldEngine);
  const compiled = compileField(doc, body.field);
  if (!compiled.ok) return true;
  const bounds = body.explicitBounds === true ? body.bounds : compiled.program.bounds;
  if (bounds === null) return true;
  return (
    contentHashOf(compiled.program, bodyGrid(bounds, body.voxel), engine, body.mesher) !== body.contentHash ||
    !Object.hasOwn(doc.entities, body.id)
  );
}
