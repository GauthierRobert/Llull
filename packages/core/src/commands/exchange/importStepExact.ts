/**
 * import_step_exact: STEP -> exact healed B-rep solids stored as document blobs (aerospace 01 M4 MVP, TR-KRN-20..24) and, with an XDE-capable kernel,
 * the product tree of the file as components / instances with provenance and a geometric-validation-property check (aerospace 04 M3, TR-XCH-08).
 */

import type { CadDocument } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import type { GeometryKernel } from '../../geometry/kernel';
import type { ImportedExchange } from '../../geometry/kernelExchange';
import type { ImportedShapes } from '../../geometry/kernelPorts';
import { defineCommand, z } from '../schema';
import { changed, commandError, noop } from '../noop';
import { currentContext } from '../context';
import { base64ToText } from '../../lib/base64';
import { sha256Hex } from '../../lib/sha256';
import { summarizeStep21 } from '../../lib/step21/summary';
import { makeBlob, withBlob } from '../../model/blobs';
import { MM_PER_UNIT } from '../../model/units';
import { modelingToleranceOf, withKernelStamp } from '../../model/kernelSettings';
import type { ExchangeModel } from '../../model/exchange';
import { kernelStampOf } from '../persistence/kernelStamp';
import { MAX_IMPORT_BODIES } from '../limits';
import { buildBodies } from './importBodies';
import { simplifyTree } from './importSimplify';
import { stepImportReport } from './stepImportReport';
import { gvpPolicy } from './gvpBands';
import { buildTreeStructure, type TreeStructure } from './importTree';
import { describeProvenance } from './importProvenance';
import { verifyImportedProducts } from './importVerify';

/** Largest STEP accepted (characters of Part 21 text; 64 MiB): the text is also kept in the step params for replay. */
const MAX_STEP_CHARS = 64 * 1024 * 1024;

const refuse = (doc: CadDocument, code: string, remediation: string, why: string, paths: readonly string[] = []): CommandResult => ({
  ...noop(doc, `import_step_exact: ${why}; no-op. [${code}]`),
  error: commandError(code, remediation, [], paths),
});

const IMPORT_ERRORS: Readonly<Record<'unreadable' | 'no_solid' | 'tessellated_only' | 'unavailable', readonly [string, string]>> = {
  unreadable: ['KRN_STEP_UNREADABLE', 'check the file (size, sha256, truncated?) and that it is an ISO 10303-21 STEP file'],
  tessellated_only: ['KRN_STEP_TESSELLATED_ONLY', "import it as a mesh with import_step (mode 'mesh')"],
  no_solid: [
    'KRN_STEP_NO_SOLID',
    'retry with sew: true and a larger linear tolerance (set_modeling_tolerance, mm); else import the surfaces separately',
  ],
  unavailable: ['KRN_NO_EXACT_KERNEL', 'run on the desktop backend or with --kernel occt-native'],
};

function stepText(params: { stepBase64?: string | undefined; text?: string | undefined }): string | null | undefined {
  if (params.text !== undefined) return params.text;
  return params.stepBase64 === undefined ? undefined : base64ToText(params.stepBase64);
}

type StepRead =
  | { readonly imported: ImportedShapes; readonly tree: ImportedExchange | null }
  | 'unreadable'
  | { readonly error: string; readonly detail: string };

