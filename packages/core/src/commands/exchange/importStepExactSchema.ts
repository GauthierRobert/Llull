import { z } from '../schema';

/** Largest STEP accepted (characters of Part 21 text; 64 MiB): the text is also kept in the step params for replay. */
const MAX_STEP_CHARS = 64 * 1024 * 1024;

export const importStepExactParams = z.object({
  stepBase64: z
    .string()
    .max(Math.ceil((MAX_STEP_CHARS * 4) / 3) + 4)
    .optional()
    .describe('The STEP file bytes, base64 encoded (ISO 10303-21 text, UTF-8/ASCII). Give exactly one of stepBase64 or text.'),
  text: z.string().max(MAX_STEP_CHARS).optional().describe('The STEP file as Part 21 text. Give exactly one of stepBase64 or text.'),
  fileName: z.string().optional().describe('Original file name, kept in the report and provenance only.'),
  sha256: z
    .string()
    .optional()
    .describe('sha256 (hex) of the file bytes, computed by the host; kept in the provenance. Default: sha256 of the text.'),
  format: z
    .enum(['step', 'iges'])
    .optional()
    .describe(
      '"step" (default, ISO 10303-21) or "iges" (IGES 5.3; same healing, report and refusal codes). The file goes in text / stepBase64 either way.',
    ),
  heal: z.boolean().optional().describe('Run shape healing (ShapeFix) on every solid at the document linear tolerance. Default true.'),
  sew: z.boolean().optional().describe('Sew loose shells and faces into closed solids. Default true.'),
  name: z
    .string()
    .optional()
    .describe('Entity name overriding the names in the file; several solids get a numeric suffix. Default: the names of the file.'),
  keepOriginal: z.boolean().optional().describe('Also store the STEP text as a model/step document blob for audit (large). Default false.'),
  assembly: z
    .boolean()
    .optional()
    .describe(
      'Keep the assembly structure of the file: one component per product, one instance per placed occurrence (a part used twice is one component). ' +
        'Default true. False flattens everything into world-space solids.',
    ),
  verify: z
    .boolean()
    .optional()
    .describe(
      'Compare the geometric validation properties the sender embedded (volume, surface area, centroid) with what llull recomputes from the imported B-rep, ' +
        'per product, and flag the bodies unverified when they disagree or cannot be checked. Never blocks the import. Default true.',
    ),
  importPmi: z
    .boolean()
    .optional()
    .describe(
      'Attach the semantic PMI of an AP242 file (datums, feature control frames, size and location dimensions on faces) to the imported solids through apply_pmi_set: ' +
        'every item is review-required, an item whose face cannot be mapped is counted in data.report.pmi.unmapped, none is silently dropped. Default true; has no effect on a ' +
        'file without PMI or with assembly false.',
    ),
  gvpPolicy: z
    .object({
      greenRel: z.number().optional().describe('Largest relative volume / area difference still green. Default 1e-3.'),
      yellowRel: z.number().optional().describe('Largest relative volume / area difference still yellow (red beyond). Default 1e-2.'),
      greenCentroidPerDiag: z
        .number()
        .optional()
        .describe('Largest centroid distance still green, as a fraction of the bounding-box diagonal. Default 1e-3.'),
      yellowCentroidMm: z.number().optional().describe('Largest centroid distance still yellow, in millimetres. Default 1.'),
    })
    .optional()
    .describe('Band limits of the validation-property check; each omitted limit keeps its default.'),
});

export type StepParams = z.output<typeof importStepExactParams>;
