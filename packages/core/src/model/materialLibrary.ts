/**
 * Material libraries and record envelope (aerospace 08 MAT M2/M3, step AERO-3). A `Material` becomes a record by carrying a `record`
 * (designation, specs, licence, export marking); its values stay PHY-01 `PropertyModel`s. Libraries are the import / export unit; a
 * `private` library's values are never serialized (TR-MAT-31).
 */

import type { PropertyModel } from './propertyModel';

/** Licence of a library or record (TR-MAT-30). */
export const LICENCE_FLAGS = [
  'public-domain-us-gov',
  'licensed-no-redistribution',
  'company-proprietary',
  'vendor-catalogue',
  'legacy',
] as const;
export type LicenceFlag = (typeof LICENCE_FLAGS)[number];

/** Export-control marking; the document marking is the most restrictive one in use. */
export type ExportMarking =
  | { readonly regime: 'none' }
  | { readonly regime: 'EAR99' }
  | { readonly regime: 'EAR'; readonly eccn: string }
  | { readonly regime: 'ITAR'; readonly category?: string };

export type LibraryStorage = 'embedded' | 'private';

/** Library a record came from, pinned by content hash. */
export interface LibraryRef {
  readonly libraryId: string;
  readonly version: string;
  readonly sha256: string;
}

/** Why a private-library record carries no values on this machine (TR-MAT-16). */
export type UnresolvedReason = 'provider missing' | 'library missing' | 'hash mismatch';

/** Identification of a material record (08 §3.1); hangs off `Material.record`. */
export interface MaterialRecordInfo {
  readonly id: string;
  readonly designation: string;
  readonly temper?: string;
  readonly productForm?: string;
  readonly specs: ReadonlyArray<{ readonly body: string; readonly id: string; readonly revision?: string }>;
  readonly licence: LicenceFlag;
  readonly exportMarking: ExportMarking;
  /** e.g. MIL-HDBK-5J → MMPDS. */
  readonly superseded?: { readonly by: string; readonly note: string };
  readonly libraryRef?: LibraryRef;
  /** Set on a private-library stub whose values could not be resolved on this machine (TR-MAT-16). */
  readonly unresolved?: { readonly reason: UnresolvedReason };
}

/** Per-library entry kept in the document (`CadDocument.materialLibraries`), keyed by library id. */
export interface MaterialLibraryEntry {
  readonly libraryId: string;
  readonly version: string;
  readonly sha256: string;
  readonly title: string;
  readonly storage: LibraryStorage;
  readonly licence: LicenceFlag;
  readonly exportMarking: ExportMarking;
}

/** Where a library's values were read (08 §3.2). */
interface LibrarySource {
  readonly citation: string;
  readonly url?: string;
  readonly edition?: string;
  readonly sha256?: string;
  readonly accessed?: string;
}

/** One material of a library file: record identification + its PHY-01 property models (`coefficientsSha256` is recomputed on import). */
export interface LibraryMaterial {
  readonly id: string;
  readonly name: string;
  readonly designation: string;
  readonly temper?: string;
  readonly productForm?: string;
  readonly specs: MaterialRecordInfo['specs'];
  readonly licence: LicenceFlag;
  readonly exportMarking: ExportMarking;
  readonly superseded?: { readonly by: string; readonly note: string };
  readonly color?: string;
  readonly metalness?: number;
  readonly roughness?: number;
  readonly propertyModels: ReadonlyArray<Omit<PropertyModel, 'coefficientsSha256'> & { readonly coefficientsSha256?: string }>;
}

/** The import / export unit (`*.llull-matlib.json`). Its hash is the sha256 of its canonical JSON. */
export interface MaterialLibrary {
  readonly format: 'llull-material-library';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly licence: LicenceFlag;
  readonly exportMarking: ExportMarking;
  readonly storage: LibraryStorage;
  readonly sources: Readonly<Record<string, LibrarySource>>;
  readonly materials: readonly LibraryMaterial[];
}

const MARKING_RANK: Readonly<Record<ExportMarking['regime'], number>> = { none: 0, EAR99: 1, EAR: 2, ITAR: 3 };

/** Strictness of a marking: none < EAR99 < EAR < ITAR. */
export const markingRank = (marking: ExportMarking): number => MARKING_RANK[marking.regime];

/** ITAR and EAR (with an ECCN) content needs a human before it leaves the machine; EAR99 and none do not. */
export const isControlledMarking = (marking: ExportMarking): boolean => marking.regime === 'ITAR' || marking.regime === 'EAR';

/** The stricter of two markings (the first on a tie). */
export const stricterMarking = (a: ExportMarking, b: ExportMarking): ExportMarking => (markingRank(b) > markingRank(a) ? b : a);
