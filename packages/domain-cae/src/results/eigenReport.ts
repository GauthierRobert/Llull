/** Eigenvalue results of a modal / buckling case read from the results artifact (`.dat` tables): frequencies, mass participation, buckling factors. */

import type { AnalysisCase, FeResultsArtifact, UnitSystem } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';

interface ModalMode {
  readonly mode: number;
  readonly frequencyHz: number;
  /** Modal participation factor per global axis (CalculiX `.dat`), when the solver printed it. */
  readonly participation?: Vec3;
  /** Effective modal mass per axis, in the analysis mass unit, when printed. */
  readonly effectiveMass?: Vec3;
  /** Effective modal mass over the TOTAL EFFECTIVE MASS table of ccx, per axis (0..1). That table is the sum over the EXTRACTED modes (not the model mass), so this is a share of the extracted sum. */
  readonly fractionOfExtractedSum?: Vec3;
}

export interface ModalReport {
  readonly kind: 'modal';
  readonly modes: readonly ModalMode[];
  readonly totalEffectiveMass: Vec3 | null;
  readonly massUnit: string;
  /** Modes with a frequency at or below the rigid-body threshold: the model is not fully restrained. */
  readonly rigidBodyModes: number;
  /** Reader notes of the `.dat` (a mass table that was printed but could not be read). */
  readonly warnings: readonly string[];
}

export interface BucklingReport {
  readonly kind: 'buckling';
  /** Buckling load factors in solver order (multiples of the applied reference load). */
  readonly factors: readonly number[];
  /** Smallest positive factor: the load that buckles the structure is `criticalFactor` x the applied load. */
  readonly criticalFactor: number | null;
  readonly criticalMode: number | null;
  readonly negativeFactors: number;
  readonly nearZeroFactors: number;
}

/** llull heuristics, not solver output: a mode below 1e-4 of the highest extracted frequency (or 1e-3 Hz) is a rigid-body mode. */
const RIGID_BODY_RELATIVE = 1e-4;
const RIGID_BODY_ABSOLUTE_HZ = 1e-3;
/** A buckling factor below this magnitude is numerically zero (a singular or unloaded model), not a physical load level. */
const NEAR_ZERO_FACTOR = 1e-3;

const MASS_UNITS: Readonly<Record<UnitSystem, string>> = { 'N-mm-t-s': 'tonne', 'N-m-kg-s': 'kg', 'lbf-in-slinch-s': 'slinch' };

const tableOf = (results: FeResultsArtifact, title: string): readonly (readonly number[])[] =>
  results.dat?.tables.find((table) => table.title.startsWith(title))?.rows ?? [];

const perAxis = (value: (axis: number) => number): Vec3 => [value(0), value(1), value(2)];

const vector = (row: readonly number[] | undefined, from: number): Vec3 | undefined =>
  row === undefined || row.length < from + 3 ? undefined : [row[from] ?? 0, row[from + 1] ?? 0, row[from + 2] ?? 0];

/**
 * Eigenvalue report of a modal or buckling case; null for other types or when the `.dat` table is absent.
 * @invariant modal: modes in solver (ascending) order with the printed participation factors and effective masses matched by mode number;
 *   buckling: `criticalFactor` is the smallest factor above NEAR_ZERO_FACTOR
 */
export function eigenReport(analysis: AnalysisCase, results: FeResultsArtifact): ModalReport | BucklingReport | null {
  if (analysis.type === 'buckling') {
    const factors = tableOf(results, 'buckling factors').map((row) => row[1] ?? Number.NaN);
    if (factors.length === 0) return null;
    const positive = factors.map((factor, index) => ({ factor, mode: index + 1 })).filter((entry) => entry.factor > NEAR_ZERO_FACTOR);
    const critical = positive.reduce<(typeof positive)[number] | null>(
      (best, entry) => (best === null || entry.factor < best.factor ? entry : best),
      null,
    );
    return {
      kind: 'buckling',
      factors,
      criticalFactor: critical?.factor ?? null,
      criticalMode: critical?.mode ?? null,
      negativeFactors: factors.filter((factor) => factor < -NEAR_ZERO_FACTOR).length,
      nearZeroFactors: factors.filter((factor) => Math.abs(factor) <= NEAR_ZERO_FACTOR).length,
    };
  }
  if (analysis.type !== 'modal') return null;
  const eigenvalues = tableOf(results, 'eigenvalues');
  if (eigenvalues.length === 0) return null;
  const participation = new Map(tableOf(results, 'participation factors').map((row) => [row[0] ?? 0, vector(row, 1)]));
  const effective = new Map(tableOf(results, 'effective modal mass').map((row) => [row[0] ?? 0, vector(row, 1)]));
  const total = vector(tableOf(results, 'total effective mass')[0], 0) ?? null;
  const highest = Math.max(...eigenvalues.map((row) => row[3] ?? 0));
  const threshold = Math.max(RIGID_BODY_ABSOLUTE_HZ, RIGID_BODY_RELATIVE * highest);
  const fraction = (mass: Vec3 | undefined): Vec3 | undefined =>
    mass === undefined || total === null
      ? undefined
      : perAxis((axis) => ((total[axis] ?? 0) > 0 ? (mass[axis] ?? 0) / (total[axis] ?? 1) : 0));
  const modes: ModalMode[] = eigenvalues.map((row) => {
    const mode = row[0] ?? 0;
    const factor = participation.get(mode);
    const mass = effective.get(mode);
    const share = fraction(mass);
    return {
      mode,
      frequencyHz: row[3] ?? Number.NaN,
      ...(factor !== undefined ? { participation: factor } : {}),
      ...(mass !== undefined ? { effectiveMass: mass } : {}),
      ...(share !== undefined ? { fractionOfExtractedSum: share } : {}),
    };
  });
  return {
    kind: 'modal',
    modes,
    totalEffectiveMass: total,
    massUnit: MASS_UNITS[analysis.unitSystem],
    rigidBodyModes: modes.filter((mode) => mode.frequencyHz <= threshold).length,
    warnings: results.dat?.warnings ?? [],
  };
}

/** One-sentence reading of a report for command summaries: rigid-body modes, mass participation, critical buckling load. */
export function eigenNote(report: ModalReport | BucklingReport): string {
  if (report.kind === 'buckling')
    return report.criticalFactor === null
      ? 'no positive buckling factor (the reference load does not buckle the model in this direction)'
      : `critical buckling load = ${Number(report.criticalFactor.toPrecision(6))} x the applied load (mode ${report.criticalMode}); linear buckling, no imperfections`;
  const parts: string[] = [];
  if (report.rigidBodyModes > 0) parts.push(`${report.rigidBodyModes} rigid-body mode(s): the model is not fully restrained`);
  if (report.totalEffectiveMass !== null && report.modes.length > 0 && report.modes.every((mode) => mode.effectiveMass !== undefined)) {
    const shares = [0, 1, 2].map((axis) => report.modes.reduce((sum, mode) => sum + (mode.fractionOfExtractedSum?.[axis] ?? 0), 0));
    parts.push(
      `extracted modes carry x/y/z ${shares.map((share) => `${Math.round(share * 1000) / 10}%`).join(' / ')} of ccx's TOTAL EFFECTIVE MASS (the sum over the extracted modes, not the model mass)`,
    );
  }
  parts.push(...report.warnings);
  return parts.join('; ');
}
