/** Thermal boundary condition assembly and validation shared by add_thermal_bc, update_thermal_bc and check_thermal. */

import type { AnalysisCase, FeaTarget, Q, ThermalBc, ThermalBcRecord, ThermalSetup } from '@core/model/analysis';
import { is3D, type CadDocument } from '@core/model/types';
import { z } from '@core/commands/schema';
import { problem, type Problem } from './access';
import { quantityProblem } from './quantities';
import { quantitySchema } from '../shared/schemas';
import { feaTargetSchema, targetProblem, toTarget, type FeaTargetInput } from '../shared/target';

export const BC_KINDS = ['temperature', 'surface_flux', 'heat_generation', 'concentrated_flux', 'film', 'radiation'] as const;
export type BcKind = (typeof BC_KINDS)[number];

export const sourceSchema = z.object({
  citation: z.string().describe('Where the value comes from: datasheet, correlation, company rule, owner statement.'),
  locator: z.string().optional().describe('Page, table or clause inside the citation.'),
});
export type SourceInput = z.output<typeof sourceSchema>;

/** Plain source record (an absent locator is omitted, never undefined). */
export const plainSource = (source: SourceInput): NonNullable<ThermalBcRecord['source']> => ({
  citation: source.citation,
  ...(source.locator !== undefined ? { locator: source.locator } : {}),
});

/** Flat BC fields as the commands receive them (a field the kind does not use is refused, never dropped). */
export const bcFieldsSchema = {
  value: z
    .number()
    .optional()
    .describe(
      'temperature / surface_flux / heat_generation / concentrated_flux: the value, in `unit`. temperature in degC | K | degF; ' +
        'surface_flux in W/m^2 (positive INTO the part); heat_generation in W/m^3 (mode density) or W (mode total); concentrated_flux in W.',
    ),
  unit: z.string().optional().describe("Unit of `value`, 08 grammar: 'degC', 'K', 'W/m^2', 'W/m^3', 'W'. Required with value."),
  filmCoefficient: quantitySchema
    .optional()
    .describe('film only: h as { value, unit } in W/(m^2*K); > 0. Never defaulted: needs `source`.'),
  sinkTemperature: quantitySchema
    .optional()
    .describe(
      'film / radiation: temperature of the environment as { value, unit } (degC | K | degF). Radiation uses absolute temperature.',
    ),
  emissivity: z
    .number()
    .optional()
    .describe('radiation only: hemispherical emissivity, 0 to 1. Never defaulted: needs `source` (PHY-15 emissivityIr is not built).'),
  mode: z
    .enum(['density', 'total'])
    .optional()
    .describe('heat_generation only: value is W/m^3 ("density", default) or total power W spread over the part volume ("total").'),
  entityId: z.string().optional().describe('heat_generation only: id of the analysed part (solid) that generates heat.'),
  target: feaTargetSchema
    .optional()
    .describe(
      'temperature: faces / edges / points; surface_flux, film, radiation: facesNear (document units); concentrated_flux: pointsNear. ' +
        'Not for heat_generation.',
    ),
  amplitude: z
    .string()
    .optional()
    .describe(
      'Optional amplitude id or name (define_amplitude): the BC value (sink temperature for film / radiation) is multiplied by f(t).',
    ),
  source: sourceSchema.optional().describe('REQUIRED for film (h) and radiation (emissivity); optional elsewhere.'),
};

export interface BcFields {
  readonly value?: number | undefined;
  readonly unit?: string | undefined;
  readonly filmCoefficient?: Q | undefined;
  readonly sinkTemperature?: Q | undefined;
  readonly emissivity?: number | undefined;
  readonly mode?: 'density' | 'total' | undefined;
  readonly entityId?: string | undefined;
  readonly target?: FeaTargetInput | undefined;
}

const USED: Readonly<Record<BcKind, readonly (keyof BcFields)[]>> = {
  temperature: ['value', 'unit', 'target'],
  surface_flux: ['value', 'unit', 'target'],
  concentrated_flux: ['value', 'unit', 'target'],
  heat_generation: ['value', 'unit', 'mode', 'entityId'],
  film: ['filmCoefficient', 'sinkTemperature', 'target'],
  radiation: ['emissivity', 'sinkTemperature', 'target'],
};

/** Names of the given fields the kind does not use. */
export const unusedFields = (kind: BcKind, fields: BcFields): string[] =>
  (Object.keys(fields) as (keyof BcFields)[]).filter((key) => fields[key] !== undefined && !USED[kind].includes(key));

