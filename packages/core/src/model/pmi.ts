/**
 * Semantic product manufacturing information (03 GDT): datums, feature control frames, size / location dimensions, surface texture, notes
 * and saved views as DATA on the document. Items reference B-rep faces of a solid by `facesNear` points (re-resolved at every replay, the
 * KI5 pattern); sheets and the viewport render them, they never store geometry.
 */

import type { Vec2, Vec3 } from './vectors';
import type { ViewDirection } from './sheet';

export const PMI_STANDARDS = ['ASME_Y14.5_2018', 'ISO_GPS'] as const;
type PmiStandard = (typeof PMI_STANDARDS)[number];

/** The 15 characteristics AP242 and OCC XCAF represent. */
export const GEOMETRIC_CHARACTERISTICS = [
  'straightness',
  'flatness',
  'roundness',
  'cylindricity',
  'profile_line',
  'profile_surface',
  'angularity',
  'perpendicularity',
  'parallelism',
  'position',
  'concentricity',
  'coaxiality',
  'symmetry',
  'circular_runout',
  'total_runout',
] as const;
export type GeometricCharacteristic = (typeof GEOMETRIC_CHARACTERISTICS)[number];

/** Form tolerances: no datum reference. */
export const FORM_CHARACTERISTICS: readonly GeometricCharacteristic[] = ['straightness', 'flatness', 'roundness', 'cylindricity'];

type MaterialCondition = 'MMC' | 'LMC' | 'RFS';

export const ZONE_MODIFIERS = [
  'free_state',
  'tangent_plane',
  'statistical',
  'common_zone',
  'each_radial_element',
  'line_element',
  'not_convex',
  'any_cross_section',
  'major_diameter',
  'minor_diameter',
  'pitch_diameter',
  'separate_requirement',
  'reciprocity',
  'all_around',
  'all_over',
] as const;
export type ZoneModifier = (typeof ZONE_MODIFIERS)[number];

/** ISO 14405-1 size specification modifiers, stored as symbolic codes (E envelope, LP two-point, GG least squares, SX max, ...). */
export const SIZE_MODIFIERS = [
  'E',
  'LP',
  'LS',
  'GG',
  'GX',
  'GN',
  'GC',
  'CC',
  'CA',
  'CM',
  'CV',
  'SX',
  'SN',
  'SA',
  'SM',
  'SD',
  'SR',
] as const;
type SizeModifier = (typeof SIZE_MODIFIERS)[number];

export const DATUM_TARGET_KINDS = ['point', 'line', 'area'] as const;
type DatumTargetKind = (typeof DATUM_TARGET_KINDS)[number];

/** Surface type of a feature as the kernel reports it, or `mixed` for a set of faces of different types. */
export const PMI_SURFACES = [
  'plane',
  'cylinder',
  'cone',
  'sphere',
  'torus',
  'bspline',
  'revolution',
  'extrusion',
  'other',
  'mixed',
] as const;
export type PmiSurface = (typeof PMI_SURFACES)[number];

export const SURFACE_PARAMETERS = ['Ra', 'Rz', 'Rq', 'Rsk', 'Rku', 'Rmax', 'Sa', 'Sz'] as const;

/** A set of B-rep faces of one solid, re-resolved from points at every replay. */
export interface PmiFeature {
  readonly entityId: string;
  /** The recipe (persisted, replayed): one world point on each face, document units. */
  readonly facesNear: readonly Vec3[];
  /** Resolution on the current B-rep (derived, refreshed by every PMI command and `check_pmi`). Empty when unresolved. */
  readonly faceIndices: readonly number[];
  /** Expected surface type: a replay that resolves another type is an error. */
  readonly surface: PmiSurface;
  /** Feature of size measured from the B-rep (document units): cylinder diameter, width between two planes, sphere diameter. */
  readonly ofSize?: { readonly kind: 'cylinder' | 'width' | 'sphere'; readonly measured: number; readonly internal?: boolean };
}

export interface AnnotationPlacement {
  readonly plane: { readonly origin: Vec3; readonly normal: Vec3; readonly xDir: Vec3 };
  /** In plane coordinates, document units. */
  readonly position: Vec2;
  /** Attachment point of the leader on the feature. */
  readonly leaderTo?: Vec3;
  /** True = recomputed from the feature; false once the caller moved it. */
  readonly auto: boolean;
}

export interface DatumReference {
  readonly label: string;
  readonly boundary?: 'MMB' | 'LMB';
}

/** AF-33: items created or edited through commands need a qualified reviewer; only a human signature clears it. */
interface PmiReview {
  readonly required: boolean;
  readonly reason?: string;
  readonly acceptedBy?: string;
  readonly acceptedAt?: string;
}

interface PmiBase {
  readonly id: string;
  readonly placement: AnnotationPlacement;
  readonly name?: string;
  readonly review: PmiReview;
  /** Unresolved or unmapped input: the reason it cannot be trusted as modelled. */
  readonly unverified?: { readonly reason: string };
}

