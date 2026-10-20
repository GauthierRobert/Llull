/**
 * STEP application protocol of kernel-written text. The kernel writes AP214 (AUTOMOTIVE_DESIGN); AP242 (managed model based 3D
 * engineering) is a superset of the entities written here (products, shape representations, advanced B-reps, styled items, next-assembly
 * usage), so retargeting only changes the declarations: FILE_SCHEMA, APPLICATION_PROTOCOL_DEFINITION and APPLICATION_CONTEXT.
 * @failure text without those declarations -> the matching part is left untouched (a missing FILE_SCHEMA is added to the HEADER section)
 */

export type StepSchema = 'ap214' | 'ap242';

export const AP242_FILE_SCHEMA = 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }';

const FILE_SCHEMA_PATTERN = /FILE_SCHEMA\s*\(\s*\([^)]*\)\s*\)\s*;/;
const PROTOCOL_PATTERN = /(APPLICATION_PROTOCOL_DEFINITION\(\s*'[^']*'\s*,\s*)'[^']*'\s*,\s*\d+/;
const CONTEXT_PATTERN = /(APPLICATION_CONTEXT\(\s*)'[^']*'/;

/** `step` declared as AP242 (any AP214 declarations rewritten); AP214 text is returned unchanged. */
export function retargetStepSchema(step: string, schema: StepSchema): string {
  if (schema === 'ap214') return step;
  const declaration = `FILE_SCHEMA(('${AP242_FILE_SCHEMA}'));`;
  const withSchema = FILE_SCHEMA_PATTERN.test(step)
    ? step.replace(FILE_SCHEMA_PATTERN, declaration)
    : step.replace(/(HEADER;\s*)(ENDSEC;)/, `$1${declaration}\n$2`);
  return withSchema
    .replace(PROTOCOL_PATTERN, "$1'ap242_managed_model_based_3d_engineering',2011")
    .replace(CONTEXT_PATTERN, "$1'managed model based 3d engineering'");
}
