/** Mass properties of a rigid body in SI units, resolved from its entities' geometry and materials. */

import type { CadDocument, Entity, Vec3 } from '../model/types';
import type { RigidBody } from '../model/dynamics';
import { toMetres } from '../model/units';
import type { GeometryKernel } from './kernel';
import { resolveMassProperties } from './resolveMassProperties';
import { resolveDensity, type DensityFallback } from './resolveDensity';
import { combineMassProperties, type InertiaTensor, type MassProperties } from './massProperties';
import { scale3 } from '../lib/vec3';

/** kg/m³ of a body entity without a material and without a body density: steel (a named default, AF-31). */
const DEFAULT_DENSITY: DensityFallback = { kgPerM3: 7850, source: 'default:steel 7850 kg/m^3', defaulted: true };

/** SI mass properties of one body (kg, m, kg·m²) and the densities they were computed from (`geometry/resolveDensity`). */
export interface BodyMassProperties {
  readonly mass: number;
  readonly centerOfMass: Vec3;
  readonly inertia: InertiaTensor;
  readonly densitySources: readonly string[];
  readonly densityDefaulted: boolean;
  readonly unverifiedReasons: readonly string[];
}

/** The mass distribution alone (what the reports and the inertia helpers read). */
export type BodyMassDistribution = Pick<BodyMassProperties, 'mass' | 'centerOfMass' | 'inertia'>;

/**
 * Mass properties of `body` in SI units, or an error. Entity densities come from `resolveDensity`: the assigned material (density model,
 * else its plain density), else the body density (kg/m³), else steel, reported as a default. `massKg` rescales the whole distribution.
 * With `kernel` (OCC) an exact B-rep part gets its exact inertia (`resolveMassProperties`).
 */
export function bodyMassProperties(
  doc: CadDocument,
  body: RigidBody,
  kernel?: GeometryKernel | null,
): BodyMassProperties | { error: string } {
  const metres = toMetres(doc, 1);
  const unitVolume = metres ** 3;
  const fallback: DensityFallback =
    body.density !== undefined
      ? { kgPerM3: body.density, source: `body '${body.id}' density ${body.density} kg/m^3`, defaulted: false }
      : DEFAULT_DENSITY;
  const sources = new Set<string>();
  const reasons = new Set<string>();
  let defaulted = false;
  let refused: { error: string } | null = null;
  const densityOf = (solid: Entity): number => {
    const density = resolveDensity(doc, solid.materialId, fallback);
    if (density === null) return 0;
    if (!density.available) {
      refused ??= { error: `${density.code}: body '${body.id}': ${density.reason}` };
      return 0;
    }
    const material = density.materialId === undefined ? undefined : doc.materials[density.materialId];
    const sourced = typeof material?.source === 'string' && material.source.trim().length > 0 && density.modelId === undefined;
    sources.add(sourced ? `material '${density.materialId}' density, source: ${material?.source}` : density.source);
    // a material that names its source (FR-FPR-73 catalogue) is not "given without a source"
    for (const reason of density.unverifiedReasons) if (!sourced) reasons.add(reason);
    defaulted ||= density.defaulted;
    return density.materialId === undefined ? density.kgPerM3 * unitVolume : density.gPerDocUnit3 / 1000;
  };
  const parts: MassProperties[] = [];
  for (const id of body.entityIds) {
    const entity = doc.entities[id];
    if (entity === undefined) return { error: `body '${body.id}' references missing entity '${id}'` };
    const props = resolveMassProperties(doc, entity, densityOf, { kernel: kernel ?? null })?.properties ?? null;
    if (refused !== null) return refused;
    if (props === null) return { error: `body '${body.id}': entity '${id}' (${entity.kind}) has no solid volume` };
    parts.push(props);
  }
  const combined = combineMassProperties(parts);
  if (combined === null) return { error: `body '${body.id}' has zero mass` };
  const scale = body.massKg !== undefined ? body.massKg / combined.mass : 1;
  return {
    mass: combined.mass * scale,
    centerOfMass: scale3(combined.centerOfMass, metres),
    inertia: body.inertiaKgM2 ?? (combined.inertia.map((value) => value * scale * metres * metres) as unknown as InertiaTensor),
    densitySources: body.massKg !== undefined ? [`body '${body.id}' massKg ${body.massKg}`, ...sources] : [...sources],
    densityDefaulted: body.massKg === undefined && defaulted,
    unverifiedReasons: [...reasons],
  };
}
