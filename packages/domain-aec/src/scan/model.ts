/** Access to `CadDocument.scan` (plugin `scan`) and unit conversion between document units and asset metres. */

import type { CloudReference, ScanModel } from '@core/model/pointCloud';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { MM_PER_UNIT } from '@core/model/units';

export const EMPTY_SCAN: ScanModel = { clouds: {}, cloudOrder: [], registrations: {}, extractions: {}, crops: {} };

export const scanOf = (doc: CadDocument): ScanModel => doc.scan ?? EMPTY_SCAN;

export const withScan = (doc: CadDocument, scan: ScanModel): CadDocument => ({ ...doc, scan });

export function findCloud(doc: CadDocument, cloudId: string): CloudReference | undefined {
  const scan = scanOf(doc);
  return Object.hasOwn(scan.clouds, cloudId) ? scan.clouds[cloudId] : undefined;
}

/** Clouds in attach order. */
export const cloudsOf = (doc: CadDocument): CloudReference[] =>
  scanOf(doc).cloudOrder.flatMap((id) => {
    const cloud = findCloud(doc, id);
    return cloud === undefined ? [] : [cloud];
  });

/** Metres per document unit. */
export const metresPerUnit = (doc: Pick<CadDocument, 'units'>): number => MM_PER_UNIT[doc.units] / 1000;

export const toM = (doc: Pick<CadDocument, 'units'>, value: number): number => value * metresPerUnit(doc);

export const fromM = (doc: Pick<CadDocument, 'units'>, metres: number): number => metres / metresPerUnit(doc);

export const vecToM = (doc: Pick<CadDocument, 'units'>, v: readonly number[]): Vec3 => [
  toM(doc, v[0] ?? 0),
  toM(doc, v[1] ?? 0),
  toM(doc, v[2] ?? 0),
];

export const vecFromM = (doc: Pick<CadDocument, 'units'>, v: readonly number[]): Vec3 => [
  fromM(doc, v[0] ?? 0),
  fromM(doc, v[1] ?? 0),
  fromM(doc, v[2] ?? 0),
];
