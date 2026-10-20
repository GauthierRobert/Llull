/**
 * Pipe extractions (TECHNICAL_SPEC §5.6, FR-SCN-13): the DN snap on llull's EN 10220 / ASME B36.10M table (`PIPE_SIZES`, tolerance
 * `OUTSIDE_DIAMETER_TOLERANCE_MM`), the unverified flags, and the record a commit verifies by its hash (TR-SCN-04: the commit carries every
 * number, so replay never needs the cloud).
 */

import type { CloudReference, ExtractionRecord, RegionSpec, ScanModel } from '@core/model/pointCloud';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { OUTSIDE_DIAMETER_TOLERANCE_MM, PIPE_SIZES } from '../industrial/piping/pipeSizes';

export interface DnSnap {
  readonly table: 'en10220';
  readonly dn: number | null;
  readonly odMm: number;
  readonly toleranceMm: number;
  readonly defaulted: boolean;
}

/**
 * The table row whose OD is within the tolerance of `odMm` (nearest when two were, which the table's ≥ 5.6 mm steps rule out at 1.5 mm).
 * No row: dn null and the measured OD kept (SCN_FIT_NO_STANDARD_SIZE).
 */
export function snapDn(odMm: number, toleranceMm?: number): DnSnap {
  const tolerance = toleranceMm ?? OUTSIDE_DIAMETER_TOLERANCE_MM;
  const rows = PIPE_SIZES.filter(([, od]) => Math.abs(od - odMm) <= tolerance).sort(
    (a, b) => Math.abs(a[1] - odMm) - Math.abs(b[1] - odMm),
  );
  const row = rows[0];
  return { table: 'en10220', dn: row?.[0] ?? null, odMm: row?.[1] ?? odMm, toleranceMm: tolerance, defaulted: toleranceMm === undefined };
}

/** The extraction as a query returns it: everything but the commit-time fields. */
export type PendingExtraction = Omit<ExtractionRecord, 'id' | 'createdElementIds' | 'status' | 'acceptedBy'>;

/** sha256 of the canonical content (tamper check at commit). */
export function extractionHash(extraction: Omit<PendingExtraction, 'extractionHash'>): string {
  const { kind, cloudId, assetKey, region, fit, snapped, cloudTransform, unverified, unverifiedReasons, provenance } = extraction;
  return sha256Hex(
    canonicalJson({
      kind,
      cloudId,
      assetKey,
      region,
      fit,
      snapped: snapped ?? null,
      cloudTransform,
      unverified,
      unverifiedReasons,
      provenance,
    }),
  );
}

/** Why scan-derived numbers of `cloud` are unverified (registration status, fit quality warnings). */
export function unverifiedReasons(scan: ScanModel, cloud: CloudReference, fitWarnings: readonly string[]): string[] {
  const registration =
    cloud.registrationId !== null && Object.hasOwn(scan.registrations, cloud.registrationId)
      ? scan.registrations[cloud.registrationId]
      : undefined;
  return [
    ...(registration?.status === 'unverified' ? [`registration ${registration.id} is unverified (${registration.method})`] : []),
    ...fitWarnings.filter((code) => code === 'SCN_FIT_LOW_COVERAGE' || code === 'SCN_FIT_HIGH_RMS').map((code) => `fit quality: ${code}`),
  ];
}

export function pendingExtraction(
  cloud: CloudReference,
  region: RegionSpec,
  fit: Readonly<Record<string, unknown>>,
  snapped: DnSnap | undefined,
  reasons: readonly string[],
  provenance: PendingExtraction['provenance'],
): PendingExtraction {
  const content = {
    kind: 'pipe' as const,
    cloudId: cloud.id,
    assetKey: cloud.assetKey,
    region,
    fit,
    ...(snapped !== undefined ? { snapped } : {}),
    cloudTransform: cloud.transform,
    unverified: reasons.length > 0,
    unverifiedReasons: [...reasons],
    provenance,
  };
  return { ...content, extractionHash: extractionHash(content) };
}
