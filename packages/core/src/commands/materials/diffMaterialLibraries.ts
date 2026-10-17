/** diff_material_libraries (08 MAT M8, VC-MAT-13): what changed between two library versions, keyed by (material id, value id). */

import { canonicalJson } from '../../lib/canonicalJson';
import type { LibraryMaterial, MaterialLibrary } from '../../model/materialLibrary';
import type { PropertyModel } from '../../model/propertyModel';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { rehashed } from './libraryFormat';
import { loadLibrary } from './librarySource';
import { refuseMaterial } from './refusal';

const side = (
  which: string,
): z.ZodObject<{
  version: z.ZodString;
  libraryId: z.ZodOptional<z.ZodString>;
  library: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}> =>
  z.object({
    version: z
      .string()
      .describe(`${which}: version label. For an inline library it must equal library.version; for a file, the version to read.`),
    libraryId: z.string().optional().describe(`${which}: id of a library file held on this machine (instead of library).`),
    library: z.record(z.string(), z.unknown()).optional().describe(`${which}: the library object (inline, instead of libraryId).`),
  });

const RECORD_FIELDS = ['designation', 'temper', 'productForm', 'specs', 'licence', 'exportMarking', 'superseded'] as const;

const modelsOf = (material: LibraryMaterial): Map<string, PropertyModel> =>
  new Map(material.propertyModels.map((model) => [model.id, rehashed(model)]));

/** The value as an agent compares it: constant value or form kind, unit, basis, direction, condition, provenance. */
const viewOf = (model: PropertyModel): Record<string, unknown> => ({
  ...(model.form.kind === 'constant' ? { value: model.form.value } : { form: model.form.kind }),
  unit: model.unit,
  basis: model.basis,
  ...(model.direction !== undefined ? { direction: model.direction } : {}),
  ...(model.condition !== undefined ? { condition: model.condition } : {}),
  provenance: model.provenance,
});

/** Top-level fields in which two versions of a value differ. */
const differingFields = (a: PropertyModel, b: PropertyModel): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) =>
      canonicalJson((a as unknown as Record<string, unknown>)[key]) !== canonicalJson((b as unknown as Record<string, unknown>)[key]),
  );

interface Diff {
  readonly materialsAdded: string[];
  readonly materialsRemoved: string[];
  readonly recordChanges: Record<string, unknown>[];
  readonly added: Record<string, unknown>[];
  readonly removed: Record<string, unknown>[];
  readonly changed: Record<string, unknown>[];
  unchanged: number;
}

function diffLibraries(a: MaterialLibrary, b: MaterialLibrary): Diff {
  const diff: Diff = { materialsAdded: [], materialsRemoved: [], recordChanges: [], added: [], removed: [], changed: [], unchanged: 0 };
  const before = new Map(a.materials.map((material) => [material.id, material]));
  const after = new Map(b.materials.map((material) => [material.id, material]));
  for (const id of before.keys()) if (!after.has(id)) diff.materialsRemoved.push(id);
  for (const [id, next] of after) {
    const previous = before.get(id);
    if (previous === undefined) {
      diff.materialsAdded.push(id);
      continue;
    }
    const fields = RECORD_FIELDS.filter((field) => canonicalJson(previous[field]) !== canonicalJson(next[field]));
    if (fields.length > 0)
      diff.recordChanges.push({
        material: id,
        fields: [...fields],
        old: Object.fromEntries(fields.map((f) => [f, previous[f]])),
        new: Object.fromEntries(fields.map((f) => [f, next[f]])),
      });
    const oldModels = modelsOf(previous);
    const newModels = modelsOf(next);
    for (const [modelId, model] of oldModels)
      if (!newModels.has(modelId)) diff.removed.push({ material: id, modelId, property: model.property, old: viewOf(model) });
    for (const [modelId, model] of newModels) {
      const old = oldModels.get(modelId);
      if (old === undefined) diff.added.push({ material: id, modelId, property: model.property, new: viewOf(model) });
      else if (canonicalJson(old) === canonicalJson(model)) diff.unchanged += 1;
      else
        diff.changed.push({
          material: id,
          modelId,
          property: model.property,
          fields: differingFields(old, model),
          old: viewOf(old),
          new: viewOf(model),
        });
    }
  }
  return diff;
}

/**
 * @affects nothing — read-only; data { a, b, identical, materialsAdded, materialsRemoved, recordChanges, added, removed, changed, unchanged }
 * @invariant values are keyed by (material id, value id); a changed value lists old and new value, unit, basis and provenance
 * @failure a side that is unreadable or invalid -> rejection with the code of loadLibrary
 */
export const diffMaterialLibraries = defineCommand({
  name: 'diff_material_libraries',
  annotations: { readOnly: true },
  description:
    'Compare two versions of a material library (for example MMPDS editions) and list what changed: materials added / removed, record fields ' +
    'changed, values added / removed / changed keyed by (material id, value id), each change with old and new value, unit, basis and provenance. ' +
    'Each side is an inline library object or { libraryId, version } of a file held on this machine. Use it before import_material_library with replace: true.',
  params: z.object({ a: side('Old version').describe('The old version.'), b: side('New version').describe('The new version.') }),
  run: (doc, params, ctx): CommandResult => {
    const left = loadLibrary(params.a, ctx, 'a');
    if (!left.ok) return refuseMaterial(doc, 'diff_material_libraries', left.code, left.message, { path: left.path });
    const right = loadLibrary(params.b, ctx, 'b');
    if (!right.ok) return refuseMaterial(doc, 'diff_material_libraries', right.code, right.message, { path: right.path });
    const diff = diffLibraries(left.library, right.library);
    const identical =
      left.sha256 === right.sha256 ||
      diff.materialsAdded.length +
        diff.materialsRemoved.length +
        diff.recordChanges.length +
        diff.added.length +
        diff.removed.length +
        diff.changed.length ===
        0;
    const named = (library: MaterialLibrary, sha256: string): Record<string, string> => ({
      libraryId: library.id,
      version: library.version,
      sha256,
    });
    return report(
      doc,
      `diff_material_libraries ${left.library.id}@${left.library.version} → ${right.library.id}@${right.library.version}: ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed value(s); ` +
        `${diff.materialsAdded.length} material(s) added, ${diff.materialsRemoved.length} removed, ${diff.unchanged} unchanged.`,
      { a: named(left.library, left.sha256), b: named(right.library, right.sha256), identical, ...diff, unchanged: diff.unchanged },
    );
  },
});
