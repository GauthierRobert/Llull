/**
 * Readers and importers that are deliberately NOT in the hostile-input table (`hostileReaders.ts`), each with the reason.
 * Keys: a registered command name, or `<package dir>/src/<path>:<function>` for an exported `read*` / `parse*` function.
 * The completeness check in `hostileInput.test.ts` fails for a reader that is in neither the table nor this list.
 */

export const EXCLUDED_COMMANDS: Readonly<Record<string, string>> = {
  import_mesh:
    'takes structured arrays of numbers (already validated by the zod schema), not a file; the file readers are the import_mesh_file entry',
  load_plant_class_library: 'loads a bundled library by name; it reads no user-supplied text',
};

export const EXCLUDED_FUNCTIONS: Readonly<Record<string, string>> = {
  'core/src/commands/brep/faceBlendEdges.ts:readEdgeResult': 'reads the in-process CommandResult of a kernel call, not external input',
  'core/src/commands/brep/profileNotes.ts:readProfileNotes': 'reads kernel notes of a recipe, not external input',
  'core/src/commands/features/threads.ts:parseThread': 'takes the already zod-validated command params, not text',
  'core/src/commands/solids/loftAdvanced.ts:parseEnd': 'takes the already zod-validated command params, not text',
  'core/src/commands/solids/sweepLaws.ts:parseLaws': 'takes the already zod-validated command params, not text',
  'core/src/commands/solids/sweepOrientation.ts:parseOrientation': 'takes the already zod-validated command params, not text',
  'core/src/lib/law/parse.ts:parseLaw': 'takes a structured LawInput (zod-validated params), not text',
  'domain-aec/src/building/elements/wallLayers.ts:parseWallLayers': 'takes the already zod-validated command params, not text',
  'domain-aec/src/plant/equipment/commands/nozzleParams.ts:parseLocation': 'takes the already zod-validated command params, not text',
  'domain-aero/src/sheetmetal/convert/faces.ts:readSolid': 'reads a face graph produced by the kernel, not external input',
  'domain-aero/src/sheetmetal/profile.ts:readProfile': 'reads an entity of the document, not external input',
  'domain-cae/src/fatigue/feField.ts:readFatigueField': 'reads artifacts through the in-process FeArtifactPort (already parsed results)',
  'domain-cae/src/thermomech/mappedField.ts:readMappedField':
    'reads artifacts through the in-process FeArtifactPort (already parsed results)',
};