const pickValue = (fields: BcFields, previous: Q | undefined): Q | Problem => {
  if ((fields.value === undefined) !== (fields.unit === undefined) && previous === undefined)
    return problem('THM_UNITS_MISMATCH', 'give value and unit together', [], ['value', 'unit']);
  if (fields.value !== undefined && fields.unit !== undefined) return { value: fields.value, unit: fields.unit };
  if (fields.value !== undefined && previous !== undefined) return { value: fields.value, unit: previous.unit };
  if (fields.unit !== undefined && previous !== undefined) return { value: previous.value, unit: fields.unit };
  return previous ?? problem('THM_UNITS_MISMATCH', 'value and unit are required', [], ['value', 'unit']);
};

/**
 * The BC of `kind` from the flat fields (update: the fields replace those of `previous`). Dimension and range checks are in `bcProblem`.
 * @failure a required field is missing -> THM_UNITS_MISMATCH (quantities) / FEA_TARGET_UNRESOLVED (target) / THM_EMISSIVITY_INVALID
 */
export function assembleBc(kind: BcKind, fields: BcFields, previous?: ThermalBc): ThermalBc | Problem {
  const before = previous?.kind === kind ? previous : undefined;
  const missing = (code: string, what: string, path: string): Problem => problem(code, `${kind} needs ${what}`, [], [path]);
  const targetOf = (): FeaTarget | undefined =>
    fields.target !== undefined ? toTarget(fields.target) : before !== undefined && 'target' in before ? before.target : undefined;
  if (kind === 'film') {
    const film =
      fields.filmCoefficient ?? (before?.kind === 'film' && 'value' in before.filmCoefficient ? before.filmCoefficient : undefined);
    const sink = fields.sinkTemperature ?? (before?.kind === 'film' ? before.sinkTemperature : undefined);
    const target = targetOf();
    if (film === undefined) return missing('THM_FILM_INVALID', 'filmCoefficient { value, unit }', 'filmCoefficient');
    if (sink === undefined) return missing('THM_UNITS_MISMATCH', 'sinkTemperature { value, unit }', 'sinkTemperature');
    if (target === undefined) return missing('FEA_TARGET_UNRESOLVED', 'a target with facesNear', 'target');
    return { kind, filmCoefficient: film, sinkTemperature: sink, target };
  }
  if (kind === 'radiation') {
    const emissivity =
      fields.emissivity ?? (before?.kind === 'radiation' && typeof before.emissivity === 'number' ? before.emissivity : undefined);
    const sink = fields.sinkTemperature ?? (before?.kind === 'radiation' ? before.sinkTemperature : undefined);
    const target = targetOf();
    if (emissivity === undefined) return missing('THM_EMISSIVITY_INVALID', 'an emissivity between 0 and 1', 'emissivity');
    if (sink === undefined) return missing('THM_UNITS_MISMATCH', 'sinkTemperature { value, unit }', 'sinkTemperature');
    if (target === undefined) return missing('FEA_TARGET_UNRESOLVED', 'a target with facesNear', 'target');
    return { kind, emissivity, sinkTemperature: sink, target };
  }
  const value = pickValue(fields, before !== undefined && 'value' in before ? before.value : undefined);
  if ('code' in value) return value;
  if (kind === 'heat_generation') {
    const entityId = fields.entityId ?? (before?.kind === 'heat_generation' ? before.entityId : undefined);
    if (entityId === undefined) return missing('FEA_TARGET_UNRESOLVED', 'entityId', 'entityId');
    const mode = fields.mode ?? (before?.kind === 'heat_generation' ? before.mode : 'density');
    return { kind, value, mode, entityId };
  }
  const target = targetOf();
  if (target === undefined) return missing('FEA_TARGET_UNRESOLVED', 'a target', 'target');
  return { kind, value, target };
}

const hasPoints = (points: readonly unknown[] | undefined): boolean => points !== undefined && points.length > 0;

function targetUse(kind: BcKind, target: FeaTarget): string | null {
  if (kind === 'concentrated_flux' && !hasPoints(target.pointsNear)) return 'concentrated_flux needs pointsNear';
  if ((kind === 'surface_flux' || kind === 'film' || kind === 'radiation') && !hasPoints(target.facesNear))
    return `${kind} acts on faces: give facesNear`;
  return null;
}

