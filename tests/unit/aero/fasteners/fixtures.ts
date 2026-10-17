/**
 * Fixtures of the fastener tests: the draft sample catalogue (docs/aerospace/08-materials-standards-libraries/validation) converted to the
 * `llull-fastener-catalog` file format, and helpers to run commands. The sample is test data only — nothing is bundled in the package
 * (OQ-MAT-01).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { type CadDocument, createEmptyDocument } from '@core/model/types';

const validation = (name: string): string => resolve(process.cwd(), 'docs/aerospace/08-materials-standards-libraries/validation', name);

export const readValidation = (name: string): unknown => JSON.parse(readFileSync(validation(name), 'utf8'));

interface Sample {
  families: Array<{ id: string; sizes: Array<Record<string, unknown>>; fixtureGripDashRange?: [number, number] }>;
}

const cite = (what: string): { citation: string } => ({
  citation: `docs/aerospace/08-materials-standards-libraries/validation/fastener_catalog_sample.json (${what})`,
});
const inches = (value: number): { value: number; unit: 'in' } => ({ value, unit: 'in' });
const range = (min: number, max: number, what: string): { min: number; max: number; unit: 'in'; provenance: { citation: string } } => ({
  min,
  max,
  unit: 'in',
  provenance: cite(what),
});

/** The sample catalogue in file format: NAS6203-6220, MS20470, HL19, MS21042 (nut) and NAS1149 (washer). */
export function sampleCatalogFile(): Record<string, unknown> {
  const sample = readValidation('fastener_catalog_sample.json') as Sample;
  const nas = sample.families.find((family) => family.id === 'NAS6203-6220');
  const nasSizes = (nas?.sizes ?? []).map((size) => {
    const threadLength = size['threadLength_in'] as { value: number };
    const dash = String(size['dash']);
    const tpi = size['threadsPerInch'];
    return {
      dash,
      nominalDiameter: inches(size['nominalDiameter_in'] as number),
      ...(typeof size['thread'] === 'string' && size['thread'] !== 'tbd' ? { thread: size['thread'] } : {}),
      ...(typeof tpi === 'number' ? { threadsPerInch: tpi } : {}),
      threadLength: inches(threadLength.value),
      dims: {},
    };
  });
  const rivetHeads: Record<string, [[number, number], [number, number]]> = {
    '4': [
      [0.238, 0.262],
      [0.054, 0.064],
    ],
    '5': [
      [0.296, 0.328],
      [0.067, 0.077],
    ],
    '6': [
      [0.356, 0.394],
      [0.08, 0.09],
    ],
  };
  const rivetDiameters: Record<string, number> = { '3': 0.09375, '4': 0.125, '5': 0.15625, '6': 0.1875 };
  const washerSizes = [
    ['3', 0.19],
    ['4', 0.25],
    ['5', 0.3125],
    ['6', 0.375],
  ] as const;
  return {
    format: 'llull-fastener-catalog',
    schemaVersion: 1,
    title: 'sample (test fixture)',
    families: [
      {
        id: 'NAS6203-6220',
        kind: 'bolt',
        standard: { body: 'AIA/NAS', id: 'NAS6203-6220' },
        partNumber: [
          { kind: 'literal', text: 'NAS62' },
          { kind: 'int', name: 'diameterDash', width: 2 },
          { kind: 'literal', text: '-' },
          { kind: 'int', name: 'gripDash', scale: 0.0625, unit: 'in' },
        ],
        gripIncrement: inches(0.0625),
        gripMode: 'min_grip_ge_stack',
        lengthRule: { kind: 'grip_plus_thread' },
        sizes: nasSizes,
        availableGripDash: { min: nas?.fixtureGripDashRange?.[0] ?? 1, max: nas?.fixtureGripDashRange?.[1] ?? 40 },
        licence: 'vendor-catalogue',
        provenance: cite('S22'),
      },
      {
        id: 'MS20470',
        kind: 'solid_rivet',
        standard: { body: 'MS', id: 'MS20470' },
        partNumber: [
          { kind: 'literal', text: 'MS20470' },
          { kind: 'code', name: 'material', table: { AD: 'aluminium 2117-T4 (verify)', DD: 'aluminium 2024 (verify)' } },
          { kind: 'int', name: 'diameterDash', scale: 0.03125, unit: 'in' },
          { kind: 'literal', text: '-' },
          { kind: 'int', name: 'lengthDash', scale: 0.0625, unit: 'in' },
        ],
        lengthRule: { kind: 'stack_plus_k_d', k: 1.5, round: 'up', step: inches(0.0625) },
        sizes: Object.entries(rivetDiameters).map(([dash, diameter]) => ({
          dash,
          nominalDiameter: inches(diameter),
          dims: rivetHeads[dash]
            ? { headDiameter: range(...rivetHeads[dash][0], 'S24'), headHeight: range(...rivetHeads[dash][1], 'S24') }
            : {},
        })),
        licence: 'vendor-catalogue',
        provenance: cite('S24'),
      },
      {
        id: 'HL19',
        kind: 'hi_lok_pin',
        standard: { body: 'Hi-Shear', id: 'Hi-Lok Product Specification 342' },
        partNumber: [
          { kind: 'literal', text: 'HL19-' },
          { kind: 'int', name: 'diameterDash', scale: 0.03125, unit: 'in' },
          { kind: 'literal', text: '-' },
          { kind: 'int', name: 'gripDash', scale: 0.0625, unit: 'in' },
        ],
        gripIncrement: inches(0.0625),
        gripMode: 'max_grip_range',
        sizes: [
          { dash: '6', nominalDiameter: inches(0.1875), dims: {} },
          { dash: '8', nominalDiameter: inches(0.25), dims: {} },
        ],
        availableGripDash: { min: 1, max: 40 },
        licence: 'vendor-catalogue',
        provenance: cite('S26'),
      },
      {
        id: 'MS21042',
        kind: 'nut',
        standard: { body: 'MS', id: 'MS21042' },
        partNumber: [
          { kind: 'literal', text: 'MS21042' },
          { kind: 'code', name: 'style', table: { L: 'reduced hexagon, extended washer, 450 F' } },
          { kind: 'int', name: 'diameterDash' },
        ],
        sizes: [
          {
            dash: '3',
            partNumber: 'MS21042L3',
            nominalDiameter: inches(0.19),
            thread: '0.190-32 UNJF-3B',
            threadsPerInch: 32,
            dims: { height: range(0.154, 0.188, 'S25'), acrossFlats: range(0.243, 0.252, 'S25') },
          },
        ],
        licence: 'vendor-catalogue',
        provenance: cite('S25'),
      },
      {
        id: 'NAS1149',
        kind: 'washer',
        standard: { body: 'AIA/NAS', id: 'NAS1149' },
        partNumber: [
          { kind: 'literal', text: 'NAS1149' },
          { kind: 'code', name: 'material', table: { F: 'carbon steel' } },
          { kind: 'int', name: 'diameterDash', width: 2 },
          { kind: 'int', name: 'thickness', scale: 0.001, unit: 'in', width: 2 },
          { kind: 'code', name: 'finish', table: { P: 'cadmium plated' } },
        ],
        sizes: washerSizes.map(([dash, diameter]) => ({
          dash,
          nominalDiameter: inches(diameter),
          dims: { thickness: { options: [0.016, 0.032, 0.063, 0.09], unit: 'in', provenance: cite('S27') } },
        })),
        licence: 'vendor-catalogue',
        provenance: cite('S27'),
      },
    ],
  };
}

