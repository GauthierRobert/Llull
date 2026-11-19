/**
 * Facts of a body mesh that cost a pass over every triangle: divergence-theorem volume and area, and the closed-manifold test. A field engine that
 * meshes natively returns them with the mesh (`FieldMeshResult.measures`, `closedManifold`); they are remembered here, per mesh object and per mesh
 * asset key, so create_implicit_body, implicit_properties and check_implicit read them instead of walking a multi-million-triangle mesh again.
 * @invariant a remembered fact equals what `meshMeasures` / `isClosedManifold` return for that mesh, bit for bit (the engine contract), so an answer never depends on what is remembered
 * @invariant process memory only: nothing here is document state; a mesh met for the first time (another process, an evicted asset) is measured in TypeScript and then remembered
 */

import type { FieldMeshResult } from '@core/geometry/field/engineTypes';
import type { MeshData } from '@core/model/types';
import { type MeshMeasures, isClosedManifold, meshMeasures } from '@lib/isosurface/measures';

interface Facts {
  measures: MeshMeasures | null;
  closedManifold: boolean | null;
}

/** Asset keys remembered (a key identifies the content of its mesh, so its facts never change); the least recently used leaves first. */
const MAX_KEYS = 64;

const byMesh = new WeakMap<MeshData, Facts>();
const byKey = new Map<string, Facts>();

/** Fill what `into` does not know from `from` (both describe the same content). */
function fill(into: Facts, from: Facts): void {
  into.measures ??= from.measures;
  into.closedManifold ??= from.closedManifold;
}

/** Make `assetKey` the most recently used key (Map order is insertion order), evicting the least recently used beyond MAX_KEYS. */
function touchKey(assetKey: string, facts: Facts): void {
  byKey.delete(assetKey);
  byKey.set(assetKey, facts);
  if (byKey.size > MAX_KEYS) {
    const oldest = byKey.keys().next().value;
    if (oldest !== undefined) byKey.delete(oldest);
  }
}

function factsOf(mesh: MeshData, assetKey?: string): Facts {
  const ofMesh = byMesh.get(mesh);
  const ofKey = assetKey === undefined ? undefined : byKey.get(assetKey);
  const facts = ofKey ?? ofMesh ?? { measures: null, closedManifold: null };
  if (ofMesh !== undefined && ofMesh !== facts) {
    fill(facts, ofMesh);
    fill(ofMesh, facts);
  }
  byMesh.set(mesh, facts);
  if (assetKey !== undefined) touchKey(assetKey, facts);
  return facts;
}

/** Remember what the engine returned with `result.mesh`. */
export function rememberMeshResult(result: FieldMeshResult): void {
  const { mesh } = result;
  const facts = factsOf(mesh);
  facts.closedManifold ??= result.closedManifold;
  if (result.measures !== undefined)
    facts.measures ??= { ...result.measures, triangles: Math.floor(mesh.indices.length / 3), vertices: mesh.positions.length / 3 };
}

/** `mesh` is the content of the mesh asset `assetKey` (just written, or just read): what is known of either is now known of both. */
export function bindMeshAsset(mesh: MeshData, assetKey: string): void {
  factsOf(mesh, assetKey);
}

/** `meshMeasures(mesh)`, from memory when known. */
export function bodyMeshMeasuresOf(mesh: MeshData): MeshMeasures {
  const facts = factsOf(mesh);
  facts.measures ??= meshMeasures(mesh);
  return facts.measures;
}

/** `isClosedManifold(mesh)`, from memory when known. */
export function bodyMeshIsClosedManifold(mesh: MeshData): boolean {
  const facts = factsOf(mesh);
  facts.closedManifold ??= isClosedManifold(mesh);
  return facts.closedManifold;
}