/** The product tree through XDE when the kernel has it and `assembly` is wanted, else the flat shape list. */
function readStep(
  kernel: GeometryKernel,
  text: string,
  options: { precision: number; maxTolerance: number; heal: boolean; sew: boolean },
  assembly: boolean,
): StepRead {
  if (assembly && kernel.importExchange !== undefined) {
    const tree = kernel.importExchange('step', text, options);
    if (tree !== null) return 'error' in tree ? tree : { imported: tree, tree: 'products' in tree ? simplifyTree(tree) : null };
  }
  const flat = kernel.importShapes?.('step', text, options) ?? null;
  if (flat === null) return 'unreadable';
  return 'error' in flat ? flat : { imported: flat, tree: null };
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
      'run on the desktop backend or with --kernel occt-native',
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
  const read = readStep(kernel, text, options, params.assembly !== false);
  if (read === 'unreadable') return refuse(doc, ...IMPORT_ERRORS.unreadable, 'the kernel could not read the file', [source]);
  if ('error' in read) {
    const [code, remediation] = IMPORT_ERRORS[read.error as keyof typeof IMPORT_ERRORS] ?? IMPORT_ERRORS.unreadable;
    return refuse(doc, code, remediation, read.detail, [source]);
  }
  const { imported, tree } = read;
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

  const mmPerUnit = MM_PER_UNIT[doc.units];
  const structure: TreeStructure | null =
    tree === null
      ? null
      : buildTreeStructure(
          tree,
          bodies.map((body) => body.entity),
          mmPerUnit,
        );
  const topLevel = structure?.topLevel ?? bodies.map((body) => body.entity);
  const stamp = kernelStampOf(kernel);
  const original = params.keepOriginal === true ? makeBlob('model/step', text) : null;
  const staged = bodies.reduce((next, body) => withBlob(next, body.blob), original === null ? doc : withBlob(doc, original));
  const ids = topLevel.map((entity) => entity.id);
  const solidIds = bodies.map((body) => body.entity.id);
  const entities = { ...staged.entities, ...Object.fromEntries(topLevel.map((entity) => [entity.id, entity])) };
  const components = structure === null ? doc.components : { ...doc.components, ...structure.components };

  let exchange: ExchangeModel | undefined = doc.exchange;
  let exchangeReport: ReturnType<typeof describeProvenance> | null = null;
  if (tree !== null && structure !== null) {
    const verify = params.verify !== false;
    const policy = gvpPolicy(params.gvpPolicy);
    const summary = summarizeStep21(text);
    const masses = verify
      ? bodies.map((body) => {
          const shape = kernel.evaluate({ op: 'brep', blob: body.blob.sha256, format: 'occt-brep-v1' });
          return shape === null ? null : (kernel.massProperties?.(shape) ?? null);
        })
      : null;
    const verifications = masses === null ? null : verifyImportedProducts(tree, masses, summary, policy);
    const perProduct = new Map(
      tree.products.map((product, index) => [index, product.solids.map((solid) => solidIds[solid] ?? '')] as const),
    );
    exchangeReport = describeProvenance({
      unit: doc.units,
      imported: tree,
      placements: structure.placements,
      solidIds: perProduct,
      verifications,
      summary,
      policy,
      fileName: params.fileName,
      sha256: params.sha256 ?? sha256Hex(text),
    });
    exchange = { provenance: { ...doc.exchange?.provenance, ...exchangeReport.provenance } };
  }
  const document: CadDocument = {
    ...(doc.kernelSettings === undefined && stamp !== null ? withKernelStamp(staged, stamp) : staged),
    entities,
    order: [...doc.order, ...ids],
    components,
    ...(exchange === undefined ? {} : { exchange }),
  };
  const base = stepImportReport({
    ids: solidIds,
    solids: bodies.map((body) => body.solid),
    imported,
    tolerance,
    options,
    doc,
    fileName: params.fileName,
    original: original?.sha256,
    blobs: bodies.map((body) => body.blob.sha256),
  });
  const report = {
    ...base,
    ...(exchangeReport === null ? {} : { exchange: exchangeReport.report }),
    skipped: [
      ...base.skipped,
      ...(structure?.nonRigid ?? []).map((name) => `occurrence '${name}' is mirrored or scaled: placed without rotation`),
    ],
    warnings: [...base.warnings, ...(exchangeReport?.warnings ?? [])],
    reviewRequired: (() => {
      const reasons = [...base.reviewRequired.reasons, ...(exchangeReport?.reasons ?? [])];
      return { value: reasons.length > 0, reasons };
    })(),
  };
  const warned = report.warnings.map((warning) => ` ${warning.code}: ${warning.message}.`).join('');
  const structured =
    tree !== null && structure !== null
      ? ` Product tree: ${tree.products.length} product${tree.products.length === 1 ? '' : 's'}, ${Object.keys(structure.components).length} component${Object.keys(structure.components).length === 1 ? '' : 's'}, ${tree.occurrences.length} occurrence${tree.occurrences.length === 1 ? '' : 's'}; GVP check ${exchangeReport?.report.gvpCheck.verified === true ? exchangeReport.report.gvpCheck.band : 'skipped'}.`
      : '';
  return {
    ...changed(
      document,
      `import_step_exact: ${bodies.length} exact solid${bodies.length === 1 ? '' : 's'} (${ids.join(', ')}); ${report.census.faces} faces in the file, ` +
        `${report.solids.filter((solid) => solid.validAfterHeal).length}/${bodies.length} valid after BRepCheck, max tolerance ${report.maxToleranceMm} mm; ` +
        `${imported.skipped.length} item${imported.skipped.length === 1 ? '' : 's'} skipped.${structured}${warned}`,
      ids,
    ),
    data: { report },
  };
}