export interface DatumFeaturePmi extends PmiBase {
  readonly kind: 'datum_feature';
  readonly label: string;
  readonly feature: PmiFeature;
}

/** A datum target (point / line / area) of datum `label`; `targetNumber` is the index shown as `A1`. */
export interface DatumTargetPmi extends PmiBase {
  readonly kind: 'datum_target';
  readonly label: string;
  readonly targetNumber: number;
  readonly targetKind: DatumTargetKind;
  /** Area targets: diameter of the contact area, document units. */
  readonly areaSize?: number;
  readonly feature: PmiFeature;
}

export type PmiTolerance =
  | { readonly type: 'plusMinus'; readonly upper: number; readonly lower: number }
  | { readonly type: 'limits'; readonly upper: number; readonly lower: number }
  | { readonly type: 'fit'; readonly code: string; readonly upper: number; readonly lower: number }
  | { readonly type: 'basic' };

export interface SizeDimensionPmi extends PmiBase {
  readonly kind: 'size_dimension';
  readonly feature: PmiFeature;
  readonly sizeKind: 'diameter' | 'radius' | 'width' | 'spherical_diameter';
  readonly tolerance: PmiTolerance;
  /** Pattern count nX = resolved feature count. */
  readonly count: number;
  readonly sizeModifiers?: readonly SizeModifier[];
}

export interface LocationDimensionPmi extends PmiBase {
  readonly kind: 'location_dimension';
  readonly from: PmiFeature;
  readonly to: PmiFeature;
  readonly measure: 'distance' | 'angle';
  /** Document units, or degrees for an angle. */
  readonly measured: number;
  readonly tolerance: PmiTolerance;
}

export interface GeometricTolerancePmi extends PmiBase {
  readonly kind: 'geometric_tolerance';
  readonly characteristic: GeometricCharacteristic;
  readonly target: { readonly feature: PmiFeature } | { readonly pmiId: string };
  readonly zone: {
    readonly value: number;
    readonly diametral?: boolean;
    readonly spherical?: boolean;
    readonly projectedLength?: number;
    readonly unequallyDisposed?: number;
    readonly maxValue?: number;
  };
  readonly materialCondition: MaterialCondition;
  readonly modifiers: readonly ZoneModifier[];
  /** Ordered primary, secondary, tertiary; at most 3. */
  readonly datums: readonly DatumReference[];
  /** Composite FCF: this is the lower segment of the FCF with this id (same characteristic and target). */
  readonly compositeOf?: string;
}

export interface SurfaceTexturePmi extends PmiBase {
  readonly kind: 'surface_texture';
  readonly feature: PmiFeature;
  readonly parameter: string;
  readonly value: number;
  readonly unit: 'um' | 'uin';
  readonly lay?: string;
  readonly process?: string;
}

export interface NotePmi extends PmiBase {
  readonly kind: 'note';
  readonly text: string;
  readonly feature?: PmiFeature;
}

export type PmiItem =
  | DatumFeaturePmi
  | DatumTargetPmi
  | SizeDimensionPmi
  | LocationDimensionPmi
  | GeometricTolerancePmi
  | SurfaceTexturePmi
  | NotePmi;

export type PmiKind = PmiItem['kind'];

export const PMI_KINDS = [
  'datum_feature',
  'datum_target',
  'size_dimension',
  'location_dimension',
  'geometric_tolerance',
  'surface_texture',
  'note',
] as const satisfies readonly PmiKind[];

/** Camera of a saved view (same fields as the document camera). */
export interface PmiCamera {
  readonly target: Vec3;
  readonly azimuth: number;
  readonly polar: number;
  readonly distance: number;
}

export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly camera: PmiCamera;
  readonly pmiIds: readonly string[];
  readonly entityIds?: readonly string[];
  readonly section?: { readonly direction: ViewDirection; readonly offset: number };
}

/** What the latest AP242 / `apply_pmi_set` import brought in (03 TR-GDT-13): counts, never silently dropped. */
export interface PmiImportRecord {
  /** File name or caller-given source label. */
  readonly source: string;
  /** Items created. */
  readonly items: number;
  /** Items kept with no resolved face (`faceIndices: []`, unverified). */
  readonly unresolved: number;
  /** Source items the model cannot represent (unknown characteristic or dimension type), not created. */
  readonly unmapped: number;
}

/** Absent on the document until the first PMI command. */
export interface PmiModel {
  readonly standard: PmiStandard;
  readonly generalToleranceNote?: string;
  readonly items: Record<string, PmiItem>;
  /** Item ids in creation order. */
  readonly order: string[];
  readonly savedViews: Record<string, SavedView>;
  readonly savedViewOrder: string[];
  /** View-state: the saved view `activate_saved_view` last applied (the viewport shows only its PMI); carried across replay. */
  readonly activeSavedViewId?: string;
  /** Totals of the latest import (`apply_pmi_set`, the PMI stage of `import_step_exact`). */
  readonly import?: PmiImportRecord;
}
