/** Read / replace helpers of the PHY-09 data: `AnalysisCase.dynamics` and the `AnalysisModel.vibration` library (pure). */

import type { AnalysisCase } from '@core/model/analysis';
import type { CaseDynamics, DynamicSource, DynamicsLibrary, VibrationSpectrum } from '@core/model/structuralDynamics';
import type { CadDocument } from '@core/model/types';
import { analysisOf, caseOf, withCase } from '../shared/access';
import { isDynamicType } from './quantities';

const EMPTY_LIBRARY: DynamicsLibrary = { spectra: {}, spectrumOrder: [], histories: {}, historyOrder: [] };

export const libraryOf = (doc: CadDocument): DynamicsLibrary => analysisOf(doc).vibration ?? EMPTY_LIBRARY;

export function withLibrary(doc: CadDocument, library: DynamicsLibrary): CadDocument {
  return { ...doc, analysis: { ...analysisOf(doc), vibration: library } };
}

export function spectrumOf(doc: CadDocument, name: string): VibrationSpectrum | undefined {
  const { spectra } = libraryOf(doc);
  return Object.hasOwn(spectra, name) ? spectra[name] : undefined;
}

export interface DynamicCase {
  readonly analysisCase: AnalysisCase;
  readonly dynamics: CaseDynamics;
}

/** The frequency_response / random_response case `analysisId` with its dynamics (an empty basis when none is stored yet). */
export function dynamicCaseOf(doc: CadDocument, analysisId: string): DynamicCase | 'missing' | 'not_dynamic' {
  const analysisCase = caseOf(doc, analysisId);
  if (analysisCase === undefined) return 'missing';
  if (!isDynamicType(analysisCase.type)) return 'not_dynamic';
  return { analysisCase, dynamics: analysisCase.dynamics ?? { basis: {} } };
}

export const withDynamics = (doc: CadDocument, analysisCase: AnalysisCase, dynamics: CaseDynamics): CadDocument =>
  withCase(doc, { ...analysisCase, dynamics });

/** Ids of the dynamic cases whose base excitation uses spectrum `name`. */
export function spectrumUsers(doc: CadDocument, name: string): string[] {
  return Object.values(analysisOf(doc).cases)
    .filter((analysisCase) => analysisCase.dynamics?.base?.spectrum === name)
    .map((analysisCase) => analysisCase.id);
}

export const NAME_PATTERN = /^[a-z0-9_]{1,40}$/;

/** A parsed `source` param as stored data (absent optional fields left out); null when missing or without a citation. */
export function sourceOf(
  input: { citation: string; grade?: 'A' | 'B' | 'C' | undefined; url?: string | undefined } | undefined,
): DynamicSource | null {
  if (input === undefined || input.citation.trim() === '') return null;
  return {
    citation: input.citation,
    ...(input.grade !== undefined ? { grade: input.grade } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
  };
}
