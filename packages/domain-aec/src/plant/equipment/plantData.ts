/**
 * Plant data of an equipment element (`EquipmentElement.plant`, plant 03 EQP §3, decision Q1 / D6): the parametric template, design data and
 * nozzles. Plain JSON in the building model; geometry, ports and the legacy `size` / `shape` / `weight` are re-derived from it. Lengths are in
 * document units, angles in degrees. Pure types: this module imports no runtime code.
 */

import type { Vec3 } from '@core/model/vectors';
import type { HeadSpec } from './model';

export const PLANT_EQUIPMENT_SCHEMA = 'llull-plant-equipment/1';

export type NozzleFacing = 'RF' | 'FF' | 'RTJ';
export type PressureUnit = 'MPa' | 'kPa' | 'bar' | 'psi';
export type StressUnit = 'MPa' | 'psi';

export interface PressureQuantity {
  readonly value: number;
  readonly unit: PressureUnit;
  readonly source?: string | undefined;
}

export interface StressQuantity {
  readonly value: number;
  readonly unit: StressUnit;
  readonly source?: string | undefined;
}

export interface VesselDesignData {
  /** Internal design pressure, gauge. */
  readonly pressure?: PressureQuantity | undefined;
  readonly temperatureC?: number | undefined;
  readonly material?: string | undefined;
  /** S at design temperature: never defaulted. */
  readonly allowableStress?: StressQuantity | undefined;
  readonly allowableStressAtTest?: StressQuantity | undefined;
  readonly jointEfficiency?: { readonly shell: number; readonly heads: number } | undefined;
  readonly materialDensityKgM3?: number | undefined;
  /** Level counts from the bottom tangent line (vertical) or the shell bottom (horizontal). */
  readonly operatingLiquid?: { readonly specificGravity: number; readonly levelAboveBottomTangent: number } | undefined;
}

/** Resolved support: every default is filled in and reported by the command that created it. */
export type SupportSpec =
  | { readonly type: 'skirt'; readonly height: number; readonly thickness: number; readonly baseRingWidth: number }
  | { readonly type: 'legs'; readonly count: number; readonly height: number; readonly pitchDiameter: number; readonly legWidth: number }
  | { readonly type: 'saddles'; readonly stations: readonly number[]; readonly width: number; readonly axisElevation: number }
  | { readonly type: 'none'; readonly baseElevation: number };

export interface TraySpec {
  readonly count: number;
  readonly spacing: number;
  /** Above the bottom tangent line. */
  readonly firstElevation: number;
  readonly type?: string;
}

/** A platform support clip on a column shell: `fromDeg` to `toDeg` clockwise seen from above, 0 = plant north (stored as north_cw). */
export interface PlatformClip {
  readonly elevation: number;
  readonly fromDeg: number;
  readonly toDeg: number;
  readonly depth: number;
  readonly height: number;
}

export interface VesselTemplate {
  readonly kind: 'vessel';
  readonly orientation: 'vertical' | 'horizontal';
  readonly insideDiameter: number;
  readonly tangentLength: number;
  /** Bottom and top head (vertical), left and right head (horizontal). */
  readonly heads: { readonly first: HeadSpec; readonly second: HeadSpec };
  readonly shellThickness: number;
  readonly headThickness: number;
  readonly corrosionAllowance: number;
  readonly support: SupportSpec;
  readonly trays?: TraySpec;
  readonly platformClips?: readonly PlatformClip[];
}

/** Legacy `add_equipment` block that only carries nozzles: its geometry and legacy fields stay as the user set them. */
export interface BlockTemplate {
  readonly kind: 'block';
}

export type EquipmentTemplate = VesselTemplate | BlockTemplate;

/** Where a nozzle sits, in the equipment frame (origin = plan location at the level elevation, +Z up, rotated by the plan rotation). */
export type NozzleLocation =
  | { readonly on: 'shell'; readonly elevation: number; readonly orientationDeg: number }
  | { readonly on: 'shell'; readonly station: number; readonly orientationDeg: number }
  | {
      readonly on: 'head';
      readonly head: 'top' | 'bottom' | 'left' | 'right';
      readonly radialOffset: number;
      readonly orientationDeg: number;
    }
  | { readonly on: 'free'; readonly position: Vec3; readonly direction: Vec3 };

/** Flange hardware of a nozzle, resolved from the 01 PSC catalogue when a row exists (`placeholder` when none does). */
export interface NozzleFlange {
  readonly outsideDiameter: number;
  readonly thickness: number;
  readonly placeholder: boolean;
  readonly unverified: boolean;
  readonly catalogRef?: string;
  readonly source?: string | undefined;
}

export interface NozzleRecord {
  /** Unique per equipment: N1, M1, S1 ... */
  readonly mark: string;
  readonly service?: string;
  readonly dn: number;
  /** `CL150` ... `CL2500` or `PN16` ... */
  readonly rating: string;
  readonly facing: NozzleFacing;
  readonly location: NozzleLocation;
  /** Shell: vessel axis to flange face. Head: tangent line to flange face. Free: neck length behind the face position. */
  readonly projection: number;
  readonly neckOutsideDiameter: number;
  readonly neckWall: number;
  readonly flange: NozzleFlange;
}

export interface PlantEquipmentData {
  readonly schema: typeof PLANT_EQUIPMENT_SCHEMA;
  readonly template: EquipmentTemplate;
  readonly design?: VesselDesignData;
  readonly nozzles: readonly NozzleRecord[];
}
