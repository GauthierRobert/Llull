/**
 * The `*.llull-matlib.json` format (08 MAT §3.2): schema, semantic checks and the content hash. A library is valid when every material
 * has well-formed PHY-01 models with a source, unique ids and at most one preferred model per key. Its hash (sha256 of the canonical JSON
 * of the parsed library) is what documents and the private-library port pin.
 */

import { canonicalJson } from '../../lib/canonicalJson';
import { isHexColor } from '../../lib/isHexColor';
import { isReservedKey } from '../../lib/reservedKey';
import { sha256Hex } from '../../lib/sha256';
import { LICENCE_FLAGS, type MaterialLibrary } from '../../model/materialLibrary';
import { BASES, PROPERTY_DIRECTIONS, PROPERTY_VARIABLES, type PropertyModel } from '../../model/propertyModel';
import { modelProblem } from '../../model/propertyModelValidate';
import { z } from '../schema';
import { formHash } from '../document/propertyModels';
import { formSchema, withoutUndefined } from '../document/propertyModelSchema';
import { preferredConflicts } from './propertyKey';

const pair = z.tuple([z.number(), z.number()]);

const modelSchema = z.looseObject({
  id: z.string().min(1),
  property: z.string(),
  unit: z.string(),
  variables: z.array(z.looseObject({ variable: z.enum(PROPERTY_VARIABLES), unit: z.string() })),
  form: formSchema,
  validity: z.array(z.looseObject({ variable: z.enum(PROPERTY_VARIABLES), unit: z.string(), data: pair, equation: pair.optional() })),
  basis: z.enum(BASES),
  direction: z.enum(PROPERTY_DIRECTIONS).optional(),
  condition: z.record(z.string(), z.unknown()).optional(),
  provenance: z.looseObject({}),
  coefficientsSha256: z.string().optional(),
  preferred: z.literal(true).optional(),
});

const markingSchema = z.union([
  z.object({ regime: z.literal('none') }),
  z.object({ regime: z.literal('EAR99') }),
  z.object({ regime: z.literal('EAR'), eccn: z.string().min(1) }),
  z.object({ regime: z.literal('ITAR'), category: z.string().optional() }),
]);

export const specsSchema = z.array(
  z.object({
    body: z.string().describe('Issuing body, e.g. "SAE", "ASTM", "MIL".'),
    id: z.string().describe('Specification id, e.g. "AMS 4045".'),
    revision: z.string().optional().describe('Revision letter or date.'),
  }),
);
export const supersededSchema = z.object({
  by: z.string().describe('What replaces the source, e.g. "MMPDS".'),
  note: z.string().describe('Why / since when, e.g. "MIL-HDBK-5J cancelled 2003".'),
});

const materialSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  designation: z.string(),
  temper: z.string().optional(),
  productForm: z.string().optional(),
  specs: specsSchema,
  licence: z.enum(LICENCE_FLAGS),
  exportMarking: markingSchema,
  superseded: supersededSchema.optional(),
  color: z.string().optional(),
  metalness: z.number().optional(),
  roughness: z.number().optional(),
  propertyModels: z.array(modelSchema),
});

const librarySchema = z.object({
  format: z.literal('llull-material-library'),
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string(),
  licence: z.enum(LICENCE_FLAGS),
  exportMarking: markingSchema,
  storage: z.enum(['embedded', 'private']),
  sources: z.record(
    z.string(),
    z.object({
      citation: z.string(),
      url: z.string().optional(),
      edition: z.string().optional(),
      sha256: z.string().optional(),
      accessed: z.string().optional(),
    }),
  ),
  materials: z.array(materialSchema),
});

interface LibraryProblem {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

type LibraryParse = { readonly ok: true; readonly library: MaterialLibrary; readonly sha256: string } | LibraryProblem;

const problem = (code: string, path: string, message: string): LibraryProblem => ({ ok: false, code, message, path });

/** sha256 of the canonical JSON of `library` (key order and absent optionals do not matter). */
export const libraryHash = (library: MaterialLibrary): string => sha256Hex(canonicalJson(withoutUndefined(library)));

/** The model with its coefficient hash recomputed from the form (a hash in the file is never trusted). */
export const rehashed = (model: MaterialLibrary['materials'][number]['propertyModels'][number]): PropertyModel =>
  ({ ...model, coefficientsSha256: formHash(model.form) }) as unknown as PropertyModel;

function materialProblem(library: MaterialLibrary, index: number): LibraryProblem | null {
  const material = library.materials[index];
  if (material === undefined) return null;
  const at = `materials[${index}]`;
  if (isReservedKey(material.id)) return problem('MAT_LIBRARY_INVALID', `${at}.id`, `'${material.id}' is a reserved property name`);
  if (library.materials.findIndex((other) => other.id === material.id) !== index)
    return problem('MAT_LIBRARY_INVALID', `${at}.id`, `duplicate material id '${material.id}'`);
  if (material.color !== undefined && !isHexColor(material.color)) return problem('MAT_LIBRARY_INVALID', `${at}.color`, 'must be #rrggbb');
  for (const channel of ['metalness', 'roughness'] as const) {
    const value = material[channel];
    if (value !== undefined && !(value >= 0 && value <= 1)) return problem('MAT_LIBRARY_INVALID', `${at}.${channel}`, 'must be in [0, 1]');
  }
  const models = material.propertyModels.map(rehashed);
  const ids = new Set<string>();
  for (const [j, model] of models.entries()) {
    const where = `${at}.propertyModels[${j}]`;
    if (ids.has(model.id)) return problem('MAT_LIBRARY_INVALID', `${where}.id`, `duplicate model id '${model.id}' on '${material.id}'`);
    ids.add(model.id);
    const issue = modelProblem(model, new Set(models.map((other) => other.id)));
    if (issue !== null) return problem(issue.code, `${where}${issue.path.replace(/^model/, '')}`, issue.message);
    const sourceId = model.provenance.sourceId;
    if (sourceId !== undefined && !Object.hasOwn(library.sources, sourceId))
      return problem('MAT_PROVENANCE_MISSING', `${where}.provenance.sourceId`, `source '${sourceId}' is not listed in the library sources`);
  }
  const conflict = preferredConflicts(models)[0];
  if (conflict !== undefined)
    return problem(
      'MAT_PREFERRED_CONFLICT',
      `${at}.propertyModels`,
      `${conflict.map((model) => model.id).join(', ')} are all preferred for ${conflict[0]?.property ?? ''} on '${material.id}'`,
    );
  return null;
}

/**
 * Validate a library file value and hash it.
 * @failure not the library shape -> MAT_LIBRARY_INVALID with the JSON path; a model problem keeps its PHY-01 / MAT code
 *   (MAT_UNIT_DIMENSION, MAT_PROVENANCE_MISSING, PROP_TABLE_NOT_MONOTONIC, …); two preferred on one key -> MAT_PREFERRED_CONFLICT
 */
export function parseMaterialLibrary(raw: unknown): LibraryParse {
  const parsed = librarySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return problem('MAT_LIBRARY_INVALID', issue?.path.join('.') ?? '(library)', issue?.message ?? 'not a llull material library');
  }
  const library = withoutUndefined<MaterialLibrary>(parsed.data);
  for (let index = 0; index < library.materials.length; index += 1) {
    const found = materialProblem(library, index);
    if (found !== null) return found;
  }
  return { ok: true, library, sha256: libraryHash(library) };
}
