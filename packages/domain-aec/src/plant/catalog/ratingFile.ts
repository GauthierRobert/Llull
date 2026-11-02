/**
 * Rating-table file form (`llull-rating-table`, schemaVersion 1; plant 01 PSC M5): the pressure-temperature table of a flange standard and material
 * group, imported by the user (the pack has a source for ASME B16.5 group 1.1 only, so every further table is the user's data). Every row carries its
 * provenance (row or table level) and is unverified unless the file says `verified: true`; nothing is invented. Stored in bar and degC; psi and
 * degF are converted at import (1 psi = 0.0689475729 bar) and rounded to 1e-6.
 * @invariant structure -> zod; units, licence, provenance, coverage -> issues with paths; a row is class XOR pn; (class, temperature) is unique
 */

import { z } from '@core/commands/schema';
import { LICENCE_FLAGS } from '@core/model/materialLibrary';
import { BAR_PER_PSI } from './ptRating';
import type { Provenance, RatingRow, RatingTable } from './types';

export const RATING_FORMAT = 'llull-rating-table';
export const RATING_STANDARDS = ['ASME B16.5', 'ASME B16.34', 'EN 1092-1', 'company'] as const;
export const RATING_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_ROWS = 5000;
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const zodPath = (path: readonly PropertyKey[]): string => path.map(String).join('.');

export interface RatingIssue {
  readonly code: 'PSC_CATALOG_INVALID' | 'PSC_UNIT_INVALID' | 'PSC_PROVENANCE_MISSING' | 'PSC_LICENCE_EMBED_FORBIDDEN';
  readonly path: string;
  readonly message: string;
}

const provenanceSchema = z.object({
  sourceId: z.string().min(1).optional(),
  citation: z.string().min(1).optional(),
  url: z.string().optional(),
  accessed: z.string().optional(),
});
const rowSchema = z.object({
  class: z.number().int().positive().optional(),
  pn: z.number().positive().optional(),
  temperature: z.number(),
  pressure: z.number().min(0),
  verified: z.boolean().optional(),
  provenance: provenanceSchema.optional(),
});
const fileSchema = z.object({
  format: z.literal(RATING_FORMAT),
  schemaVersion: z.literal(1),
  id: z.string().regex(RATING_ID_PATTERN),
  standard: z.enum(RATING_STANDARDS),
  materialGroup: z.string().min(1).max(64),
  title: z.string().optional(),
  licence: z.enum(LICENCE_FLAGS),
  pressureUnit: z.enum(['bar', 'psi']),
  temperatureUnit: z.enum(['C', 'F']),
  minTemperature: z.number(),
  provenance: provenanceSchema.optional(),
  rows: z.array(rowSchema).min(1).max(MAX_ROWS),
});

const hasSource = (provenance: Provenance | undefined): provenance is Provenance =>
  provenance !== undefined && (provenance.citation !== undefined || provenance.sourceId !== undefined);

const provenanceOf = (value: z.infer<typeof provenanceSchema>): Provenance => ({
  ...(value.sourceId === undefined ? {} : { sourceId: value.sourceId }),
  ...(value.citation === undefined ? {} : { citation: value.citation }),
  ...(value.url === undefined ? {} : { url: value.url }),
  ...(value.accessed === undefined ? {} : { accessed: value.accessed }),
});

