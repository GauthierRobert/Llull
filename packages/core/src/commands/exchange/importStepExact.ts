/** import_step_exact: STEP -> exact healed B-rep solids stored as document blobs (aerospace 01 M4 MVP, TR-KRN-20..24). */

import type { CadDocument, DocumentBlob, Entity, ShapeRecipe } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import type { GeometryKernel } from '../../geometry/kernel';
import type { ImportedShapes, ImportedSolid } from '../../geometry/kernelPorts';
import { defineCommand, z } from '../schema';
import { changed, commandError, noop } from '../noop';
import { currentContext } from '../context';
import { nextId } from '../../lib/id';
import { base64ToText } from '../../lib/base64';
import { makeBlob, withBlob } from '../../model/blobs';
import { MM_PER_UNIT } from '../../model/units';
import { modelingToleranceOf, withKernelStamp } from '../../model/kernelSettings';
import { kernelStampOf } from '../persistence/kernelStamp';
import { newEntity } from '../entity/newEntity';
import { evaluateRecipe } from '../brep/kernelShape';
import { MAX_IMPORT_BODIES } from '../limits';
import { DEFAULT_MESH_COLOR } from './importMesh';
import { stepImportReport } from './stepImportReport';

const refuse = (doc: CadDocument, code: string, remediation: string, why: string, paths: readonly string[] = []): CommandResult => ({
  ...noop(doc, `import_step_exact: ${why}; no-op. [${code}]`),
  error: commandError(code, remediation, [], paths),
});

const IMPORT_ERRORS: Readonly<Record<'unreadable' | 'no_solid' | 'tessellated_only', readonly [string, string]>> = {
  unreadable: ['KRN_STEP_UNREADABLE', 'check the file (size, sha256, truncated?) and that it is an ISO 10303-21 STEP file'],
  tessellated_only: ['KRN_STEP_TESSELLATED_ONLY', "import it as a mesh with import_step (mode 'mesh')"],
  no_solid: [
    'KRN_STEP_NO_SOLID',
    'retry with sew: true and a larger linear tolerance (set_modeling_tolerance, mm); else import the surfaces separately',
  ],
};

/** Recipe leaf of a stored healed solid, scaled from the kernel's millimetres into the document unit. */
function bodyRecipe(doc: CadDocument, blob: string): ShapeRecipe {
  const leaf: ShapeRecipe = { op: 'brep', blob, format: 'occt-brep-v1' };
  const factor = 1 / MM_PER_UNIT[doc.units];
  return factor === 1 ? leaf : { op: 'scale', source: leaf, factor };
}

function stepText(params: { stepBase64?: string | undefined; text?: string | undefined }): string | null | undefined {
  if (params.text !== undefined) return params.text;
  return params.stepBase64 === undefined ? undefined : base64ToText(params.stepBase64);
}

interface Body {
  readonly entity: Entity;
  readonly blob: DocumentBlob;
  readonly solid: ImportedSolid;
}

/** Entities of the imported solids, or the index of the first solid the kernel cannot rebuild from its stored text. */
function buildBodies(doc: CadDocument, kernel: GeometryKernel, imported: ImportedShapes, name: string | undefined): Body[] | number {
  const bodies: Body[] = [];
  for (const [index, solid] of imported.solids.entries()) {
    const blob = makeBlob('model/x-occt-brep', solid.brep);
    kernel.loadBlob?.(blob.sha256, solid.brep);
    const result = evaluateRecipe(kernel, bodyRecipe(doc, blob.sha256));
    if (typeof result === 'string') return index;
    const label = name ?? solid.name;
    const entity = newEntity(
      'mesh',
      nextId('mesh'),
      { mesh: result.mesh, brep: result.recipe },
      [0, 0, 0],
      solid.color ?? DEFAULT_MESH_COLOR,
      { name: label === undefined ? undefined : imported.solids.length > 1 ? `${label} ${index + 1}` : label },
    );
    bodies.push({ entity, blob, solid });
  }
  return bodies;
}

