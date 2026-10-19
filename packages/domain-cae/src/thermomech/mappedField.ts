/**
 * Native mapped temperature fields (PHY-04 TR-TMC-24, RS1 RS-7): the request of an `interpolate` mapping (thermal mesh + nodal values ->
 * mechanical mesh), keyed by everything the result depends on (thermal results hash, step, scale conversion, both mesh hashes); the
 * `llull-compute post map` result encoded as a content-addressed `fe_results` artifact bound to that key and to the mechanical mesh hash;
 * and the reader the deck writer uses, which checks both bindings and every node before trusting a single value.
 */

import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { mappingReport, type MappedField } from './mapping';

const MAPPED_FIELD_SOLVER = 'llull-compute post map';
const FIELD_NAME = 'MAPPED';
const COMPONENTS = ['T', 'ELEMENT', 'DISTANCE'] as const;

export interface MappingRequest {
  /** sha256 of the request: the native result is stored under it. */
  readonly key: string;
  readonly source: FeMeshArtifact;
  /** Finite source values (case temperature scale) by source node id. */
  readonly values: ReadonlyMap<number, number>;
  readonly target: FeMeshArtifact;
  /** Hash of the target mesh nodes (ids + coordinates): the mapped field is bound to it. */
  readonly targetMeshHash: string;
}

export interface MappingInputs {
  readonly resultsHash: string;
  readonly step: number;
  readonly sourceMesh: FeMeshArtifact;
  readonly sourceMeshHash: string;
  readonly nodal: Readonly<Record<string, readonly number[]>>;
  readonly affine: { readonly offset: number; readonly scale: number };
  readonly target: FeMeshArtifact;
}

const nodeHashes = new WeakMap<FeMeshArtifact, string>();

/**
 * sha256 of the nodes of a target mesh (ids and coordinates: everything the mapping reads of the target), computed once per mesh object.
 * Plain JSON of arrays, no key sorting and no connectivity: about 20x cheaper than the canonical artifact hash on a 200k-node mesh.
 */
function nodesHash(mesh: FeMeshArtifact): string {
  let hash = nodeHashes.get(mesh);
  if (hash === undefined) {
    hash = sha256Hex(JSON.stringify(mesh.nodes));
    nodeHashes.set(mesh, hash);
  }
  return hash;
}

/** The request of mapping NDTEMP `nodal` (converted by `affine`) from the thermal mesh onto `target`. */
export function mappingRequest(inputs: MappingInputs): MappingRequest {
  const values = new Map<number, number>();
  for (const [id] of inputs.sourceMesh.nodes) {
    const raw = inputs.nodal[String(id)]?.[0];
    if (raw !== undefined && Number.isFinite(raw)) values.set(id, inputs.affine.offset + inputs.affine.scale * raw);
  }
  const targetMeshHash = nodesHash(inputs.target);
  const key = sha256Hex(
    canonicalJson({
      format: 'llull/mapped-field/1',
      resultsHash: inputs.resultsHash,
      step: inputs.step,
      sourceMeshHash: inputs.sourceMeshHash,
      affine: inputs.affine,
      targetMeshHash,
    }),
  );
  return { key, source: inputs.sourceMesh, values, target: inputs.target, targetMeshHash };
}

/** Wire buffers of `llull-compute post map` (little-endian f64): source nodes, element lists, source values, target nodes. */
export function mappingJobBuffers(request: MappingRequest): Readonly<Record<string, Float64Array>> {
  const elements: number[] = [];
  for (const block of request.source.blocks) for (const element of block.elements) elements.push(element.length - 1, ...element.slice(1));
  return {
    'source_nodes.f64': Float64Array.from(request.source.nodes.flat()),
    'source_elements.f64': Float64Array.from(elements),
    'source_values.f64': Float64Array.from([...request.values.entries()].flat()),
    'target_nodes.f64': Float64Array.from(request.target.nodes.flat()),
  };
}

/**
 * The artifact of a native mapping: `[value, element, distance]` per target node, bound to the request key and the target mesh.
 * @failure wrong size or a non-finite value -> a message
 */
export function mappedFieldArtifact(request: MappingRequest, mapped: Float64Array, solverVersion: string): FeResultsArtifact | string {
  const width = COMPONENTS.length;
  if (mapped.length !== request.target.nodes.length * width)
    return `the mapped field holds ${mapped.length} values, expected ${request.target.nodes.length * width}`;
  if (mapped.some((value) => !Number.isFinite(value))) return 'the mapped field has a non-finite value';
  const values: Record<string, number[]> = {};
  request.target.nodes.forEach(([id], index) => (values[String(id)] = Array.from(mapped.subarray(index * width, index * width + width))));
  return {
    kind: 'fe_results',
    meshHash: request.targetMeshHash,
    inputHash: request.key,
    solver: MAPPED_FIELD_SOLVER,
    solverVersion,
    steps: [{ step: 1, time: 0, fields: { [FIELD_NAME]: { components: [...COMPONENTS], values } } }],
  };
}

/**
 * The native mapped field of `request` when the store holds one bound to it (same key, same target mesh, a valid row per node), with the
 * report recomputed by the shared `mappingReport`; null otherwise (the caller maps in TypeScript).
 */
export function readMappedField(artifacts: FeArtifactPort | null | undefined, request: MappingRequest): MappedField | null {
  const found = artifacts?.get(request.key) ?? null;
  if (
    found === null ||
    found.kind !== 'fe_results' ||
    found.inputHash !== request.key ||
    found.meshHash !== request.targetMeshHash ||
    found.solver !== MAPPED_FIELD_SOLVER
  )
    return null;
  const rows = found.steps[0]?.fields[FIELD_NAME]?.values;
  const values: number[] = [];
  const elements: number[] = [];
  const distances: number[] = [];
  for (const [id] of request.target.nodes) {
    const row = rows?.[String(id)];
    if (row === undefined || row.length !== COMPONENTS.length || row.some((value) => !Number.isFinite(value))) return null;
    values.push(row[0] ?? Number.NaN);
    elements.push(row[1] ?? -1);
    distances.push(row[2] ?? Number.NaN);
  }
  return {
    ok: true,
    values,
    elements,
    distances,
    report: mappingReport(request.source, request.values, request.target, values, distances),
  };
}
