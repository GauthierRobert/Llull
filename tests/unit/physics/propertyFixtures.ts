/** PHY-01 fixtures: documents holding the NIST cryogenic fits of docs/physics/01-property-models/validation/nist_cryogenic_fits.json. */
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

export const PACK = '01-property-models';

interface NistFit {
  id: string;
  property: string;
  unit: string;
  form: 'log10Polynomial' | 'nistRational' | 'polynomial' | 'thermalStrainNist' | 'piecewise';
  coefficients?: number[];
  segments?: { rangeK: [number, number]; coefficients: number[] }[];
  dataRangeK: [number, number] | null;
  equationRangeK: [number, number] | null;
  fitErrorPercent: number | null;
  tLowK?: number | null;
  belowValue?: number | null;
  condition?: { rrr: number };
}

export const NIST_FITS: ReadonlyMap<string, NistFit> = new Map(
  (JSON.parse(readFileSync(`docs/physics/${PACK}/validation/nist_cryogenic_fits.json`, 'utf8')) as { fits: NistFit[] }).fits.map((f) => [
    f.id,
    f,
  ]),
);

/** Ranges used when the fits file marks a range TBD (VCs only evaluate inside them). */
const RANGE_OVERRIDES: Readonly<Record<string, [number, number]>> = { 'aa6061_t6.E': [4, 295], 'g10cr.k.normal': [10, 300] };

function formOf(fit: NistFit): Record<string, unknown> {
  const coefficients = fit.coefficients ?? [];
  switch (fit.form) {
    case 'log10Polynomial':
      return { kind: 'log10Polynomial', variable: 'T', coefficients };
    case 'nistRational':
      return { kind: 'nistRational', coefficients };
    case 'polynomial':
      return { kind: 'polynomial', variable: 'T', coefficients };
    case 'thermalStrainNist': {
      const polynomial = { kind: 'polynomial', variable: 'T', coefficients };
      const tLow = fit.tLowK;
      if (tLow === null || tLow === undefined || tLow <= (fit.dataRangeK?.[0] ?? 0)) return polynomial;
      return {
        kind: 'piecewise',
        variable: 'T',
        segments: [
          { upTo: tLow, form: { kind: 'constant', value: fit.belowValue } },
          { upTo: fit.dataRangeK?.[1] ?? 300, form: polynomial },
        ],
      };
    }
    case 'piecewise':
      return {
        kind: 'piecewise',
        variable: 'T',
        segments: (fit.segments ?? []).map((s) => ({
          upTo: s.rangeK[1],
          form: { kind: 'polynomial', variable: 'T', coefficients: s.coefficients },
        })),
      };
  }
}

/** define_property_model input for one NIST fit (basis typical, NIST citation; same locator for both Invar transcriptions). */
export function nistModel(fitId: string, modelId = fitId.split('.').slice(1).join('.') || fitId): Record<string, unknown> {
  const fit = NIST_FITS.get(fitId);
  if (fit === undefined) throw new Error(`no fit ${fitId}`);
  const data = RANGE_OVERRIDES[fitId] ?? fit.dataRangeK ?? [4, 300];
  const equation = fit.equationRangeK ?? undefined;
  return {
    id: modelId,
    property: fit.property,
    unit: fit.unit,
    variables: [{ variable: 'T', unit: 'K' }],
    form: formOf(fit),
    validity: [{ variable: 'T', unit: 'K', data, ...(equation !== undefined && RANGE_OVERRIDES[fitId] === undefined ? { equation } : {}) }],
    basis: 'typical',
    ...(fit.condition !== undefined ? { condition: fit.condition } : {}),
    ...(fit.fitErrorPercent !== null && fit.fitErrorPercent !== undefined
      ? {
          uncertainty: {
            kind: 'fitErrorVsData',
            relative: fit.fitErrorPercent / 100,
            provenance: { citation: 'NIST Cryogenics', locator: 'curve fit % error relative to data' },
          },
        }
      : {}),
    source: {
      citation: `NIST Cryogenics, Material Properties (${fit.id.split('.')[0]})`,
      locator: `${fit.property} coefficients`,
      accessed: '2026-10-15',
    },
  };
}

export function withMaterial(doc: CadDocument, name: string): CadDocument {
  return execute(doc, 'create_material', { name, density: 0.0027, color: '#b0b0b0', metalness: 1, roughness: 0.4 }).document;
}

/** A document with every NIST fit as a model on its material (`aa6061_t6`, `ss304`, `ti6al4v`, `g10cr`, `cu_ofhc`, `invar36`). */
export function nistDocument(): CadDocument {
  let doc = createEmptyDocument();
  const materials = new Set([...NIST_FITS.keys()].map((id) => id.split('.')[0] ?? id));
  for (const material of materials) doc = withMaterial(doc, material);
  for (const fitId of NIST_FITS.keys()) {
    const material = fitId.split('.')[0] ?? fitId;
    const result = execute(doc, 'define_property_model', { material, model: nistModel(fitId) });
    if (result.rejected === true || result.document === doc) throw new Error(`${fitId}: ${result.summary}`);
    doc = result.document;
  }
  return doc;
}
