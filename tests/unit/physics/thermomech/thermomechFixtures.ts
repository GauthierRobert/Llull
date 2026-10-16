/** PHY-04 fixtures: CSV reader, materials with thermalStrain / cte property models, command helpers. */
import { readFileSync } from 'node:fs';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

export const PACK = '04-thermo-mechanical';

export function csvRows(file: string): Record<string, string>[] {
  const [header = '', ...lines] = readFileSync(`docs/physics/${PACK}/validation/${file}`, 'utf8').trim().split('\n');
  const names = header.split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((cell, i) => [names[i] ?? String(i), cell])));
}

export const H7 = { nominal: 20, upper: 0.021, lower: 0 };
export const G6 = { nominal: 20, upper: -0.007, lower: -0.02 };
export const SPEC_20C = { value: 20, unit: 'degC' };
export const perK = (value: number): { value: number; unit: string } => ({ value, unit: '1/K' });

export const explicitCte = (alpha: number): Record<string, unknown> => ({
  alpha: perK(alpha),
  referenceTemperature: SPEC_20C,
  source: 'test input',
});

const source = { citation: 'synthetic test model', locator: 'thermomech tests' };

export function withModel(doc: CadDocument, material: string, model: Record<string, unknown>): CadDocument {
  let next = doc;
  if (!Object.hasOwn(next.materials, material)) {
    next = execute(next, 'create_material', { name: material, density: 0.0027, color: '#b0b0b0', metalness: 1, roughness: 0.4 }).document;
  }
  const result = execute(next, 'define_property_model', {
    material,
    model: { variables: [{ variable: 'T', unit: 'K' }], validity: [{ variable: 'T', unit: 'K', data: [200, 400] }], source, ...model },
  });
  if (result.rejected === true) throw new Error(result.summary);
  return result.document;
}

/** thermalStrain s(T) = alpha (T - 293.15 K): secant CTE alpha relative to 20 degC. */
export const strainModel = (alpha: number, basis = 'company'): Record<string, unknown> => ({
  id: 'strain',
  property: 'thermalStrain',
  unit: '1',
  form: { kind: 'polynomial', variable: 'T', coefficients: [0, alpha], origin: 293.15 },
  basis,
});

export const cteModel = (form: Record<string, unknown>, basis = 'company'): Record<string, unknown> => ({
  id: 'cte',
  property: 'cte',
  unit: '1/K',
  form,
  basis,
});

export const emptyDoc = (): CadDocument => createEmptyDocument();

export function run(doc: CadDocument, command: string, params: Record<string, unknown>): CommandResult {
  return execute(doc, command, params);
}

export const dataOf = <T>(result: CommandResult): T => result.data as T;

interface Row {
  temperature: { hole: { value: number; unit: string }; shaft: { value: number; unit: string } };
  holeDiameter: { min: number; max: number };
  shaftDiameter: { min: number; max: number };
  clearance: { min: number; max: number };
  status: string;
  code?: string;
  unverified: boolean;
  unverifiedReasons: string[];
  reviewRequired: boolean;
  disposition: string;
  provenance: { formula: string; thermalStrain: { hole: number; shaft: number }; samplingError?: number };
  interferencePressureMPa?: { min: number; max: number };
  hubHoopStressMPa?: { max: number };
}
export interface FitData {
  unit: string;
  intent: string;
  intentSource: string;
  rows: Row[];
  provenance: { formula: string; cte: { part: string; source: string; basis: string; conversion?: string }[]; limits: unknown[] };
  assumptions: string[];
  summary: string;
}
