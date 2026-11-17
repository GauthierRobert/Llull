/** The input and body phases of import_step_exact: validate and read the STEP, then place the healed solids (and the product tree) in the document. */

import type { CadDocument, DocumentBlob, Entity } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import type { GeometryKernel } from '../../geometry/kernel';
import type { ImportedExchange } from '../../geometry/kernelExchange';
import type { ImportedShapes } from '../../geometry/kernelPorts';
import { noop, commandError } from '../noop';
import { currentContext } from '../context';
import { base64ToText } from '../../lib/base64';
import { makeBlob, withBlob } from '../../model/blobs';
import { MM_PER_UNIT } from '../../model/units';
import { modelingToleranceOf } from '../../model/kernelSettings';
import { kernelStampOf } from '../persistence/kernelStamp';
import { MAX_IMPORT_BODIES } from '../limits';
import { buildBodies } from './importBodies';
import { simplifyTree } from './importSimplify';
import { buildTreeStructure, instanceDepth, type TreeStructure } from './importTree';
import { findComponentCycle } from '../assembly/assemblies';
import type { StepParams } from './importStepExactSchema';

export const refuse = (doc: CadDocument, code: string, remediation: string, why: string, paths: readonly string[] = []): CommandResult => ({
  ...noop(doc, `import_step_exact: ${why}; no-op. [${code}]`),
  error: commandError(code, remediation, [], paths),
});

const IMPORT_ERRORS: Readonly<Record<'unreadable' | 'no_solid' | 'tessellated_only' | 'unavailable', readonly [string, string]>> = {
  unreadable: ['KRN_STEP_UNREADABLE', 'check the file (size, sha256, truncated?) and that it is an ISO 10303-21 STEP file'],
  tessellated_only: ['KRN_STEP_TESSELLATED_ONLY', "import it as a mesh with the CLI tool import_step (mode 'mesh')"],
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
  format: 'step' | 'iges',
  text: string,
  options: { precision: number; maxTolerance: number; heal: boolean; sew: boolean },
  assembly: boolean,
): StepRead {
  if (assembly && kernel.importExchange !== undefined) {
    const tree = kernel.importExchange(format, text, options);
    if (tree !== null) return 'error' in tree ? tree : { imported: tree, tree: 'products' in tree ? simplifyTree(tree) : null };
  }
  const flat = kernel.importShapes?.(format, text, options) ?? null;
  if (flat === null) return 'unreadable';
  return 'error' in flat ? flat : { imported: flat, tree: null };
}

type ReadOptions = Parameters<typeof readStep>[3];

export interface SourceRead {
  readonly kernel: GeometryKernel;
  readonly text: string;
  readonly source: 'fileName' | 'text' | 'stepBase64';
  readonly tolerance: ReturnType<typeof modelingToleranceOf>;
  readonly options: ReadOptions;
  readonly heal: boolean;
  readonly imported: ImportedShapes;
  readonly tree: ImportedExchange | null;
}

/** Validate the request, read the file through the kernel and check that every solid is valid after healing; the first refusal otherwise. */
export function openStepSource(doc: CadDocument, params: StepParams, ctx: ExecutionContext | undefined): SourceRead | CommandResult {
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
  const read = readStep(kernel, params.format ?? 'step', text, options, params.assembly !== false);
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
  return { kernel, text, source, tolerance, options, heal, imported, tree };
}

type Bodies = Exclude<ReturnType<typeof buildBodies>, number>;

export interface Placed {
  readonly bodies: Bodies;
  readonly structure: TreeStructure | null;
  readonly depth: number;
  readonly original: DocumentBlob | null;
  readonly staged: CadDocument;
  readonly ids: string[];
  readonly solidIds: string[];
  readonly entities: Record<string, Entity>;
  readonly components: CadDocument['components'];
  readonly stamp: ReturnType<typeof kernelStampOf>;
}

/** Build the entities of the healed solids and the product tree, stage the blobs, or refuse (rebuild failure, cyclic tree). */
export function placeBodies(doc: CadDocument, params: StepParams, read: SourceRead): Placed | CommandResult {
  const { kernel, text, source, imported, tree } = read;
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
  const cyclic =
    structure === null ? undefined : Object.keys(structure.components).find((id) => findComponentCycle(structure.components, id) !== null);
  if (cyclic !== undefined)
    return refuse(
      doc,
      'KRN_STEP_UNREADABLE',
      'the file is malformed: report it to its sender',
      `the product tree contains itself (component ${cyclic}); nothing imported`,
      [source],
    );
  const depth = structure === null ? 0 : instanceDepth(structure.components, structure.topLevel);
  const topLevel = structure?.topLevel ?? bodies.map((body) => body.entity);
  const stamp = kernelStampOf(kernel);
  const original = params.keepOriginal === true ? makeBlob(params.format === 'iges' ? 'model/iges' : 'model/step', text) : null;
  const staged = bodies.reduce((next, body) => withBlob(next, body.blob), original === null ? doc : withBlob(doc, original));
  const ids = topLevel.map((entity) => entity.id);
  const solidIds = bodies.map((body) => body.entity.id);
  const entities = { ...staged.entities, ...Object.fromEntries(topLevel.map((entity) => [entity.id, entity])) };
  const components = structure === null ? doc.components : { ...doc.components, ...structure.components };
  return { bodies, structure, depth, original, staged, ids, solidIds, entities, components, stamp };
}