const paramsSchema = z.object({
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

type Params = z.output<typeof paramsSchema>;

/**
 * @affects adds document blobs (healed BRepTools text per solid, optionally the STEP), creates one `mesh` entity per solid whose `brep` is a
 *   `brep` blob leaf (wrapped in a `scale` node when the document unit is not mm); with a product tree also one component per product, one
 *   instance per occurrence and `exchange.provenance`; affected = the top-level ids (solids of a plain part, the root instance of an assembly)
 * @invariant every created solid passed BRepCheck after healing, or nothing is imported; replay re-mints the same ids and the same blobs; a
 *   yellow / red / not-checkable validation-property band never blocks the import
 * @failure no exact kernel / unreadable STEP / tessellated-only / no solid / heal failure -> no-op, affected:[], error.code KRN_*
 */
export const importStepExact = defineCommand({
  name: 'import_step_exact',
  annotations: { requiresKernel: true },
  description:
    'Import a STEP file as exact B-rep solids (not triangles): the file is read, every solid is checked and healed (BRepCheck, ShapeFix, sewing of loose shells), ' +
    'stored as a content-addressed document blob and shown as one mesh entity per solid that keeps its exact shape (volumes, fillets, booleans and STEP export stay exact). ' +
    'Names and colours of the file are kept. An assembly keeps its structure: one component per product, one instance per placed occurrence (assembly: false flattens it). ' +
    'The geometric validation properties the sender embedded (volume, surface area, centroid) are compared with the recomputed ones per product (verify): ' +
    'data.report.exchange lists product, band green / yellow / red / not-checkable, both values and the exact file-unit factor (25.4 for inch); a red or ' +
    'not-checkable body is flagged unverified and the report asks for review, but the import still completes. ' +
    'Needs the exact OCC kernel (kernel_info); otherwise use import_step for a mesh. Give the file as stepBase64 or text. Lengths are converted from millimetres into the ' +
    'document unit. data.report lists per solid validAsRead / validAfterHeal / actions / maxToleranceMm / freeEdges / faces / faceted, the root census, skipped items and ' +
    'warnings (KRN_IMPORT_TOLERANCE_HIGH above kernelSettings maxImportTolerance; XCH_GVP_YELLOW / XCH_GVP_RED / XCH_GVP_NOT_CHECKABLE). Refusals carry error.code: ' +
    'KRN_NO_EXACT_KERNEL, KRN_STEP_UNREADABLE, KRN_STEP_TESSELLATED_ONLY, KRN_STEP_NO_SOLID, KRN_HEAL_FAILED.',
  params: paramsSchema,
  run,
});
