/** PHY-02 fixtures: documents holding materials with material models, built only through commands. */
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

export const PACK = '02-constitutive-models';
export const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/physics/materials' };

export const T293 = [{ variable: 'T', unit: 'K', data: [293, 293] }];

export function withMaterial(doc: CadDocument, name: string): CadDocument {
  return execute(doc, 'create_material', { name, density: 0.0078, color: '#b0b0b0', metalness: 1, roughness: 0.4 }).document;
}

/** Run a command that must succeed (accepted, document changed or query answered). */
export function run(doc: CadDocument, command: string, params: Record<string, unknown>): ReturnType<typeof execute> {
  const result = execute(doc, command, params);
  if (result.rejected === true) throw new Error(`${command}: ${result.summary}`);
  return result;
}

export function addModel(
  doc: CadDocument,
  material: string,
  id: string,
  model: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): CadDocument {
  return run(doc, 'add_material_model', { material, id, model, basis: 'unspecified', source: SOURCE, ...extra }).document;
}

export function defineSet(doc: CadDocument, material: string, set: Record<string, unknown>, makeDefault = false): CadDocument {
  return run(doc, 'define_constitutive_set', { material, set, makeDefault }).document;
}

/** Error code of a rejected command (asserting the document is untouched), or `accepted`. */
export function codeOf(doc: CadDocument, command: string, params: Record<string, unknown>): string {
  const result = execute(doc, command, params);
  if (result.error === undefined) return 'accepted';
  if (result.document !== doc) throw new Error(`${command} rejected but changed the document`);
  return result.error.code;
}

export const MPa = (value: number): { value: number; unit: string } => ({ value, unit: 'MPa' });
export const GPa = (value: number): { value: number; unit: string } => ({ value, unit: 'GPa' });
export const ONE = (value: number): { value: number; unit: string } => ({ value, unit: '1' });

export const NL1_ELASTIC = { kind: 'elastic_isotropic', E: GPa(250), nu: ONE(0.25) };
export const NL1_PERFECT = { kind: 'j2_plasticity', isotropic: { kind: 'perfect', yieldStress: MPa(5) }, kinematic: { kind: 'none' } };
export const NL1_HARDENING = {
  kind: 'j2_plasticity',
  isotropic: { kind: 'linear', yieldStress: MPa(5), modulus: GPa(62.5), modulusKind: 'plastic' },
  kinematic: { kind: 'none' },
};

export const NL1_VALIDITY = [...T293, { variable: 'equivalentPlasticStrain', unit: '1', data: [0, 0.001] }];

/** The NAFEMS NL1 strain path (exx, eyy) in units of 1e-4, as absolute step targets. */
export const NL1_PATH: ReadonlyArray<readonly [number, number]> = [
  [0.25, 0],
  [0.5, 0],
  [0.5, 0.25],
  [0.5, 0.5],
  [0.25, 0.5],
  [0, 0.5],
  [0, 0.25],
  [0, 0],
];

export const nl1Steps = (increments: number): Record<string, unknown>[] =>
  NL1_PATH.map(([xx, yy]) => ({ increments, control: { xx: { strain: xx * 1e-4 }, yy: { strain: yy * 1e-4 } } }));

/** NL1 material with elastic, perfect and hardening models and their two sets. */
export function nl1Document(): CadDocument {
  let doc = withMaterial(createEmptyDocument(), 'nl1_steel');
  doc = addModel(doc, 'nl1_steel', 'elastic', NL1_ELASTIC, { validity: T293 });
  doc = addModel(doc, 'nl1_steel', 'perfect', NL1_PERFECT, { validity: NL1_VALIDITY });
  doc = addModel(doc, 'nl1_steel', 'iso_h', NL1_HARDENING, { validity: NL1_VALIDITY });
  doc = defineSet(doc, 'nl1_steel', { id: 'perfect', elastic: 'elastic', plastic: 'perfect' });
  return defineSet(doc, 'nl1_steel', { id: 'iso_hardening', elastic: 'elastic', plastic: 'iso_h' }, true);
}

export interface PointRow {
  step: number;
  increment: number;
  time: number;
  T: number | null;
  strain: number[];
  stress: number[];
  eqPlasticStrain: number;
  vonMises: number;
  backStress: number[];
  energyDensity: number;
}

export interface PointData {
  rows: PointRow[];
  warnings: { code: string; step: number; increment: number; message: string }[];
  defaults: { name: string; value: unknown }[];
  unverified: boolean;
  unverifiedReasons: string[];
  reviewRequired: boolean;
}

export function pointResponse(doc: CadDocument, params: Record<string, unknown>): PointData {
  return run(doc, 'material_point_response', params).data as PointData;
}

/** The pack stores values with 12 significant digits and judges at rel 1e-12: round the measurement the way the generator does. */
export const sig12 = (value: number): number => Number(value.toPrecision(12));
