/**
 * Sheet-metal part graph (aerospace 07 FTR §3.3, step AERO-3), owned by the `sheetmetal` plugin (`CadDocument.sheetMetal`, validated
 * by its `DocumentExtension`). Lengths are in the document unit, angles in radians inside the model (degrees at the command boundary).
 */

import type { Vec2, Vec3 } from './vectors';

export type Verification = 'verified' | 'unverified';

/** A sourced threshold or table value (AF-30/31/32: no built-in defaults). */
export interface SourcedValue {
  readonly value: number;
  readonly source: string;
  readonly verification: Verification;
}

export type KFactorSpec =
  | { readonly standard: 'ansi' | 'din'; readonly value: number }
  | {
      readonly standard: 'ansi' | 'din';
      readonly table: ReadonlyArray<{ readonly rOverT: number; readonly k: number }>;
      readonly source: string;
      readonly verification: Verification;
    };

export type SheetRuleThreshold = 'holeToBend' | 'holeToEdge' | 'minFlange' | 'minLand' | 'maxDepthRatio';

export interface SheetMetalRule {
  readonly name: string;
  readonly material: string;
  readonly temper?: string;
  readonly thickness: number;
  readonly insideRadius: number;
  readonly k: KFactorSpec;
  readonly thresholds?: Readonly<Partial<Record<SheetRuleThreshold, SourcedValue>>>;
  readonly relief?: { readonly type: 'rectangular' | 'obround' | 'none'; readonly widthRatio: number; readonly depthExtra?: number };
  readonly allowSharpBends?: boolean;
}

/** Plane of a flat: origin, in-plane x axis and normal (world). */
export interface Frame3 {
  readonly origin: Vec3;
  readonly xDir: Vec3;
  readonly normal: Vec3;
}

export type Seg2 = readonly [Vec2, Vec2];

export type SheetNode =
  | { readonly id: string; readonly type: 'flat'; readonly outline: readonly Vec2[]; readonly frame: Frame3; readonly cutouts: ReadonlyArray<readonly Vec2[]> }
  | {
      readonly id: string;
      readonly type: 'bend';
      readonly from: string;
      readonly to: string;
      readonly lineInFrom: Seg2;
      /** Radians, signed: + = up. */
      readonly angle: number;
      readonly insideRadius: number;
      readonly kOverride?: number;
    }
  | {
      readonly id: string;
      readonly type: 'joggle';
      readonly on: string;
      readonly line: Seg2;
      readonly offset: number;
      readonly angle: number;
      readonly insideRadius: number;
    };

export interface SheetMetalPart {
  /** Also the id of the derived folded solid entity. */
  readonly id: string;
  readonly rule: string;
  readonly root: string;
  readonly side: 'up' | 'down' | 'mid';
  readonly nodes: Readonly<Record<string, SheetNode>>;
  readonly order: readonly string[];
}

export interface BendRadiusRow {
  readonly material: string;
  readonly temper: string;
  readonly thickness: number;
  readonly minInsideRadius: number;
  readonly units: 'mm' | 'in';
  readonly bendAngle: number;
  readonly source: string;
  readonly verification: Verification;
}

/** `CadDocument.sheetMetal`. */
export interface SheetMetalModel {
  readonly rules: Readonly<Record<string, SheetMetalRule>>;
  readonly parts: Readonly<Record<string, SheetMetalPart>>;
  readonly radiusTable: readonly BendRadiusRow[];
}
