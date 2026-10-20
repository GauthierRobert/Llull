/**
 * Optional exchange ports of the kernel (aerospace 04 XCH M2..M4, TECHNICAL_SPEC §2.3): an XDE-style product tree for the AP242 / AP214 / AP203
 * writer and the STEP product-tree reader, plus the IGES read / write. Like the other optional ports they answer null when they cannot
 * perform the call (Manifold has none) and never throw.
 *
 * Deviation from the spec sketch: a placement is `position` + Euler `rotation` (the `StepOccurrence` convention) rather than a 4x4, so the
 * existing assembly plan feeds the writer unchanged; a read placement is a row-major 3x4 rigid matrix and the importer converts it.
 */

import type { DocumentUnit, Vec3 } from '../model/types';
import type { ImportedShapes, ImportedSolid } from './kernelPorts';
import type { ShapeHandle } from './kernelTypes';

export type StepSchema = 'ap242' | 'ap214' | 'ap203';

/** Volume, area and centroid of a product in the file's (document) unit: written as the geometric validation properties of the product. */
export interface ExchangeValidation {
  readonly volume: number;
  readonly area: number;
  readonly centroid: Vec3;
}

export interface ExchangeSolid {
  readonly shape: ShapeHandle;
  readonly name?: string;
  /** `#rrggbb`. */
  readonly color?: string;
}

/**
 * Semantic PMI transport (04 XCH V1 hook for 03 GD&T M6): a product's datums, dimensions and geometric tolerances attached to FACES of its shape. `faces` are
 * 0-based indices of the product's shape in `TopExp::MapShapes` order (the `ShapeTopology.faces` numbering of a single-solid product); values are in the
 * document unit when written and in millimetres when read. AP242 only; a dimension deviation is a magnitude (nominal - minus <= x <= nominal + plus).
 */
type PmiCharacteristic =
  | 'angularity'
  | 'circular_runout'
  | 'circularity'
  | 'coaxiality'
  | 'concentricity'
  | 'cylindricity'
  | 'flatness'
  | 'parallelism'
  | 'perpendicularity'
  | 'position'
  | 'profile_line'
  | 'profile_surface'
  | 'straightness'
  | 'symmetry'
  | 'total_runout';

type PmiDimensionType =
  | 'size_diameter'
  | 'size_radius'
  | 'size_spherical_diameter'
  | 'size_spherical_radius'
  | 'size_thickness'
  | 'size_curve_length'
  | 'size_angular'
  | 'location_linear_distance'
  | 'location_angular';

/** Tolerance modifiers of the transport (ISO 1101 / ASME Y14.5 symbols that follow the zone value or the frame). */
type PmiToleranceModifier =
  | 'any_cross_section'
  | 'common_zone'
  | 'each_radial_element'
  | 'free_state'
  | 'least_material_requirement'
  | 'line_element'
  | 'major_diameter'
  | 'maximum_material_requirement'
  | 'minor_diameter'
  | 'not_convex'
  | 'pitch_diameter'
  | 'reciprocity_requirement'
  | 'separate_requirement'
  | 'statistical_tolerance'
  | 'tangent_plane'
  | 'all_around'
  | 'all_over';

/** Datum modifiers: boundary (maximum / least material requirement = MMB / LMB), contacting feature, degrees-of-freedom constraints, ... */
type PmiDatumModifier =
  | 'any_cross_section'
  | 'any_longitudinal_section'
  | 'basic'
  | 'contacting_feature'
  | 'dof_constraint_u'
  | 'dof_constraint_v'
  | 'dof_constraint_w'
  | 'dof_constraint_x'
  | 'dof_constraint_y'
  | 'dof_constraint_z'
  | 'distance_variable'
  | 'free_state'
  | 'least_material_requirement'
  | 'line'
  | 'major_diameter'
  | 'maximum_material_requirement'
  | 'minor_diameter'
  | 'orientation'
  | 'pitch_diameter'
  | 'plane'
  | 'point'
  | 'translation';

