/**
 * Plant data of an equipment element (`EquipmentElement.plant`, plant 03 EQP §3, decision Q1 / D6): the parametric template, design data and
 * nozzles. Plain JSON in the building model; geometry, ports and the legacy `size` / `shape` / `weight` are re-derived from it. Lengths are in
 * document units, angles in degrees. Pure types: this module imports no runtime code.
 */

import type { Vec3 } from '@core/model/vectors';
import type { HeadSpec, SourceGrade } from './model';

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

/** TEMA designation of an exchanger (`BEM` -> front B, shell E, rear M). */
export interface TemaDesignation {
  readonly front: string;
  readonly shell: string;
  readonly rear: string;
  /** Rear head L, M or N: tubesheets at both ends, bundle not removable. */
  readonly fixedTubesheet: boolean;
  readonly removableBundle: boolean;
}

export interface TubeBundle {
  readonly outsideDiameter: number;
  readonly wallThickness: number;
  /** Where the wall comes from: 'user input' or the BWG table row (grade B: `wallUnverified`). */
  readonly wallSource: string;
  readonly wallUnverified: boolean;
  /** Tubes (U-tubes: tubesheet holes). */
  readonly count: number;
  /** Tube length between the outer faces of the tubesheets (U-tubes: straight leg). */
  readonly length: number;
  readonly passes: number;
  readonly pitch: number;
  readonly layoutAngleDeg: 30 | 45 | 60 | 90;
}

export interface ExchangerChannel {
  readonly length: number;
  readonly thickness: number;
}

/** Design data of one side of an exchanger (same fields and rules as the vessel design, no operating liquid level). */
export interface ExchangerSideDesign extends Omit<VesselDesignData, 'operatingLiquid' | 'materialDensityKgM3'> {
  /** Specific gravity of the fluid filling the side in the operating weight (fully filled, named assumption). */
  readonly specificGravity?: number | undefined;
}

/** Horizontal shell-and-tube exchanger (TEMA fronts A B C N, shells E F G H J, rears L M N P S T U W). Axis along local X. */
export interface ExchangerTemplate {
  readonly kind: 'exchanger';
  readonly orientation: 'horizontal';
  readonly temaType: string;
  readonly tema: TemaDesignation;
  readonly shellInsideDiameter: number;
  readonly shellThickness: number;
  readonly corrosionAllowance: number;
  readonly tubes: TubeBundle;
  readonly tubesheetThickness: number;
  readonly frontChannel: ExchangerChannel;
  /** Only for a fixed-tubesheet rear head (L, M, N); other rears close the shell with a shell cover. */
  readonly rearChannel?: ExchangerChannel;
  /** Saddles or none. */
  readonly support: SupportSpec;
  readonly design?: {
    readonly shellSide?: ExchangerSideDesign | undefined;
    readonly tubeSide?: ExchangerSideDesign | undefined;
    readonly materialDensityKgM3?: number | undefined;
  };
  /** Names of the defaults the command applied (checks report the safety-relevant ones). */
  readonly defaulted: readonly string[];
}

export interface TankRoof {
  readonly type: 'cone' | 'dome' | 'flat';
  /** Cone: rise per unit run. */
  readonly slope?: number;
  /** Dome: sphere radius. */
  readonly radius?: number;
  readonly thickness: number;
}

export interface TankDesign {
  readonly specificGravity: number;
  readonly designLiquidLevel: number;
  readonly material: string;
  readonly corrosionAllowance: number;
  readonly allowableStress?: { readonly design: number; readonly test: number; readonly source?: string | undefined } | undefined;
  readonly materialDensityKgM3?: number | undefined;
}

/** API 650 vertical atmospheric tank: `diameter` is the nominal (inside) diameter, the wall grows outward. Levels count from the top of the bottom plate. */
export interface TankTemplate {
  readonly kind: 'tank';
  readonly standard: 'api_650';
  readonly diameter: number;
  readonly shellHeight: number;
  /** Course heights from the bottom. */
  readonly courses: readonly number[];
  /** Nominal plate thickness per course (given by the user, else the one-foot governing thickness, see `thicknessSource`). */
  readonly courseThicknesses: readonly number[];
  readonly thicknessSource: 'user' | 'one_foot' | 'minimum';
  readonly roof: TankRoof;
  readonly bottom: { readonly type: 'flat'; readonly annularPlate: boolean; readonly thickness: number };
  readonly design: TankDesign;
  readonly defaulted: readonly string[];
}

export interface PumpBox {
  readonly length: number;
  readonly width: number;
  readonly height: number;
}

/** Pump envelope in document units (ISO 2858 meaning, B73.1 rows are converted): suction face `a` before the discharge centre, frame end `f` after it. */
export interface PumpEnvelope {
  readonly a: number;
  readonly f: number;
  /** Shaft height above the foot plane (baseplate top). */
  readonly h1: number;
  /** Discharge flange face above the shaft. */
  readonly h2: number;
  readonly suctionDn: number;
  readonly dischargeDn: number;
  readonly rating: string;
  readonly grade: SourceGrade;
  readonly source: string;
}

export interface PumpTemplate {
  readonly kind: 'pump';
  readonly standard: 'iso_2858' | 'asme_b73_1' | 'custom';
  readonly size?: string;
  readonly api610Type?: string;
  readonly envelope: PumpEnvelope;
  readonly baseplate: PumpBox;
  readonly driver?: PumpBox & { readonly gap: number };
  /** Vendor weight, kg (the standards give none). */
  readonly weightKg?: number;
  readonly defaulted: readonly string[];
}

export type EquipmentTemplate = VesselTemplate | BlockTemplate | ExchangerTemplate | TankTemplate | PumpTemplate;

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
  /** Exchanger channel (front / rear): `station` = distance from the tubesheet face outward, 0..channel length. */
  | { readonly on: 'channel'; readonly channel: 'front' | 'rear'; readonly station: number; readonly orientationDeg: number }
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
