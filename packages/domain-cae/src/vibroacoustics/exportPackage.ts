/** The `llull.acousticLoad/1` package (TECHNICAL_SPEC §6): the spectrum, its band PSD, the exposed faces with exact areas, provenance and the review flags. */

import { bandRows } from './bandReport';
import { unverifiedItem, type VacItem } from './codes';
import { energySumDb, overallPressurePa } from './math/levels';
import type { AcousticExposure, AcousticSpectrum } from './types';

/** Fixed precision of exported areas (mm^2) and centroids (mm): the kernel build must not change a saved package. */
const PER_UNIT = 1e6;
const fixed = (value: number): number => Math.round(value * PER_UNIT) / PER_UNIT;

/** One exposed face from the exact kernel (`inspect_faces`), converted to millimetres. */
export interface ExposedFace {
  readonly entityId: string;
  readonly faceIndex: number;
  readonly surface: string;
  readonly areaMm2: number;
  readonly centroidMm: readonly [number, number, number];
}

export interface AcousticLoadPackage {
  readonly schema: 'llull.acousticLoad/1';
  readonly exposure: string;
  readonly field: 'diffuse' | 'progressive';
  readonly incidenceDeg?: number;
  readonly notes?: string;
  readonly spectrum: {
    readonly name: string;
    readonly bandwidth: 'octave' | 'third_octave';
    readonly reference: '20uPa';
    readonly oasplDb: number;
    readonly pRmsPa: number;
    readonly psdKind: string;
    readonly bands: ReturnType<typeof bandRows>;
  };
  readonly faces: readonly (ExposedFace & { readonly rmsForceN: number | null })[];
  readonly totalAreaMm2: number;
  readonly totalRmsForceN: number | null;
  readonly provenance: { readonly source: AcousticSpectrum['source']; readonly documentHash: string };
  readonly unverified: boolean;
  readonly reviewRequired: true;
  readonly reviewReason: string;
  readonly items: readonly VacItem[];
}

const reviewPending: VacItem = {
  code: 'VAC_REVIEW_PENDING',
  severity: 'warning',
  message: 'this package has no reviewer disposition; it feeds a qualification analysis',
  remediation: 'a qualified reviewer must confirm the spectrum, the field type and the faces before the package is used',
};

/**
 * @invariant face areas and centroids are rounded to 1e-6 (mm^2, mm); bands in ascending exactMidHz; psdPa2PerHz band-averaged one-sided Pa^2/Hz; rmsForceN = overall rms pressure (Pa) x area (m^2) for a diffuse field
 *   (uniform rms pressure, spatial correlation not modelled), null for a progressive field (the incidence is not applied); unverified = the spectrum is not grade A
 */
export function acousticLoadPackage(
  exposure: AcousticExposure,
  spectrum: AcousticSpectrum,
  faces: readonly ExposedFace[],
  documentHash: string,
): AcousticLoadPackage {
  const levels = spectrum.bands.map((band) => band.splDb);
  const pRmsPa = overallPressurePa(levels);
  const rmsForceOf = (areaMm2: number): number | null => (exposure.field === 'diffuse' ? pRmsPa * areaMm2 * 1e-6 : null);
  const rounded = faces.map((face) => ({
    ...face,
    areaMm2: fixed(face.areaMm2),
    centroidMm: [fixed(face.centroidMm[0]), fixed(face.centroidMm[1]), fixed(face.centroidMm[2])] as const,
  }));
  const totalAreaMm2 = rounded.reduce((sum, face) => sum + face.areaMm2, 0);
  return {
    schema: 'llull.acousticLoad/1',
    exposure: exposure.name,
    field: exposure.field,
    ...(exposure.incidenceDeg === undefined ? {} : { incidenceDeg: exposure.incidenceDeg }),
    ...(exposure.notes === undefined ? {} : { notes: exposure.notes }),
    spectrum: {
      name: spectrum.name,
      bandwidth: spectrum.bandwidth,
      reference: spectrum.reference,
      oasplDb: energySumDb(levels),
      pRmsPa,
      psdKind: 'band-averaged one-sided Pa^2/Hz',
      bands: bandRows(spectrum),
    },
    faces: rounded.map((face) => ({ ...face, rmsForceN: rmsForceOf(face.areaMm2) })),
    totalAreaMm2,
    totalRmsForceN: rmsForceOf(totalAreaMm2),
    provenance: { source: spectrum.source, documentHash },
    unverified: spectrum.unverified,
    reviewRequired: true,
    reviewReason: 'acoustic environment for qualification analysis',
    items: [...(spectrum.unverified ? [unverifiedItem(spectrum.name)] : []), reviewPending],
  };
}
