/** Shared vocabulary of the assembly-check modules: a part as the kernel sees it, and the tolerances every module reads. */

import type { MeshData, ShapeRecipe, Vec3 } from '../../model/types';
import type { ShapeHandle } from '../kernel';

/** A checked part: a 3D solid entity or an assembly instance (its entities unioned), already built by the kernel. */
export interface AssemblyPart {
  /** Entity id, or instance id. */
  readonly id: string;
  readonly recipe: ShapeRecipe;
  readonly shape: ShapeHandle;
  /** World-space display mesh (document units); null when the kernel could not tessellate. */
  readonly mesh: MeshData | null;
  /** World bounds of `mesh` (document units); zero box when there is no mesh. */
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Named tolerances (TECHNICAL_SPEC 5.9). Lengths in document units. */
export interface CheckTolerances {
  /** Distance at or below which two parts count as touching. */
  readonly epsTouch: number;
  /** Required clearance; 0 = no clearance check. */
  readonly clearance: number;
  /** Overlap fraction of the smaller part from which a pair is containment. */
  readonly containmentRatio: number;
  /** Overlap volume below this fraction of the smaller part is not an overlap. */
  readonly volumeRelative: number;
  /** Millimetres per document unit (reported values are converted). */
  readonly mmPerUnit: number;
}

export const KERNEL_REMEDIATION =
  'Use a kernel that implements analyze/distance (Manifold or OCC); joint realisation needs exact faces (LLULL_KERNEL=occt-native).';
