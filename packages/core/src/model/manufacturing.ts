/**
 * Agent-first result and refusal contract of the manufacturing features (aerospace 07 FTR §4.3 / §7.2, step AERO-3), shared by the core
 * feature commands (`add_hole`, `recognize_features`, `check_machining`, …) and the `sheetmetal` plugin.
 * @invariant `FTR_CODES` is a public contract (TR-FTR-03): codes are only ever added, never renamed
 */

export const FTR_CODES = [
  'FTR_K_FACTOR_MISSING',
  'FTR_K_FACTOR_OUT_OF_RANGE',
  'FTR_BEND_ANGLE_OUT_OF_RANGE',
  'FTR_SHARP_BEND_FORBIDDEN',
  'FTR_BEND_RADIUS_BELOW_MIN',
  'FTR_BEND_RADIUS_NO_TABLE_ROW',
  'FTR_TABLE_ROW_NO_SOURCE',
  'FTR_RULE_NOT_FOUND',
  'FTR_PART_NOT_FOUND',
  'FTR_PROFILE_NOT_CLOSED',
  'FTR_EDGE_NOT_STRAIGHT',
  'FTR_JOGGLE_OFFSET_TOO_SMALL',
  'FTR_JOGGLE_LINE_INVALID',
  'FTR_EDGE_OCCUPIED',
  'FTR_RELIEF_INVALID',
  'FTR_CUTOUT_INVALID',
  'FTR_PARAM_INVALID',
  'FTR_HOLE_TO_BEND_TOO_CLOSE',
  'FTR_HOLE_TO_EDGE_TOO_CLOSE',
  'FTR_FLANGE_TOO_SHORT',
  'FTR_RELIEF_MISSING',
  'FTR_NOT_SHEET_METAL',
  'FTR_NON_DEVELOPABLE',
  'FTR_FACE_NOT_FOUND',
  'FTR_FACE_NOT_PLANAR',
  'FTR_HOLE_POINT_OUTSIDE_FACE',
  'FTR_HOLE_DIAMETERS_INCONSISTENT',
  'FTR_CSK_ANGLE_OUT_OF_RANGE',
  'FTR_BLIND_DEPTH_INVALID',
  'FTR_FASTENER_CATALOG_UNAVAILABLE',
  'FTR_THREAD_DESIGNATION_INVALID',
  'FTR_POCKET_FILLET_GT_CORNER',
  'FTR_POCKET_DEPTH_EXCEEDS_STOCK',
  'FTR_CSK_KNIFE_EDGE',
  'FTR_CSK_LAND_BELOW_MIN',
  'FTR_POCKET_CORNER_BELOW_TOOL_RADIUS',
  'FTR_HOLE_DEPTH_RATIO_HIGH',
  'FTR_RULE_THRESHOLD_MISSING',
  'FTR_UNVERIFIED_DATA',
  'FTR_WAIVER_NOT_APPROVED',
  'FTR_NEEDS_EXACT_KERNEL',
  'FTR_RECOGNITION_AMBIGUOUS',
  'FTR_DRILL_POINT_ANGLE_OUT_OF_RANGE',
  'FTR_FEATURE_BUILD_FAILED',
  'FTR_POCKET_CORNER_TOO_LARGE',
] as const;

export type FtrCode = (typeof FTR_CODES)[number];

/** Review note every FTR query carries (FR-FTR-37, AF-33). */
export const FTR_REVIEW_REASON = 'computed by llull, not approved — a qualified person must review before manufacture';

/** A value that may have been defaulted (AF-31). */
export interface Named<T> {
  readonly value: T;
  readonly source: string;
  readonly defaulted: boolean;
  readonly verification: 'verified' | 'unverified';
}

export interface FtrUnverifiedInput {
  readonly kind: 'radius_row' | 'k_table' | 'preset' | 'catalogue';
  readonly id: string;
  readonly source: string;
}

/** Carried by every FTR query result (AF-10, AF-32, AF-33, AF-35). */
export interface FtrResultMeta {
  readonly lengthUnit: 'mm' | 'cm' | 'm' | 'in' | 'ft';
  readonly angleUnit: 'deg';
  readonly unverified: boolean;
  readonly unverifiedInputs: readonly FtrUnverifiedInput[];
  readonly reviewRequired: true;
  readonly reviewReason: string;
  readonly provenance: {
    readonly formulas: Readonly<Record<string, string>>;
    readonly inputs: Readonly<
      Record<string, { readonly value: number | string; readonly unit?: string; readonly source: string; readonly defaulted?: boolean }>
    >;
    readonly sources: readonly string[];
  };
}

export interface FtrFinding {
  readonly code: FtrCode;
  readonly severity: 'fail' | 'warn' | 'info';
  readonly ids: readonly string[];
  readonly value?: number;
  readonly limit?: number;
  readonly unit?: string;
  readonly source?: string;
  readonly remediation: string;
}

/** Waiver of a check finding; honoured only with a human-signed gap 09 approval (TR-FTR-08). */
export interface FtrWaiver {
  readonly code: FtrCode;
  readonly ids: readonly string[];
  readonly approvalRef: string;
}

export interface FtrCheckData extends FtrResultMeta {
  readonly status: 'pass' | 'warn' | 'fail';
  readonly findings: readonly FtrFinding[];
  readonly rulesApplied: readonly string[];
  readonly rulesSkipped: ReadonlyArray<{
    readonly rule: string;
    readonly code: 'FTR_RULE_THRESHOLD_MISSING' | 'FTR_BEND_RADIUS_NO_TABLE_ROW';
  }>;
}

/** Refusal payload (`CommandResult.error` / `data.error`) of an FTR command. */
export interface FtrRefusal {
  readonly code: FtrCode;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly remediation: string;
}
