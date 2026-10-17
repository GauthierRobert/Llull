/**
 * Sheet-metal part graph (aerospace 07 FTR §3.3, step AERO-3), owned by the `sheetmetal` plugin (`CadDocument.sheetMetal`, validated
 * by its `DocumentExtension`). Lengths are in the document unit, angles in radians inside the model (degrees at the command boundary).
 *
 * Geometry conventions (all lengths measured on the part's reference plane, the plane z = 0 of each flat's frame):
 * - a flat's 2D `outline` / `cutouts` are CCW in its own frame (`frame.xDir`, `normal × xDir`, `normal`);
 * - material of every flat occupies z in [zBottom, zBottom + T] of its frame, zBottom = 0 (side up), -T (down), -T/2 (mid);
 * - a bend's `lineInFrom` runs p -> q in the `from` flat's frame; the material of `from` lies on the RIGHT of p -> q, the child flat on the
 *   LEFT (outward normal = rot90(q - p)); a positive angle bends the child towards `from`'s +normal ("up");
 * - the child flat's own frame has its origin at the far tangent line's start, `xDir` along p -> q and `y` pointing away from the bend, so
 *   its outline starts at y = 0 (`computeChildFrame` in the plugin derives it from the parent frame).
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

/** A hole in a flat; `circle` keeps the exact circle that `points` approximates (DXF CIRCLE, exact kernel cut). */
export interface SheetCutout {
  readonly points: readonly Vec2[];
  readonly circle?: { readonly center: Vec2; readonly radius: number };
}

export type SheetNode =
  | {
      readonly id: string;
      readonly type: 'flat';
      readonly outline: readonly Vec2[];
      readonly frame: Frame3;
      readonly cutouts: readonly SheetCutout[];
    }
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
      /** Record of a joggle: two reverse bends (`bends`) around the inclined flat `incline`, followed by flat `after`. */
      readonly id: string;
      readonly type: 'joggle';
      readonly on: string;
      readonly bends: readonly [string, string];
      readonly incline: string;
      readonly after: string;
      readonly line: Seg2;
      readonly offset: number;
      /** Radians, > 0. */
      readonly angle: number;
      readonly insideRadius: number;
    }
  | {
      /** Record of a rectangular relief notch cut into the parent flat beside the end of a bend. */
      readonly id: string;
      readonly type: 'relief';
      readonly bend: string;
      readonly end: 'start' | 'end';
      readonly width: number;
      readonly depth: number;
    };

export interface SheetMetalPart {
  /** Also the id of the derived folded solid entity (native parts). */
  readonly id: string;
  readonly rule: string;
  readonly root: string;
  readonly side: 'up' | 'down' | 'mid';
  readonly nodes: Readonly<Record<string, SheetNode>>;
  readonly order: readonly string[];
  /** Set for parts built by `convert_to_sheet_metal`: the exact solid they describe (no derived folded solid). */
  readonly sourceEntity?: string;
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