/** Size-dimension modifiers (ISO 14405-1 specification modifiers and ASME qualifiers). */
type PmiDimensionModifier =
  | 'controlled_radius'
  | 'square'
  | 'statistical_tolerance'
  | 'continuous_feature'
  | 'two_point_size'
  | 'local_size_defined_by_sphere'
  | 'least_squares_association'
  | 'maximum_inscribed_association'
  | 'minimum_circumscribed_association'
  | 'circumference_diameter'
  | 'area_diameter'
  | 'volume_diameter'
  | 'maximum_size'
  | 'minimum_size'
  | 'average_size'
  | 'median_size'
  | 'mid_range_size'
  | 'range_of_sizes'
  | 'any_restricted_portion'
  | 'any_cross_section'
  | 'specific_fixed_cross_section'
  | 'common_tolerance'
  | 'free_state_condition'
  | 'between';

interface ExchangePmiDatum {
  readonly label: string;
  /** Faces of the datum feature. Empty when the file's feature is not a face of the product (a datum target: point, line, area; or an edge). */
  readonly faces: readonly number[];
  /** Datum modifiers; `maximum_material_requirement` / `least_material_requirement` are the datum boundary MMB / LMB. */
  readonly modifiers?: readonly PmiDatumModifier[];
  /** Modifier that carries a value: a sphere / cylinder of that size, a distance, a projected length. */
  readonly modifierWithValue?: {
    readonly kind: 'circular_or_cylindrical' | 'distance' | 'projected' | 'spherical';
    readonly value: number;
  };
}

interface ExchangePmiTolerance {
  readonly characteristic: PmiCharacteristic;
  readonly value: number;
  readonly diameterZone: boolean;
  /** A spherical zone (SR / S diameter); with `diameterZone` false. */
  readonly sphericalZone?: boolean;
  readonly faces: readonly number[];
  /** Datum labels in reference order, primary first; each must be one of `datums`. */
  readonly datums: readonly string[];
  /** Material condition of the tolerance zone: M (maximum) / L (least); absent = regardless of feature size. */
  readonly materialRequirement?: 'maximum' | 'least';
  /** Zone modifier: P (projected, with `zoneModifierValue` the projected length), runout, non-uniform. */
  readonly zoneModifier?: 'projected' | 'runout' | 'non_uniform';
  readonly zoneModifierValue?: number;
  readonly modifiers?: readonly PmiToleranceModifier[];
  /** Maximum value of the tolerance when the frame states one ("0.1 MAX"). */
  readonly maxValue?: number;
}

interface ExchangePmiDimension {
  readonly type: PmiDimensionType;
  readonly value: number;
  readonly tolerance?: { readonly plus: number; readonly minus: number };
  readonly faces: readonly number[];
  /** Locations: the second feature set. */
  readonly facesSecond?: readonly number[];
  readonly qualifier?: 'min' | 'max' | 'avg';
  readonly modifiers?: readonly PmiDimensionModifier[];
  /** Dimension given as limits (lower / upper bound) instead of a nominal with deviations. */
  readonly range?: { readonly lower: number; readonly upper: number };
  /** ISO 286 fit class: hole / shaft, form variance letters (H, js, ...) and IT grade. */
  readonly classOfTolerance?: { readonly hole: boolean; readonly variance: string; readonly grade: string };
}

export interface ExchangePmi {
  readonly datums: readonly ExchangePmiDatum[];
  readonly tolerances: readonly ExchangePmiTolerance[];
  readonly dimensions: readonly ExchangePmiDimension[];
}

