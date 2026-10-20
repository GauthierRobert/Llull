/**
 * Readers of a dynamic results artifact (TR-DYN-31 / TR-DYN-60): the frequency-step tables of the `.dat` (eigenvalues, participation
 * factors, effective modal mass, totals), the mode shapes of the `.frd` frequency step (CalculiX step 1: one result set per mode, time =
 * frequency, DISP and, with `*EL FILE S`, STRESS) and the complex steady-state sets of step 2 (DISP real + DISPI imaginary, STRESS +
 * STRESSI, time = frequency; CalculiX `frd.c` writes the imaginary blocks for `*STEADY STATE DYNAMICS`).
 */

import type { FeResultsArtifact } from '@core/model/analysis';
import { DAT_TITLES } from '../../results/datReader';

type Field = FeResultsArtifact['steps'][number]['fields'][string];

interface ModeRow {
  /** 1-based mode number. */
  readonly mode: number;
  /** rad/s (CalculiX "real part rad/time"). */
  readonly omega: number;
  readonly fHz: number;
}

export interface ModalTables {
  readonly modes: readonly ModeRow[];
  /** Per mode: participation factors [x, y, z, rx, ry, rz] (mode order of `modes`). */
  readonly participation: readonly (readonly number[])[];
  /** Per mode: effective modal mass [x, y, z, rx, ry, rz]. */
  readonly effectiveMass: readonly (readonly number[])[];
  /** Total effective (rigid-body) mass [x, y, z, rx, ry, rz], or null when the table is absent. */
  readonly totalMass: readonly number[] | null;
}

const table = (results: FeResultsArtifact, title: string): readonly (readonly number[])[] | null =>
  results.dat?.tables.find((candidate) => candidate.title === title)?.rows ?? null;

/** Rows of a per-mode table aligned with `modes` (missing modes are null). */
function byMode(rows: readonly (readonly number[])[] | null, modes: readonly ModeRow[]): (readonly number[])[] | null {
  if (rows === null) return null;
  const found = new Map(rows.map((row) => [row[0], row.slice(1)]));
  const aligned = modes.map((mode) => found.get(mode.mode));
  return aligned.every((row): row is number[] => row !== undefined) ? aligned : null;
}

/**
 * The frequency-step tables of a results artifact.
 * @failure no eigenvalue table, or participation / effective-mass rows missing for a mode -> null
 */
export function modalTables(results: FeResultsArtifact): ModalTables | null {
  const eigen = results.dat?.tables.find((candidate) => candidate.title.startsWith('eigenvalues'))?.rows ?? [];
  const modes = eigen.map((row) => ({ mode: row[0] ?? 0, omega: row[2] ?? Number.NaN, fHz: row[3] ?? Number.NaN }));
  if (modes.length === 0 || modes.some((mode) => !(mode.omega > 0) || !(mode.fHz > 0))) return null;
  const participation = byMode(table(results, DAT_TITLES.participation), modes);
  const effectiveMass = byMode(table(results, DAT_TITLES.effectiveMass), modes);
  if (participation === null || effectiveMass === null) return null;
  return { modes, participation, effectiveMass, totalMass: table(results, DAT_TITLES.totalMass)?.[0] ?? null };
}

export interface ModeShape {
  readonly fHz: number;
  readonly disp: Field | undefined;
  readonly stress: Field | undefined;
}

/** Mode shapes of the frequency step (CalculiX step 1), in mode order. */
export const modeShapes = (results: FeResultsArtifact): ModeShape[] =>
  results.steps.filter((set) => set.step === 1).map((set) => ({ fHz: set.time, disp: set.fields['DISP'], stress: set.fields['STRESS'] }));

export interface SteadyStatePoint {
  readonly fHz: number;
  readonly real: Readonly<Record<string, Field | undefined>>;
  readonly imaginary: Readonly<Record<string, Field | undefined>>;
}

/** Complex steady-state sets of step 2: `real.DISP` / `imaginary.DISP` (from DISPI), same for STRESS. */
export function steadyStatePoints(results: FeResultsArtifact): SteadyStatePoint[] {
  return results.steps
    .filter((set) => set.step === 2 && set.fields['DISP'] !== undefined)
    .map((set) => ({
      fHz: set.time,
      real: { DISP: set.fields['DISP'], STRESS: set.fields['STRESS'] },
      imaginary: { DISP: set.fields['DISPI'], STRESS: set.fields['STRESSI'] },
    }));
}

/** Modal coordinates CalculiX printed per steady-state frequency (mode, f, Re, Im), keyed by the step frequency. */
export function modalCoordinates(results: FeResultsArtifact): { readonly fHz: number; readonly rows: readonly (readonly number[])[] }[] {
  return (results.dat?.tables ?? [])
    .filter((candidate) => candidate.title === DAT_TITLES.modalCoordinates)
    .map((candidate) => ({ fHz: candidate.time, rows: candidate.rows }));
}
