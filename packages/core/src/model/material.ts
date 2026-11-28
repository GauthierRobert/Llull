/** Physical + PBR engineering material (`CadDocument.materials`). */

import type { PropertyModel } from './propertyModel';
import type { ConstitutiveSet, MaterialModel } from './materialModel';
import type { MaterialRecordInfo } from './materialLibrary';
import type { MaterialFinish } from './materialFinish';
import type { Appearance } from './appearance';

/**
 * Physical + PBR material. `density` is mass per (document unit)³ so mass = volume × density (mm document: g/mm³, steel ≈ 0.00785).
 * Replaced via `create_material`.
 * @invariant density > 0 and finite (0 only on a `record` material with no density value yet, or an unresolved private stub); color matches
 *   /^#[0-9a-fA-F]{6}$/; metalness, roughness in [0, 1]
 */
export interface Material {
  readonly name: string;
  density: number;
  /** Unit `density` was given in at creation (create_material `densityUnit`); absent = given directly in g/(document unit)³. Still no source. */
  readonly densityUnit?: string;
  /** Where the density comes from (FR-FPR-73): a material with a source is not reported as unsourced by the dynamics mass. */
  readonly source?: string;
  /** Quality of `source`: A measured / verified, B published datasheet, C reconstructed or unchecked. */
  readonly grade?: 'A' | 'B' | 'C';
  /** Aerospace material record (08 MAT M2): designation, specs, licence, export marking, library origin. Absent on a legacy material. */
  readonly record?: MaterialRecordInfo;
  color: string;
  metalness: number;
  roughness: number;
  /** Procedural surface texture (albedo + normal + roughness maps); absent = plain PBR colour. */
  finish?: MaterialFinish;
  /** Layered appearance with image textures (RV-M1 `set_material_appearance` / `apply_appearance`); its base colour value is also `color`. */
  appearance?: Appearance;
  /** Property models (PHY-01: k(T), cp(T), E(T), …) defined with define_property_model; read through `propertyModelEval`. */
  readonly propertyModels?: readonly PropertyModel[];
  /** Constitutive / durability laws (PHY-02: add_material_model); read through `materialLaws/*`. */
  readonly materialModels?: readonly MaterialModel[];
  /** Named combinations of material models an analysis picks (PHY-02: define_constitutive_set). */
  readonly constitutiveSets?: readonly ConstitutiveSet[];
  /** Id of the set used when a query names none. */
  readonly defaultConstitutiveSet?: string;
}
