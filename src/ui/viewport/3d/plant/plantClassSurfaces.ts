// Surfaces of the plant buckets: a plan material class key is either `matclass:<id>` (an assigned display class: its metalness and roughness)
// or a document material id (its PBR, colour too). Pure; the namespace makes a `materialId` equal to a class id a different bucket.

import { findMaterialClass, materialClassIdOfPlanKey } from '@core/geometry/materialClasses';
import type { DisplayModel } from '@core/model/display';
import type { Material } from '@core/model/types';

export interface PlantSurface {
  readonly roughness: number;
  readonly metalness: number;
  /** A document material's diffuse colour (a class colour comes through the tints). */
  readonly color?: string;
}

/** Plan key -> surface of every assigned class among `planKeys` (classes that no longer exist are left out). */
export function planClassSurfaces(planKeys: readonly string[], display: DisplayModel | undefined): ReadonlyMap<string, PlantSurface> {
  const surfaces = new Map<string, PlantSurface>();
  for (const key of planKeys) {
    const id = materialClassIdOfPlanKey(key);
    const found = id === undefined ? undefined : findMaterialClass(display, id);
    if (found !== undefined) surfaces.set(key, { metalness: found.metalness, roughness: found.roughness });
  }
  return surfaces;
}

/** Content key of the class surfaces: equal while the used classes keep their metalness and roughness, whatever else changes in `display`. */
export function classSurfacesKey(surfaces: ReadonlyMap<string, PlantSurface>): string {
  return [...surfaces].map(([key, surface]) => `${key}=${surface.metalness},${surface.roughness}`).join(';');
}

/** The surface of a bucket's material class key: its class's, else the document material of that id, else none. */
export function bucketSurface(
  planKey: string,
  materials: Readonly<Record<string, Material>>,
  classes: ReadonlyMap<string, PlantSurface>,
): PlantSurface | undefined {
  if (materialClassIdOfPlanKey(planKey) !== undefined) return classes.get(planKey);
  return Object.hasOwn(materials, planKey) ? materials[planKey] : undefined;
}