function run(doc: CadDocument, params: Params, ctx: ExecutionContext | undefined): CommandResult {
  const source = params.fileName !== undefined ? 'fileName' : params.text !== undefined ? 'text' : 'stepBase64';
  if ((params.stepBase64 === undefined) === (params.text === undefined))
    return {
      ...noop(doc, 'import_step_exact: give exactly one of stepBase64 or text; no-op.'),
      error: commandError(
        'CMD_INVALID_PARAMS',
        'pass the STEP file as stepBase64 (base64) or text (Part 21), not both',
        [],
        ['stepBase64', 'text'],
      ),
    };
  const kernel = (ctx ?? currentContext()).kernel;
  if (kernel?.importShapes === undefined || kernel.loadBlob === undefined)
    return refuse(
      doc,
      'KRN_NO_EXACT_KERNEL',
      'run on the desktop backend or with --kernel occt',
      'the active kernel has no exact STEP import (kernel_info shows it)',
    );
  const text = stepText(params);
  if (text === null || text === undefined || text.trim() === '')
    return refuse(doc, ...IMPORT_ERRORS.unreadable, 'the STEP content is empty or not valid base64 UTF-8 text', [source]);
  const tolerance = modelingToleranceOf(doc);
  const heal = params.heal !== false;
  const options = {
    precision: tolerance.linear,
    maxTolerance: Math.max(0.1, tolerance.maxImportTolerance),
    heal,
    sew: params.sew !== false,
  };
  const imported = kernel.importShapes('step', text, options);
  if (imported === null) return refuse(doc, ...IMPORT_ERRORS.unreadable, 'the kernel could not read the file', [source]);
  if ('error' in imported) {
    const [code, remediation] = IMPORT_ERRORS[imported.error];
    return refuse(doc, code, remediation, imported.detail, [source]);
  }
  if (imported.solids.length > MAX_IMPORT_BODIES)
    return refuse(
      doc,
      'KRN_STEP_UNREADABLE',
      'split the file',
      `${imported.solids.length} solids exceed MAX_IMPORT_BODIES (${MAX_IMPORT_BODIES})`,
    );
  const invalid = imported.solids.flatMap((solid, index) => (solid.validAfterHeal ? [] : [index + 1]));
  if (invalid.length > 0)
    return refuse(
      doc,
      'KRN_HEAL_FAILED',
      'try heal: true / sew: false, or another linear tolerance (set_modeling_tolerance); else keep the original and report',
      `solid${invalid.length > 1 ? 's' : ''} ${invalid.join(', ')} still fail BRepCheck after ${heal ? 'healing' : 'reading (heal is off)'}; nothing imported`,
      [source],
    );
  const bodies = buildBodies(doc, kernel, imported, params.name);
  if (typeof bodies === 'number')
    return refuse(
      doc,
      'KRN_HEAL_FAILED',
      'retry the import',
      `the kernel cannot rebuild healed solid ${bodies + 1} from its stored B-rep`,
      [source],
    );

  const stamp = kernelStampOf(kernel);
  const original = params.keepOriginal === true ? makeBlob('model/step', text) : null;
  const staged = bodies.reduce((next, body) => withBlob(next, body.blob), original === null ? doc : withBlob(doc, original));
  const ids = bodies.map((body) => body.entity.id);
  const entities = { ...staged.entities, ...Object.fromEntries(bodies.map((body) => [body.entity.id, body.entity])) };
  const document: CadDocument = {
    ...(doc.kernelSettings === undefined && stamp !== null ? withKernelStamp(staged, stamp) : staged),
    entities,
    order: [...doc.order, ...ids],
  };
  const report = stepImportReport({
    ids,
    solids: bodies.map((body) => body.solid),
    imported,
    tolerance,
    options,
    doc,
    fileName: params.fileName,
    original: original?.sha256,
    blobs: bodies.map((body) => body.blob.sha256),
  });
  const warned = report.warnings.map((warning) => ` ${warning.code}: ${warning.message}.`).join('');
  return {
    ...changed(
      document,
      `import_step_exact: ${ids.length} exact solid${ids.length === 1 ? '' : 's'} (${ids.join(', ')}); ${report.census.faces} faces in the file, ` +
        `${report.solids.filter((solid) => solid.validAfterHeal).length}/${ids.length} valid after BRepCheck, max tolerance ${report.maxToleranceMm} mm; ` +
        `${imported.skipped.length} item${imported.skipped.length === 1 ? '' : 's'} skipped.${warned}`,
      ids,
    ),
    data: { report },
  };
}

const paramsSchema = z.object({
  stepBase64: z
    .string()
    .optional()
    .describe('The STEP file bytes, base64 encoded (ISO 10303-21 text, UTF-8/ASCII). Give exactly one of stepBase64 or text.'),
  text: z.string().optional().describe('The STEP file as Part 21 text. Give exactly one of stepBase64 or text.'),
  fileName: z.string().optional().describe('Original file name, kept in the report only.'),
  heal: z.boolean().optional().describe('Run shape healing (ShapeFix) on every solid at the document linear tolerance. Default true.'),
  sew: z.boolean().optional().describe('Sew loose shells and faces into closed solids. Default true.'),
  name: z.string().optional().describe('Entity name; several solids get a numeric suffix. Default: none.'),
  keepOriginal: z.boolean().optional().describe('Also store the STEP text as a model/step document blob for audit (large). Default false.'),
});

type Params = z.output<typeof paramsSchema>;

/**
 * @affects adds document blobs (healed BRepTools text per solid, optionally the STEP), creates one `mesh` entity per solid whose `brep` is a
 *   `brep` blob leaf (wrapped in a `scale` node when the document unit is not mm); affected = created ids
 * @invariant every created solid passed BRepCheck after healing, or nothing is imported; replay re-mints the same ids and the same blobs
 * @failure no exact kernel / unreadable STEP / tessellated-only / no solid / heal failure -> no-op, affected:[], error.code KRN_*
 */
export const importStepExact = defineCommand({
  name: 'import_step_exact',
  annotations: { requiresKernel: true },
  description:
    'Import a STEP file as exact B-rep solids (not triangles): the file is read, every solid is checked and healed (BRepCheck, ShapeFix, sewing of loose shells), ' +
    'stored as a content-addressed document blob and shown as one mesh entity per solid that keeps its exact shape (volumes, fillets, booleans and STEP export stay exact). ' +
    'Needs the exact OCC kernel (kernel_info); otherwise use import_step for a mesh. Give the file as stepBase64 or text. Lengths are converted from millimetres into the ' +
    'document unit. data.report lists per solid validAsRead / validAfterHeal / actions / maxToleranceMm / freeEdges / faces / faceted, the root census, skipped items and ' +
    'warnings (KRN_IMPORT_TOLERANCE_HIGH above kernelSettings maxImportTolerance). Refusals carry error.code: KRN_NO_EXACT_KERNEL, KRN_STEP_UNREADABLE, ' +
    'KRN_STEP_TESSELLATED_ONLY, KRN_STEP_NO_SOLID, KRN_HEAL_FAILED. Names and colours of the STEP are not read yet (use name).',
  params: paramsSchema,
  run,
});