/** One STEP product (a component, or one free solid): its solids, written once however often it is placed. */
export interface ExchangeProduct {
  /** Stable key (component id or entity id) the occurrences refer to. */
  readonly key: string;
  readonly name: string;
  /** PRODUCT description (an entity's group name). */
  readonly description?: string;
  readonly color?: string;
  readonly layer?: string;
  /** Density in g/cm3 (OCCT's material unit). */
  readonly material?: { readonly name: string; readonly density: number };
  readonly solids: readonly ExchangeSolid[];
  readonly validation?: ExchangeValidation;
  /** Semantic PMI attached to faces of the product's shape (AP242 only). */
  readonly pmi?: ExchangePmi;
}

/** One placed use of `product` inside `parent` (a product key; null = the root assembly): NEXT_ASSEMBLY_USAGE_OCCURRENCE. */
export interface ExchangeOccurrence {
  readonly parent: string | null;
  readonly product: string;
  readonly name?: string;
  readonly position: Vec3;
  /** Radians; llull's M = T . Rx . Ry . Rz. */
  readonly rotation: Vec3;
}

export interface ExchangeWriteRequest {
  readonly format: 'step' | 'iges';
  /** STEP only; default 'ap242'. */
  readonly schema?: StepSchema;
  /** The file is written in this unit with the document's own numbers. */
  readonly unit: DocumentUnit;
  readonly products: readonly ExchangeProduct[];
  readonly occurrences: readonly ExchangeOccurrence[];
  /** Name of the root assembly written when an occurrence has `parent: null`. */
  readonly rootName?: string;
  readonly rootValidation?: ExchangeValidation;
  /** IGES only: 'brep' (default, solids) or 'faces' (trimmed surfaces for legacy CAM). */
  readonly igesMode?: 'brep' | 'faces';
  readonly header: { readonly fileName: string; readonly originatingSystem: string; readonly timestamp: string };
}

/** A product of a read STEP file: simple (its healed solids, product-local coordinates) or an assembly (placed uses of other products). */
export interface ImportedProduct {
  readonly name: string;
  /** Every name the product answers to after wrapper products were folded into it (the name itself first); validation properties match any of them. */
  readonly aliases?: readonly string[];
  readonly assembly: boolean;
  readonly color?: string;
  readonly layers: readonly string[];
  /** Indices into `ImportedExchange.solids`. */
  readonly solids: readonly number[];
  /** Semantic PMI read from the file (lengths in millimetres); faces number the product's shape as read, before healing. */
  readonly pmi?: ExchangePmi;
  /** The validation attributes OCCT attached to the product, in millimetres (mm, mm2, mm3). */
  readonly validation?: { readonly volume: number; readonly area: number; readonly centroid?: Vec3 };
}

/** `parent` = -1 for a free product placed at the origin; `matrix` = row-major 3x4 rigid placement in millimetres. */
export interface ImportedOccurrence {
  readonly parent: number;
  readonly product: number;
  readonly name: string;
  readonly matrix: readonly number[];
}

export interface ImportedExchange extends ImportedShapes {
  readonly solids: readonly ImportedSolid[];
  readonly products: readonly ImportedProduct[];
  readonly occurrences: readonly ImportedOccurrence[];
  /** PMI items the file holds that name no product face or an unknown characteristic. */
  readonly pmiUnmapped?: number;
  /** Free products (indices), the roots of the tree. */
  readonly roots: readonly number[];
}

/** An IGES read: solids after sewing and healing (no product tree), the sewing tolerance used (mm) and the shape bounding-box diagonal (mm). */
export interface ImportedIges extends ImportedShapes {
  readonly sewingToleranceMm: number;
  readonly diagonalMm: number;
}

export type ImportExchangeResult =
  | ImportedExchange
  | ImportedIges
  | { readonly error: 'unreadable' | 'no_solid' | 'tessellated_only' | 'unavailable'; readonly detail: string };

export interface ImportExchangeOptions {
  readonly precision: number;
  readonly maxTolerance: number;
  readonly heal: boolean;
  readonly sew: boolean;
  /** IGES only: the file's own minimum resolution (mm); the sewing tolerance is max(this, 1e-6 x diagonal, precision). */
  readonly fileResolutionMm?: number;
}
