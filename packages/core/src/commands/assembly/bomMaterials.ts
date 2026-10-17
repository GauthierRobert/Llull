/** Raw-material section of `bill_of_materials` (08 MAT FR-MAT-16): solid volume and mass per assigned material, unverified flags propagated. */

import { type CadDocument, type Entity, type InstanceEntity, is3D } from '../../model/types';
import type { ExecutionContext } from '../types';
import { expandInstance } from '../../geometry/instanceExpansion';
import { resolveDensity } from '../../geometry/resolveDensity';
import { childVolume, solidVolume } from '../inspect/solidVolume';

/** One material of the BOM: what was assigned, how much volume, and the mass when its density resolves. */
export interface MaterialRow {
  readonly materialId: string;
  readonly solidCount: number;
  readonly totalVolume: number;
  readonly volumeUnit: string;
  /** Present when the density resolved; grams (`massUnit`). */
  readonly totalMass?: number;
  readonly totalMassKg?: number;
  readonly massUnit: 'g';
  /** `closed_form` (primitives), `exact` (kernel B-rep), `mesh` (display triangles, ~1 % off on curved parts) or `mixed`. */
  readonly volumeMethod: 'closed_form' | 'exact' | 'mesh' | 'mixed';
  readonly densitySource?: string;
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  /** Set when the density could not be resolved (unknown material or a refused density model); no mass is reported then. */
  readonly code?: string;
  readonly reason?: string;
}

interface Accumulator {
  solidCount: number;
  volume: number;
  methods: Set<'closed_form' | 'exact' | 'mesh'>;
}

const MAX_NESTING = 8;

function add(accumulators: Map<string, Accumulator>, materialId: string, volume: number, method: 'closed_form' | 'exact' | 'mesh'): void {
  const found = accumulators.get(materialId) ?? { solidCount: 0, volume: 0, methods: new Set() };
  found.solidCount += 1;
  found.volume += volume;
  found.methods.add(method);
  accumulators.set(materialId, found);
}

function collectInstance(
  doc: CadDocument,
  instance: InstanceEntity,
  inherited: string | undefined,
  ctx: ExecutionContext | undefined,
  accumulators: Map<string, Accumulator>,
  depth: number,
): void {
  const component = doc.components[instance.componentId];
  if (component === undefined || depth > MAX_NESTING) return;
  for (const baked of expandInstance(instance, component)) {
    const materialId = baked.materialId ?? instance.materialId ?? inherited;
    if (baked.kind === 'instance') collectInstance(doc, baked, materialId, ctx, accumulators, depth + 1);
    else if (materialId !== undefined && is3D(baked))
      add(accumulators, materialId, childVolume(doc, baked, ctx), baked.kind === 'mesh' ? 'mesh' : 'closed_form');
  }
}

function collectSolid(doc: CadDocument, entity: Entity, ctx: ExecutionContext | undefined, accumulators: Map<string, Accumulator>): void {
  if (entity.kind === 'instance') return collectInstance(doc, entity, entity.materialId, ctx, accumulators, 0);
  if (entity.materialId === undefined || !is3D(entity)) return;
  const volume = solidVolume(doc, entity, ctx);
  if ('error' in volume) return;
  add(accumulators, entity.materialId, volume.volume, volume.method ?? 'closed_form');
}

function rowOf(doc: CadDocument, materialId: string, found: Accumulator): MaterialRow {
  const methods = [...found.methods];
  const volumeMethod = methods.length === 1 ? (methods[0] as MaterialRow['volumeMethod']) : 'mixed';
  const base = {
    materialId,
    solidCount: found.solidCount,
    totalVolume: found.volume,
    volumeUnit: `${doc.units}³`,
    massUnit: 'g' as const,
    volumeMethod,
  };
  const density = resolveDensity(doc, materialId);
  if (density === null)
    return {
      ...base,
      unverified: true,
      unverifiedReasons: ['material not defined'],
      code: 'MAT_RECORD_NOT_FOUND',
      reason: `material '${materialId}' is not defined`,
    };
  if (!density.available)
    return { ...base, unverified: true, unverifiedReasons: [density.reason], code: density.code, reason: density.reason };
  const totalMass = found.volume * density.gPerDocUnit3;
  return {
    ...base,
    totalMass,
    totalMassKg: totalMass / 1000,
    densitySource: density.source,
    unverified: density.unverified,
    unverifiedReasons: density.unverifiedReasons,
  };
}

/**
 * Volume and mass per material over the document's solids (instances contribute their component's solids, scaled by the instance).
 * @invariant a solid with no material is not listed; the unverified flag and its reasons come from `resolveDensity`
 */
export function materialRows(doc: CadDocument, ctx: ExecutionContext | undefined): MaterialRow[] {
  const accumulators = new Map<string, Accumulator>();
  for (const entity of Object.values(doc.entities)) collectSolid(doc, entity, ctx, accumulators);
  return [...accumulators]
    .map(([materialId, found]) => rowOf(doc, materialId, found))
    .sort((a, b) => a.materialId.localeCompare(b.materialId));
}

/** Top-level 3D solids (not instances) without an assigned material. */
export function unassignedSolidCount(doc: CadDocument): number {
  return Object.values(doc.entities).filter((entity) => entity.kind !== 'instance' && is3D(entity) && entity.materialId === undefined)
    .length;
}
