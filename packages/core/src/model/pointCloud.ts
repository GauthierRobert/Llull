/**
 * Point clouds (plant 10 SCN, TECHNICAL_SPEC §3): the read-only port a host installs (`ExecutionContext.pointClouds`) and the document
 * slice of the `scan` plugin. A cloud is an external, content-addressed asset (TR-SCN-01): the document holds references, registrations
 * and extraction records, never points (TR-SCN-04). Assets are metres in the asset (file) frame; commands convert to document units.
 */

import type { Vec3 } from './vectors';

export type CloudFormat = 'e57' | 'las' | 'laz' | 'xyz' | 'pts' | 'csv';
export type CloudAttribute = 'intensity' | 'rgb' | 'classification' | 'returnNumber' | 'numberOfReturns' | 'gpsTime' | 'normal';

/** Row-major 4 × 4 rigid transform (16 numbers), translation in metres (column 3). */
export type Mat4 = readonly number[];

export interface CloudScan {
  readonly guid: string | null;
  readonly name: string | null;
  readonly pointCount: number;
  readonly recordCount: number;
  readonly pose: { readonly rotationWxyz: readonly [number, number, number, number]; readonly translation: Vec3 };
  readonly stationOrigin: Vec3 | null;
  readonly fields: readonly string[];
}

