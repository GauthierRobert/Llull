/** Thread designations (07 FTR D7): a light per-family grammar, free text for `other`. Full validation needs licensed AS8879 / ISO 5855 data. */

import { type ThreadSpec, THREAD_FAMILIES } from '../../model/features';
import { z } from '../schema';

type Family = ThreadSpec['family'];

const PITCH = String.raw`\d+(?:\.\d+)?`;
const GRADE = String.raw`(?:-\d[A-Za-z]\d?[A-Za-z]?)?`;
const INCH_SIZE = String.raw`(?:#\d+|\d+/\d+|\d*\.\d+|\d+)-\d+\s*`;

const GRAMMAR: Readonly<Record<Exclude<Family, 'other'>, RegExp>> = {
  MJ: new RegExp(String.raw`^MJ${PITCH}x${PITCH}${GRADE}$`),
  UNJ: new RegExp(String.raw`^${INCH_SIZE}UNJ[CFE]?(?:-\d[AB])?$`),
  UN: new RegExp(String.raw`^${INCH_SIZE}UN(?:C|F|EF|S)?(?:-\d[AB])?$`),
  M: new RegExp(String.raw`^M${PITCH}(?:x${PITCH})?${GRADE}$`),
};

const STRUCTURED_PREFIX = /^(?:MJ|M\d)|UN[A-Z]*(?:-|\s|$)/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const FREE_TEXT = /^[^\u0000-\u001f\u007f]{1,80}$/;

/** The family a designation belongs to; null when it looks like a structured family designation but fails its grammar. */
function inferFamily(designation: string): Family | null {
  for (const family of ['MJ', 'UNJ', 'UN', 'M'] as const) if (GRAMMAR[family].test(designation)) return family;
  return STRUCTURED_PREFIX.test(designation) || !FREE_TEXT.test(designation) ? null : 'other';
}

/**
 * Thread spec for `designation`: `family` given must match its grammar, absent is inferred.
 * @failure designation fails the grammar of its (stated or inferred) family -> null
 */
export function parseThread(input: {
  readonly designation: string;
  readonly family?: Family | undefined;
  readonly depth?: number | undefined;
  readonly handedness?: 'right' | 'left' | undefined;
  readonly modelled?: boolean | undefined;
}): ThreadSpec | null {
  const designation = input.designation.trim();
  const family = input.family ?? inferFamily(designation);
  if (family === null) return null;
  const valid = family === 'other' ? FREE_TEXT.test(designation) : GRAMMAR[family].test(designation);
  if (!valid) return null;
  return {
    designation,
    family,
    ...(input.depth === undefined ? {} : { depth: input.depth }),
    ...(input.handedness === undefined ? {} : { handedness: input.handedness }),
    ...(input.modelled === true ? { modelled: true as const } : {}),
  };
}

export const threadSchema = z
  .object({
    designation: z
      .string()
      .describe('Thread designation, e.g. "MJ6x1-4H5H", ".1900-32 UNJF-3B", "M6x1-6H", "1/4-20 UNC-2B". Cosmetic unless modelled is true.'),
    family: z.enum(THREAD_FAMILIES).optional().describe('Thread family (UNJ, MJ, UN, M, other). Omit to infer it from the designation.'),
    depth: z.number().positive().optional().describe('Threaded depth, in document length units. Omit for the full hole depth.'),
    handedness: z.enum(['right', 'left']).optional().describe('"right" (default if omitted) or "left".'),
    modelled: z
      .boolean()
      .optional()
      .describe(
        'true cuts a real helical thread groove (basic 60 degree internal ISO 68-1 profile; M / MJ / UN / UNJ designations with an explicit pitch, ' +
          'e.g. "M6x1"; MJ / UNJ root radius not applied, unverified) into the hole: the bore diameter must be about the minor diameter ' +
          '(D - 1.0825 P) and below the major diameter; needs a geometry kernel; changes the geometry and the shape recipe key. ' +
          'Omit or false = cosmetic, no geometry.',
      ),
  })
  .describe('Thread attribute of the hole: cosmetic by default, a real helical groove when modelled is true.');
