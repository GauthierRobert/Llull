/**
 * The modal post-processing inputs of a solved dynamic case (TR-DYN-40/41): kept modes (<= fMaxHz), their damping terms and ratios, the
 * participation factors in the excitation direction, the base ASD in g^2/Hz and the adaptive integration grid. Shared by the probe summary
 * and the nodal rms field (TypeScript reference and `llull-compute post random`).
 */

import type { AnalysisCase, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { spectrumInG2 } from './libraryCommands';
import { dampingTerms, zetaOfMode } from './math/damping';
import type { AsdPoint } from './math/psd';
import { integrationGrid, type IntegrationGrid, type ModalBasis } from './math/randomResponse';
import { caseLossFactor } from './materialDamping';
import { modalTables, modeShapes, type ModalTables, type ModeShape } from './results/modalData';
import { spectrumOf } from './store';
import { gravityInUnitSystem } from './units';

const DIRECTION_INDEX = { x: 0, y: 1, z: 2 } as const;

interface KeptMode {
  readonly mode: number;
  readonly omega: number;
  readonly fHz: number;
  readonly zeta: number;
}

export interface ModalPost {
  readonly tables: ModalTables;
  readonly kept: readonly KeptMode[];
  readonly shapes: readonly ModeShape[];
  readonly basis: ModalBasis;
  readonly unverifiedReasons: readonly string[];
}

export interface RandomPost extends ModalPost {
  readonly direction: 0 | 1 | 2;
  readonly gamma: readonly number[];
  readonly spectrum: readonly AsdPoint[];
  readonly band: readonly [number, number];
  readonly grid: IntegrationGrid;
  /** g in the model acceleration unit (relative displacement and stress rms scale). */
  readonly gravity: number;
}

export interface PostProblem {
  readonly code: string;
  readonly message: string;
}

export const isPostProblem = (value: object): value is PostProblem => 'code' in value && 'message' in value;

/** Kept modes and their modal basis; the damping and loss factor of the case (no default damping). */
export function modalPost(doc: CadDocument, analysis: AnalysisCase, results: FeResultsArtifact): ModalPost | PostProblem {
  const tables = modalTables(results);
  if (tables === null) return { code: 'DYN_RESULTS_MISSING', message: 'the results carry no eigenvalue / participation tables' };
  const damping = analysis.dynamics?.damping;
  if (damping === undefined) return { code: 'DYN_DAMPING_UNSET', message: 'the case has no damping' };
  const unverifiedReasons: string[] = [];
  let eta: number | null = null;
  if (damping.model === 'structural_material') {
    const found = caseLossFactor(doc, analysis);
    if ('code' in found) return { code: found.code, message: found.message };
    eta = found.eta;
    unverifiedReasons.push(...found.unverifiedReasons.map((reason) => `structuralLossFactor: ${reason}`));
  } else if (damping.source.grade !== 'A') unverifiedReasons.push(`damping source grade ${damping.source.grade ?? 'unstated'} (not A)`);
  const fMax = analysis.dynamics?.basis.fMaxHz ?? Number.POSITIVE_INFINITY;
  const shapes = modeShapes(results);
  const kept: KeptMode[] = [];
  const omega: number[] = [];
  const dampingA: number[] = [];
  const dampingB: number[] = [];
  for (const row of tables.modes) {
    if (row.fHz > fMax) continue;
    const terms = dampingTerms(damping, row.mode, row.omega, eta);
    const zeta = zetaOfMode(damping, row.mode, row.fHz, eta);
    if (terms === null || zeta === null) return { code: 'DYN_DAMPING_UNSET', message: `mode ${row.mode} has no damping ratio` };
    kept.push({ ...row, zeta });
    omega.push(row.omega);
    dampingA.push(terms.a);
    dampingB.push(terms.b);
  }
  if (kept.length === 0) return { code: 'DYN_BASIS_MISSING', message: 'no mode below fMaxHz' };
  return { tables, kept, shapes, basis: { omega, dampingA, dampingB }, unverifiedReasons };
}

/**
 * Everything the random post-processing needs.
 * @failure modal problems; no base spectrum / sweep -> DYN_BASE_UNSET / DYN_SWEEP_UNSET; spectrum and band disjoint -> DYN_SPECTRUM_INVALID
 */
export function randomPost(doc: CadDocument, analysis: AnalysisCase, results: FeResultsArtifact): RandomPost | PostProblem {
  const modal = modalPost(doc, analysis, results);
  if (isPostProblem(modal)) return modal;
  const base = analysis.dynamics?.base;
  const spectrum = base?.spectrum === undefined ? undefined : spectrumOf(doc, base.spectrum);
  if (base === undefined || spectrum === undefined) return { code: 'DYN_BASE_UNSET', message: 'the case has no base ASD' };
  const sweep = analysis.dynamics?.sweep;
  if (sweep === undefined) return { code: 'DYN_SWEEP_UNSET', message: 'the case has no frequency sweep' };
  const points = spectrumInG2(spectrum);
  const band: [number, number] = [Math.max(points[0]?.[0] ?? 0, sweep.fMinHz), Math.min(points.at(-1)?.[0] ?? 0, sweep.fMaxHz)];
  if (!(band[1] > band[0])) return { code: 'DYN_SPECTRUM_INVALID', message: 'the spectrum does not overlap the sweep band' };
  const direction = DIRECTION_INDEX[base.direction];
  const index = new Map(modal.tables.modes.map((row, i) => [row.mode, i]));
  const gamma = modal.kept.map((mode) => modal.tables.participation[index.get(mode.mode) ?? -1]?.[direction] ?? 0);
  const grid = integrationGrid(points, band, modal.kept);
  const unverifiedReasons = [...modal.unverifiedReasons];
  if (spectrum.unverified)
    unverifiedReasons.push(`DYN_SPECTRUM_UNVERIFIED: spectrum '${spectrum.name}' source grade ${spectrum.source.grade ?? 'unstated'}`);
  return { ...modal, direction, gamma, spectrum: points, band, grid, gravity: gravityInUnitSystem(analysis.unitSystem), unverifiedReasons };
}
