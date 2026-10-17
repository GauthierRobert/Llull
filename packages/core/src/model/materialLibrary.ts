/**
 * Material libraries and record envelope (aerospace 08 MAT M2/M3, step AERO-3). A `Material` becomes a record by carrying a `record`
 * (designation, specs, licence, export marking); its values stay PHY-01 `PropertyModel`s. Libraries are the import / export unit; a
 * `private` library's values are never serialized (TR-MAT-31).
 */

/** Licence of a library or record (TR-MAT-30). */
export const LICENCE_FLAGS = ['public-domain-us-gov', 'licensed-no-redistribution', 'company-proprietary', 'vendor-catalogue', 'legacy'] as const;
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
  readonly unresolved?: { readonly reason: 'provider missing' | 'library missing' | 'hash mismatch' };
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
