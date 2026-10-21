/** Document slice of the `scan` plugin (`CadDocument.scan`, plant 10 SCN): references, registrations and extraction records, never points (TR-SCN-04). */

import type { Vec3 } from '@core/model/vectors';
import type { Mat4 } from '@core/model/pointCloud';

type ColorBy = 'rgb' | 'intensity' | 'elevation' | 'classification' | 'single';

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

type RegistrationMethod = 'targets' | 'icp_point_to_point' | 'icp_point_to_plane' | 'targets+icp' | 'supplied';

interface RegistrationQuality {
  readonly targetResiduals?: readonly { readonly name: string; readonly residual: number }[] | undefined;
  /** Metres. */
  readonly rms: number;
  readonly overlap?: number | undefined;
  readonly iterations?: number | undefined;
  readonly converged: boolean;
}

interface ScanProvenance {
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

declare module '@core/model/documentExtensions' {
  interface DocumentExtensions {
    /** Point-cloud references, registrations and extractions (plugin `scan`, plant 10); absent until the first scan command. No points. */
    scan?: ScanModel;
  }
}
