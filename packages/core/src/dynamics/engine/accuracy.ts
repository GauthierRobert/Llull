/**
 * Accuracy statement of a reported quantity (FR-FPR-70, TR-FPR-14): a band (or null = "no quantitative estimate"), where it comes from,
 * whether the number was given, calibrated, predicted or is a solver self-check, and how far it was validated (NASA-STD-7009 scale).
 * Independent contributions combine by root-sum-square; a missing band propagates as null, never as 0.
 */

export type AccuracyBand = { readonly rel: number } | { readonly abs: number; readonly unit: string } | null;

/** `input` given, `calibrated` matched to a referent by construction, `predicted` computed independently, `verification` a solver self-check. */
export type AccuracyOrigin = 'input' | 'calibrated' | 'predicted' | 'verification';

/** NASA-STD-7009 validation scale: 0 none, 1 conceptual / calibrated only, 2 key outputs agree with a referent, 3 broad, 4 full range. */
export type ValidationLevel = 0 | 1 | 2 | 3 | 4;

export interface Accuracy {
  readonly band: AccuracyBand;
  readonly basis: string;
  readonly origin: AccuracyOrigin;
  readonly validationLevel: ValidationLevel;
  readonly comparison?: {
    readonly referenceId: string;
    readonly s: number;
    readonly d: number;
    readonly e: number;
    readonly uVal: number | null;
  };
  readonly warnings: string[];
}

export function accuracy(
  band: AccuracyBand,
  basis: string,
  origin: AccuracyOrigin,
  options: { validationLevel?: ValidationLevel; warnings?: readonly string[] } = {},
): Accuracy {
  return { band, basis, origin, validationLevel: options.validationLevel ?? 0, warnings: [...(options.warnings ?? [])] };
}

/** Relative size of a band at `value`: an absolute band needs a non-zero value; null when it cannot be expressed. */
function relativeBand(band: AccuracyBand, value: number): number | null {
  if (band === null) return null;
  if ('rel' in band) return band.rel;
  return value !== 0 && Number.isFinite(value) ? Math.abs(band.abs / value) : null;
}

/**
 * Band of a quantity made of independent contributions, each with its own band: the root-sum-square of the absolute uncertainties (each
 * band applied to the contribution's own `value`), relative to `result`. Null when a contribution has no band or `result` is 0.
 */
export function combineContributions(
  contributions: readonly { readonly band: AccuracyBand; readonly value: number }[],
  result: number,
): AccuracyBand {
  let sum = 0;
  for (const { band, value } of contributions) {
    const rel = relativeBand(band, value);
    if (rel === null) return null;
    sum += (rel * value) ** 2;
  }
  return result !== 0 && contributions.length > 0 ? { rel: Math.sqrt(sum) / Math.abs(result) } : null;
}

/** "± 15 %", "± 1 N·m" or "± ?". */
export function bandText(band: AccuracyBand): string {
  if (band === null) return '± ?';
  return 'rel' in band ? `± ${Number((band.rel * 100).toPrecision(3))} %` : `± ${Number(band.abs.toPrecision(3))} ${band.unit}`;
}

/** Standing warning of every result of the rigid-body engine. */
export const RIGID_BODY_WARNING = 'rigid bodies: no torsional resonance or crank flexibility is modelled';
