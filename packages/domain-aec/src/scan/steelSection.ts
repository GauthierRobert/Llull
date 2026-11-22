/**
 * Measured web / flange thickness of fit_steel_member (TECHNICAL_SPEC §13.12): the native estimates (metres, with their residual) against the
 * catalogue profile, and the numbers a steel extraction carries to commit_asbuilt_extraction (TR-SCN-04: the commit holds every value).
 */

import { isRecord } from '@lib/isRecord';
import type { SteelProfile } from '../steel/profiles';

export interface PlateMeasure {
  readonly mm: number;
  readonly residualMm: number;
  readonly samples: number;
  readonly catalogueMm: number | null;
  readonly deltaMm: number | null;
}

export interface MeasuredThickness {
  readonly tw: PlateMeasure | null;
  readonly tf: PlateMeasure | null;
  /** Why tw and / or tf are null. */
  readonly reason: string | null;
  readonly warnings: ReadonlyArray<{ readonly code: string; readonly message: string }>;
}

const INVALID_PLATE =
  'the native thickness estimate was malformed (tw / tf must be finite and > 0, residual >= 0, samples a non-negative integer) and was dropped';
const NOT_I = 'tw / tf are estimated for the I sections IPE, HEA and HEB; other families are read from the catalogue';

function plate(raw: unknown, catalogueMm: number | null): PlateMeasure | null {
  if (!isRecord(raw)) return null;
  const [value, residual, samples] = [raw['value'], raw['residual'], raw['samples']];
  if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) return null;
  if (typeof residual !== 'number' || !Number.isFinite(residual) || residual < 0) return null;
  if (typeof samples !== 'number' || !Number.isInteger(samples) || samples < 0) return null;
  return {
    mm: value * 1000,
    residualMm: residual * 1000,
    samples,
    catalogueMm,
    deltaMm: catalogueMm === null ? null : value * 1000 - catalogueMm,
  };
}

/**
 * The native `thickness` (metres) of the best candidate against its catalogue profile. A plate whose measured thickness differs from the catalogue by
 * more than `bandMm` (the fit's own inlier band: 3 x noiseSigma, else 2.5 x median spacing) warns SCN_STEEL_THICKNESS_MISMATCH by profile and
 * plate: below that band the difference cannot be told from the noise of the face positions.
 */
export function measuredThickness(raw: unknown, profile: SteelProfile | undefined, bandMm: number): MeasuredThickness {
  if (!isRecord(raw))
    return { tw: null, tf: null, reason: profile === undefined ? 'the best candidate is not a catalogue profile' : NOT_I, warnings: [] };
  const tw = plate(raw['tw'], profile?.tw ?? null);
  const tf = plate(raw['tf'], profile?.tf ?? null);
  const malformed = (raw['tw'] != null && tw === null) || (raw['tf'] != null && tf === null);
  const plates: ReadonlyArray<readonly [string, string, PlateMeasure | null]> = [
    ['tw', 'web', tw],
    ['tf', 'flange', tf],
  ];
  const warnings = plates.flatMap(([key, name, measure]) =>
    measure === null || measure.deltaMm === null || measure.catalogueMm === null || Math.abs(measure.deltaMm) <= bandMm
      ? []
      : [
          {
            code: 'SCN_STEEL_THICKNESS_MISMATCH',
            message:
              `${profile?.name ?? 'profile'} ${name} thickness ${key} measures ${measure.mm.toFixed(2)} mm (residual ${measure.residualMm.toFixed(2)} mm) ` +
              `against the catalogue ${measure.catalogueMm.toFixed(2)} mm: ${Math.abs(measure.deltaMm).toFixed(2)} mm apart, more than the ${bandMm.toFixed(2)} mm scan band`,
          },
        ],
  );
  const nativeReason = typeof raw['reason'] === 'string' ? raw['reason'] : null;
  const reason = nativeReason ?? (malformed ? INVALID_PLATE : null);
  return { tw, tf, reason, warnings };
}

/** The `measured` block of fit_steel_member data: rotated extents, tw / tf with their residual and the catalogue values, or null with the reason. */
export function measuredSection(
  extents: { readonly hMm: number; readonly bMm: number; readonly rollDeg: unknown },
  thickness: MeasuredThickness,
): Record<string, unknown> {
  return {
    ...extents,
    twMm: thickness.tw?.mm ?? null,
    tfMm: thickness.tf?.mm ?? null,
    twResidualMm: thickness.tw?.residualMm ?? null,
    tfResidualMm: thickness.tf?.residualMm ?? null,
    twCatalogueMm: thickness.tw?.catalogueMm ?? null,
    tfCatalogueMm: thickness.tf?.catalogueMm ?? null,
    twTfReason: thickness.reason,
  };
}

export interface AxisRefinementData {
  readonly applied: boolean;
  readonly deltaDeg: number;
  readonly faces: number;
  readonly facePoints: number;
  /** Metres: RMS distance of the face points to their fitted planes. */
  readonly residual: number;
  readonly reason: string | null;
}

/** The native `axisRefinement` picked field by field; null when any field has the wrong type. */
export function axisRefinementOf(raw: unknown): AxisRefinementData | null {
  if (!isRecord(raw) || typeof raw['applied'] !== 'boolean') return null;
  const [deltaDeg, faces, facePoints, residual, reason] = [
    raw['deltaDeg'],
    raw['faces'],
    raw['facePoints'],
    raw['residual'],
    raw['reason'],
  ];
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  if (!finite(deltaDeg) || !finite(faces) || !finite(facePoints) || !finite(residual)) return null;
  if (reason !== null && reason !== undefined && typeof reason !== 'string') return null;
  return { applied: raw['applied'], deltaDeg, faces, facePoints, residual, reason: reason ?? null };
}
