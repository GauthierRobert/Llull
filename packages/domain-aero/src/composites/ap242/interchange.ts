/**
 * The composite content of a STEP AP242 file as llull writes and reads it (06 CMP §6.4 V2, M5): the ply table (plies, sequences, orientations, materials,
 * rosettes, ply boundaries), the part / tool-surface frame, and the validation properties (ply count, ply areas, laminate thickness, laminate mass).
 * Lengths are document units, angles degrees.
 */

import type {
  CompositePart,
  LaminaMaterial,
  PlyBoundary,
  PlyCut,
  PlyDrape,
  PlyDropRules,
  Rosette,
  RuleConfig,
} from '@core/model/composites';
import type { DocumentUnit, Vec2, Vec3 } from '@core/model/types';

export type RosetteRecord = Omit<Rosette, 'id'>;

export interface PlyRecord {
  readonly name: string;
  readonly sequence: string;
  /** 0 = tool side. */
  readonly order: number;
  readonly material: string;
  /** Degrees, in the part frame (what `Ply.orientation` stores). */
  readonly orientation: number;
  readonly rosette: string;
  readonly boundary: PlyBoundary;
  readonly drape?: PlyDrape;
  readonly cuts?: readonly PlyCut[];
  readonly thickness: number;
  /** Degrees measured from the ply's own rosette (what the CAx-IF ply_orientation_angle carries); absent in files of encoding 1. */
  readonly rosetteOrientation?: number;
  /** Covered area on the tool surface, document units squared. */
  readonly area: number;
  /** Names of the explicit solids (products of the same file) of this ply. */
  readonly solids: readonly string[];
  /** Ply boundary polylines on the tool surface (vertices mapped from the chart); written as curves, not read back. */
  readonly curves3d?: readonly (readonly Vec3[])[];
}

export interface CompositeValidation {
  readonly plyCount: number;
  /** Sum of the cured ply thicknesses, document length units. */
  readonly thickness: number;
  /** Density unit x document length unit^3; absent when a material has no density. */
  readonly mass?: number;
}

export interface CompositeRecord {
  readonly name: string;
  readonly units: DocumentUnit;
  readonly laminateSide: CompositePart['laminateSide'];
  readonly tool: { readonly name: string; readonly entityId: string; readonly faceNear: Vec3; readonly faceIndex?: number };
  readonly partRosette: string;
  readonly rosettes: readonly RosetteRecord[];
  readonly surface: CompositePart['surface'];
  readonly outline: readonly Vec2[];
  readonly rules?: RuleConfig;
  readonly plyDropRules?: PlyDropRules;
  readonly materials: readonly LaminaMaterial[];
  readonly plies: readonly PlyRecord[];
  readonly validation: CompositeValidation;
}