export interface CloudBounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** `manifest.json` of an asset (written by `llull-compute cloud import`, immutable). */
export interface CloudManifest {
  readonly assetVersion: number;
  readonly assetKey: string;
  readonly sourceSha256: string;
  readonly sourceName: string;
  readonly format: CloudFormat;
  readonly importerVersion: string;
  readonly unit: 'm';
  readonly pointCount: number;
  readonly dropped: number;
  readonly scans: readonly CloudScan[];
  /** Recomputed from the data, never copied from a header. */
  readonly bounds: CloudBounds;
  readonly centroid: Vec3;
  /** LAS only, when the header disagrees with the data (SCN_LAS_HEADER_BOUNDS). */
  readonly headerBounds?: CloudBounds;
  /** Coordinate step of the stored codes (m) and their offset: x = code·quantum + offset. */
  readonly quantum: Vec3;
  readonly offset: Vec3;
  readonly attributes: readonly CloudAttribute[];
  readonly crs?: { readonly wkt?: string; readonly epsg?: number };
  readonly octree: {
    readonly depth: number;
    readonly rootBits: number;
    readonly rootMin: Vec3;
    readonly rootSpacing: number;
    readonly maxPointsPerNode: number;
    readonly nodeCount: number;
  };
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

/** A bounded read of an asset, in the asset frame (metres). */
export interface CloudQuery {
  readonly box?: CloudBounds;
  readonly sphere?: { readonly centre: Vec3; readonly radius: number };
  /** `full`: every point in the region; `budget`: the LOD rule of §5.3 seen from the region centre. */
  readonly lod: 'full' | { readonly budget: number };
  /** Hard cap, never exceeded (the result says `truncated`). */
  readonly maxPoints: number;
}

/** Points in canonical order (node order, then in-node order). */
export interface CloudPoints {
  /** xyz in metres, asset frame. */
  readonly positions: Float64Array;
  /** Source record index of each point. */
  readonly indices: Uint32Array;
  readonly truncated: boolean;
  /** Effective point spacing of the returned set (the deepest level read), metres. */
  readonly spacing: number;
}

export interface CloudNearest {
  readonly index: number;
  readonly position: Vec3;
  readonly distance: number;
  /** Distance of the next point (ambiguity check); Infinity when there is none. */
  readonly secondDistance: number;
}

/**
 * One heavy query run by the host in `llull-compute cloud op` (§2.A). Coordinates are metres in the DOCUMENT frame: each cloud travels with
 * its asset → document transform (`toDocument`), so the result needs no frame change, only unit conversion by the plugin.
 */
export interface CloudOp {
  readonly kind: string;
  readonly clouds: readonly { readonly assetKey: string; readonly toDocument: Mat4 }[];
  readonly params: Readonly<Record<string, unknown>>;
}

/** A failed op: stable code (SCN_*, NATIVE_*) and message. */
export interface CloudOpFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export interface CloudOpSuccess {
  readonly ok: true;
  readonly result: Readonly<Record<string, unknown>>;
  readonly provenance: {
    readonly binary: string;
    readonly device: 'cpu' | 'gpu';
    readonly deterministic: boolean;
    readonly elapsedMs: number;
  };
  /** Warning events of the native job (e.g. SCN_GPU_FALLBACK). */
  readonly warnings?: readonly { readonly code: string; readonly message: string }[] | undefined;
}

export type CloudOpResult = CloudOpSuccess | CloudOpFailure;

/** Read-only access to the cloud assets of this machine (`ExecutionContext.pointClouds`; absent / null = SCN_ASSET_UNAVAILABLE). */
export interface PointCloudPort {
  manifest(assetKey: string): CloudManifest | null;
  query(assetKey: string, query: CloudQuery): CloudPoints | null;
  nearest(assetKey: string, point: Vec3, maxDistance: number): CloudNearest | null;
  /** Runs a heavy op synchronously; null when the asset is unknown. */
  compute(op: CloudOp): CloudOpResult | null;
}

export type ColorBy = 'rgb' | 'intensity' | 'elevation' | 'classification' | 'single';

export interface CloudReference {
  /** Step-scoped id `cloud-<step>.<k>` (L8). */
  readonly id: string;
  readonly name: string;
  readonly assetKey: string;
  readonly sourceSha256: string;
  readonly placement: 'local' | 'grid';
  /** Asset frame → document frame, metres (registration applied); affine (a `grid` placement carries the site scale factor). */
  readonly transform: Mat4;
  readonly registrationId: string | null;
  readonly display: { readonly visible: boolean; readonly colorBy: ColorBy; readonly pointSize: number };
}

export type RegistrationMethod = 'targets' | 'icp_point_to_point' | 'icp_point_to_plane' | 'targets+icp' | 'supplied';

export interface RegistrationQuality {
  readonly targetResiduals?: readonly { readonly name: string; readonly residual: number }[] | undefined;
  /** Metres. */
  readonly rms: number;
  readonly overlap?: number | undefined;
  readonly iterations?: number | undefined;
  readonly converged: boolean;
}

export interface ScanProvenance {
  readonly method: string;
  readonly algorithmVersion: string;
  readonly seed?: number | undefined;
  readonly thresholds?: Readonly<Record<string, number>> | undefined;
  readonly device?: 'cpu' | 'gpu' | undefined;
  readonly deterministic?: boolean | undefined;
}

export interface RegistrationRecord {
  readonly id: string;
  /** Cloud ids; `moving` gets the transform. */
  readonly fixed: string;
  readonly moving: string;
  readonly method: RegistrationMethod;
  /** Moving asset frame → fixed asset frame (metres). Applied as moving.transform = fixed.transform · transform. */
  readonly transform: Mat4;
  readonly quality: RegistrationQuality | null;
  readonly status: 'computed' | 'accepted' | 'unverified';
  readonly acceptedBy?: { readonly signer: string; readonly signatureId: string };
  readonly provenance: ScanProvenance;
}

export type RegionSpec =
  | { readonly kind: 'all' }
  | { readonly kind: 'box'; readonly min: Vec3; readonly max: Vec3 }
  | { readonly kind: 'seed'; readonly point: Vec3; readonly radius: number }
  | { readonly kind: 'crop'; readonly cropId: string };

export interface ExtractionRecord {
  readonly id: string;
  readonly kind: 'pipe';
  readonly cloudId: string;
  readonly assetKey: string;
  readonly region: RegionSpec;
  /** Cylinder fit in metres, document frame (axis point / direction, radius, ends, quality). */
  readonly fit: Readonly<Record<string, unknown>>;
  readonly snapped?: {
    readonly table: 'en10220';
    readonly dn: number | null;
    readonly odMm: number;
    readonly toleranceMm: number;
    readonly defaulted: boolean;
  };
  /** The cloud transform the fit was made in (stale check). */
  readonly cloudTransform: Mat4;
  readonly createdElementIds: readonly string[];
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly status: 'computed' | 'accepted';
  readonly acceptedBy?: { readonly signer: string; readonly signatureId: string };
  /** sha256 of the canonical { kind, cloudId, assetKey, region, fit, snapped, cloudTransform } (tamper check at commit). */
  readonly extractionHash: string;
  readonly provenance: ScanProvenance;
}

export interface CropBox {
  readonly id: string;
  readonly name: string;
  /** Empty = every cloud. */
  readonly cloudIds: readonly string[];
  /** Document frame and units. */
  readonly min: Vec3;
  readonly max: Vec3;
  readonly keep: 'inside' | 'outside';
}

/** `CadDocument.scan`: absent until the first scan command. */
export interface ScanModel {
  readonly clouds: Readonly<Record<string, CloudReference>>;
  readonly cloudOrder: readonly string[];
  readonly registrations: Readonly<Record<string, RegistrationRecord>>;
  readonly extractions: Readonly<Record<string, ExtractionRecord>>;
  readonly crops: Readonly<Record<string, CropBox>>;
}
