/** Document unit conversions (the unit list itself is `DOCUMENT_UNITS` in ./types). */

import type { CadDocument, DocumentUnit } from './types';

/** Millimetres in one document unit. */
export const MM_PER_UNIT: Readonly<Record<DocumentUnit, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

const metresPerUnit = (units: DocumentUnit): number => MM_PER_UNIT[units] / 1000;

/** Converts a length given in millimetres into the document's units. */
export function fromMm(doc: Pick<CadDocument, 'units'>, millimetres: number): number {
  return (millimetres * 0.001) / metresPerUnit(doc.units);
}

/** Converts a length in document units into millimetres (inverse of `fromMm`). */
export function toMm(doc: Pick<CadDocument, 'units'>, value: number): number {
  return value / fromMm(doc, 1);
}

/** Converts a length in document units to metres. */
export function toMetres(doc: Pick<CadDocument, 'units'>, value: number): number {
  return value * metresPerUnit(doc.units);
}
