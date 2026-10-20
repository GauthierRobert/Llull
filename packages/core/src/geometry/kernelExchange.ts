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