/** Quantity dimension and range problems of a BC (units, h > 0, 0 <= emissivity <= 1, finite values). */
function valueProblem(bc: ThermalBc): Problem | null {
  const units = (path: string, text: string | null): Problem | null =>
    text === null ? null : problem('THM_UNITS_MISMATCH', `${path}: ${text}`, [], [path]);
  switch (bc.kind) {
    case 'temperature':
      return units('value', quantityProblem('temperature', bc.value));
    case 'surface_flux':
      return units('value', quantityProblem('flux', bc.value));
    case 'concentrated_flux':
      return units('value', quantityProblem('power', bc.value));
    case 'heat_generation':
      return units('value', quantityProblem(bc.mode === 'total' ? 'power' : 'generation', bc.value));
    case 'film': {
      if (!('value' in bc.filmCoefficient)) return null;
      const bad = units('filmCoefficient', quantityProblem('film', bc.filmCoefficient));
      if (bad !== null) return bad;
      if (!(bc.filmCoefficient.value > 0))
        return problem('THM_FILM_INVALID', `film coefficient ${bc.filmCoefficient.value} must be > 0`, [], ['filmCoefficient']);
      return units('sinkTemperature', quantityProblem('temperature', bc.sinkTemperature));
    }
    case 'radiation': {
      if (typeof bc.emissivity !== 'number' || !Number.isFinite(bc.emissivity) || bc.emissivity < 0 || bc.emissivity > 1)
        return problem('THM_EMISSIVITY_INVALID', `emissivity ${String(bc.emissivity)} is outside [0, 1]`, [], ['emissivity']);
      return units('sinkTemperature', quantityProblem('temperature', bc.sinkTemperature));
    }
  }
}

/** Entity and target problems of a BC in its case (part membership, selector kind, 3D solid). */
function placementProblem(doc: CadDocument, analysisCase: AnalysisCase, bc: ThermalBc): Problem | null {
  if (bc.kind === 'heat_generation') {
    const entity = Object.hasOwn(doc.entities, bc.entityId) ? doc.entities[bc.entityId] : undefined;
    if (entity === undefined || !is3D(entity))
      return problem('FEA_TARGET_UNRESOLVED', `entity '${bc.entityId}' is not a solid`, [bc.entityId], ['entityId']);
    if (!Object.hasOwn(analysisCase.parts, bc.entityId))
      return problem(
        'FEA_PART_NOT_IN_ANALYSIS',
        `entity '${bc.entityId}' is not a part of '${analysisCase.id}'`,
        [bc.entityId],
        ['entityId'],
      );
    return null;
  }
  const found = targetProblem(doc, analysisCase, bc.target);
  if (found !== null) return problem(found.code, found.message, [bc.target.entityId], ['target']);
  const use = targetUse(bc.kind, bc.target);
  return use === null ? null : problem('FEA_TARGET_UNRESOLVED', use, [bc.target.entityId], ['target']);
}

/** The amplitude id for `reference` (an id or a unique name) in the set-up; null when unknown. */
export function amplitudeIdOf(thermal: ThermalSetup, reference: string): string | null {
  if (Object.hasOwn(thermal.amplitudes, reference)) return reference;
  const named = Object.values(thermal.amplitudes).filter((amplitude) => amplitude.name === reference);
  return named.length === 1 ? (named[0]?.id ?? null) : null;
}

/** Source problem: film and radiation need a non-empty citation. */
function sourceProblem(bc: ThermalBc, source: ThermalBcRecord['source']): Problem | null {
  if (bc.kind !== 'film' && bc.kind !== 'radiation') return null;
  if (bc.kind === 'film' && !('value' in bc.filmCoefficient)) return null;
  if (source !== undefined && source.citation.trim() !== '') return null;
  const what = bc.kind === 'film' ? 'film coefficient h' : 'emissivity';
  return problem('THM_SOURCE_REQUIRED', `the ${what} needs a source (citation); it is never defaulted`, [], ['source']);
}

/** All problems of one stored BC record, in the order the commands report them. */
export function recordProblem(
  doc: CadDocument,
  analysisCase: AnalysisCase,
  thermal: ThermalSetup,
  record: ThermalBcRecord,
): Problem | null {
  const value = valueProblem(record.bc);
  if (value !== null) return value;
  const source = sourceProblem(record.bc, record.source);
  if (source !== null) return source;
  const placed = placementProblem(doc, analysisCase, record.bc);
  if (placed !== null) return placed;
  if (record.amplitude !== undefined && !Object.hasOwn(thermal.amplitudes, record.amplitude))
    return problem('THM_AMPLITUDE_INVALID', `amplitude '${record.amplitude}' does not exist`, [record.amplitude], ['amplitude']);
  return null;
}