/** Parses a rating-table file object: the stored table, or every problem found. */
export function parseRatingFile(raw: unknown): { readonly table: RatingTable } | { readonly issues: readonly RatingIssue[] } {
  const file = fileSchema.safeParse(raw);
  if (!file.success)
    return {
      issues: file.error.issues.map(
        (issue): RatingIssue => ({
          code: /Unit$/.test(String(issue.path.at(-1))) ? 'PSC_UNIT_INVALID' : 'PSC_CATALOG_INVALID',
          path: zodPath(issue.path) || 'table',
          message: `${zodPath(issue.path) || 'table'}: ${issue.message}`,
        }),
      ),
    };
  const data = file.data;
  if (data.licence === 'licensed-no-redistribution')
    return {
      issues: [
        {
          code: 'PSC_LICENCE_EMBED_FORBIDDEN',
          path: 'licence',
          message: 'licensed-no-redistribution data cannot be embedded in the document',
        },
      ],
    };
  const issues: RatingIssue[] = [];
  const toBar = (value: number): number => (data.pressureUnit === 'psi' ? round6(value * BAR_PER_PSI) : value);
  const toC = (value: number): number => (data.temperatureUnit === 'F' ? round6(((value - 32) * 5) / 9) : value);
  const minTemperatureC = toC(data.minTemperature);
  const key: 'class' | 'pn' =
    data.standard === 'EN 1092-1' ? 'pn' : data.standard === 'company' ? (data.rows[0]?.pn !== undefined ? 'pn' : 'class') : 'class';
  const seen = new Set<string>();
  const rows: RatingRow[] = [];
  data.rows.forEach((row, index) => {
    const path = `rows.${index}`;
    if ((row.class === undefined) === (row.pn === undefined))
      issues.push({ code: 'PSC_CATALOG_INVALID', path, message: `${path} needs exactly one of class / pn` });
    else if (row.pn !== undefined ? key !== 'pn' : key !== 'class')
      issues.push({
        code: 'PSC_CATALOG_INVALID',
        path,
        message: `${path}: a ${data.standard} table is rated by ${key} on every row, not ${row.pn !== undefined ? 'pn' : 'class'}`,
      });
    const rated = row.class ?? row.pn;
    const provenance = row.provenance === undefined ? data.provenance : row.provenance;
    const resolved = provenance === undefined ? {} : provenanceOf(provenance);
    if (!hasSource(resolved))
      issues.push({ code: 'PSC_PROVENANCE_MISSING', path, message: `${path} has no provenance.citation or sourceId (row or table level)` });
    const temperatureC = toC(row.temperature);
    if (temperatureC < minTemperatureC)
      issues.push({ code: 'PSC_CATALOG_INVALID', path: `${path}.temperature`, message: `${path}.temperature is below minTemperature` });
    const rowKey = `${rated}|${temperatureC}`;
    if (seen.has(rowKey))
      issues.push({ code: 'PSC_CATALOG_INVALID', path, message: `${path}: class / pn ${rated} at ${temperatureC} degC is listed twice` });
    seen.add(rowKey);
    if (rated !== undefined)
      rows.push({
        ratingClass: rated,
        temperatureC,
        bar: { value: toBar(row.pressure), unit: 'bar', verified: row.verified === true, provenance: resolved },
      });
  });
  if (issues.length > 0) return { issues };
  rows.sort((a, b) => a.ratingClass - b.ratingClass || a.temperatureC - b.temperatureC);
  return { table: { id: data.id, standard: data.standard, materialGroup: data.materialGroup, minTemperatureC, rows, ratingKey: key } };
}

/** The table as a file object in bar and degC, rows in stable order (re-importing it gives the same table). */
export function ratingTableToFile(table: RatingTable, licence: (typeof LICENCE_FLAGS)[number] = 'open-data'): Record<string, unknown> {
  return {
    format: RATING_FORMAT,
    schemaVersion: 1,
    id: table.id,
    standard: table.standard,
    materialGroup: table.materialGroup,
    licence,
    pressureUnit: 'bar',
    temperatureUnit: 'C',
    minTemperature: table.minTemperatureC,
    rows: table.rows.map((row) => ({
      ...((table.ratingKey ?? (table.standard === 'EN 1092-1' ? 'pn' : 'class')) === 'pn'
        ? { pn: row.ratingClass }
        : { class: row.ratingClass }),
      temperature: row.temperatureC,
      pressure: row.bar.value,
      verified: row.bar.verified,
      provenance: row.bar.provenance,
    })),
  };
}