/** Synthetic metric family "ACME-100" (VC-MAT-20): bolts with a 1 mm grip increment and an M6 size, no code change needed. */
export function acmeCatalogFile(): Record<string, unknown> {
  const provenance = { citation: 'ACME fastener data sheet (synthetic test data)' };
  return {
    format: 'llull-fastener-catalog',
    schemaVersion: 1,
    families: [
      {
        id: 'ACME-100',
        kind: 'bolt',
        standard: { body: 'ACME', id: 'ACME-100' },
        partNumber: [
          { kind: 'literal', text: 'AC100-M' },
          { kind: 'int', name: 'diameterDash' },
          { kind: 'literal', text: 'x' },
          { kind: 'int', name: 'gripDash', scale: 1, unit: 'mm' },
        ],
        gripIncrement: { value: 1, unit: 'mm' },
        gripMode: 'min_grip_ge_stack',
        lengthRule: { kind: 'grip_plus_thread' },
        sizes: [
          {
            dash: '6',
            nominalDiameter: { value: 6, unit: 'mm' },
            threadLength: { value: 14, unit: 'mm' },
            holeDiameter: { min: 6.1, max: 6.2, unit: 'mm', provenance },
            dims: { headDiameter: { nominal: 10, unit: 'mm', provenance }, headHeight: { nominal: 4, unit: 'mm', provenance } },
          },
        ],
        availableGripDash: { min: 2, max: 30 },
        licence: 'company-proprietary',
        provenance,
      },
    ],
  };
}

/** An empty document in inches (the fastener catalogues are inch based). */
export const inchDocument = (): CadDocument => ({ ...createEmptyDocument(), units: 'in' });

export function docWith(catalog: Record<string, unknown> = sampleCatalogFile(), start: CadDocument = createEmptyDocument()): CadDocument {
  const imported = execute(start, 'import_fastener_catalog', { catalog });
  expect(imported.rejected, imported.summary).toBeUndefined();
  expect(imported.error, imported.summary).toBeUndefined();
  return imported.document;
}

export const ctxWith = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });

export const dataOf = (result: CommandResult): Record<string, unknown> => result.data as Record<string, unknown>;

/** Run `name` and require that it neither was rejected nor set an error. */
export function ok(doc: CadDocument, name: string, params: Record<string, unknown>, ctx?: ExecutionContext): CommandResult {
  const result = execute(doc, name, params, ctx);
  expect(result.rejected, result.summary).toBeUndefined();
  expect(result.error, result.summary).toBeUndefined();
  return result;
}
