/** Params of a hole and their all-or-nothing validation (07 FTR §4.1 `add_hole`): one `HoleSpec` + `HoleExtent`, or the refusal to return. */

import type { CadDocument } from '../../model/types';
import type { FtrCode } from '../../model/manufacturing';
import { HOLE_KINDS, type FastenerRef, type HoleExtent, type HoleSpec } from '../../model/features';
import { countersinkDepth, countersinkDiameter } from '../../lib/holeMath';
import { z } from '../schema';
import { holeFromFastener } from './fastenerHole';
import { parseThread, threadSchema } from './threads';

/** Drill point applied to a blind hole that gives none, degrees (reported as defaulted; source R8, AF-31). */
export const DEFAULT_DRILL_POINT_ANGLE = 118;

export const holeParams = z
  .object({
    kind: z
      .enum(HOLE_KINDS)
      .optional()
      .describe(
        '"simple" (plain bore, default), "counterbore" (needs cboreDiameter, cboreDepth) or "countersink" (needs cskAngle and cskDiameter or cskDepth).',
      ),
    diameter: z
      .number()
      .positive()
      .optional()
      .describe('Bore diameter, in document length units. Required unless fastener gives it from the catalogue.'),
    cboreDiameter: z.number().positive().optional().describe('Counterbore diameter, in document length units; must exceed diameter.'),
    cboreDepth: z.number().positive().optional().describe('Counterbore depth from the face, in document length units.'),
    cskDiameter: z
      .number()
      .positive()
      .optional()
      .describe('Countersink diameter at the face, in document length units; must exceed diameter. Alternative to cskDepth.'),
    cskDepth: z
      .number()
      .positive()
      .optional()
      .describe(
        'Countersink cone depth from the face, in document length units. Alternative to cskDiameter (D = d + 2*depth*tan(angle/2)).',
      ),
    cskAngle: z.number().optional().describe('Countersink included angle in degrees, in (0, 180), e.g. 82, 90, 100.'),
    thread: threadSchema.optional(),
    fastener: z
      .object({
        catalogId: z.string().describe('Fastener family id in doc.fasteners.catalogs.'),
        partNumber: z.string().describe('Part number; its dash token selects the catalogue size, whose hole diameter is used.'),
        fit: z.string().optional().describe('Optional fit label recorded with the hole (no geometric effect).'),
      })
      .optional()
      .describe('Standard fastener this hole is for: its clearance hole diameter comes from the document fastener catalogue.'),
  })
  .describe('Hole definition: kind, diameters, optional cosmetic thread and fastener reference.');

export const extentParams = z
  .object({
    kind: z.enum(['blind', 'through_all']).describe('"through_all" cuts through the whole part along the axis; "blind" stops at depth.'),
    depth: z
      .number()
      .optional()
      .describe('Blind only: cylindrical depth from the face, in document length units (drill point excluded). Must be inside the stock.'),
    drillPointAngle: z
      .number()
      .optional()
      .describe(
        `Blind only: drill point included angle in degrees in (0, 180); 0 = flat bottom. Omitted = ${DEFAULT_DRILL_POINT_ANGLE} (named as defaulted).`,
      ),
  })
  .describe('How far the hole goes.');

export type HoleParams = z.output<typeof holeParams>;
export type ExtentParams = z.output<typeof extentParams>;

export interface SpecProblem {
  readonly code: FtrCode;
  readonly why: string;
  readonly remediation: string;
  readonly paths: readonly string[];
}

const problem = (code: FtrCode, why: string, remediation: string, ...paths: string[]): SpecProblem => ({ code, why, remediation, paths });

export interface BuiltHole {
  readonly hole: HoleSpec;
  readonly extent: HoleExtent;
  /** Facts the summary should state: the fastener used, the defaulted drill point. */
  readonly notes: readonly string[];
}

function extentOf(input: ExtentParams, stepDepth: number): HoleExtent | SpecProblem {
  if (input.kind === 'through_all') return { kind: 'through_all' };
  const depth = input.depth;
  if (depth === undefined || !(depth > 0))
    return problem(
      'FTR_BLIND_DEPTH_INVALID',
      'a blind hole needs extent.depth > 0',
      'give extent.depth, or use through_all',
      'extent.depth',
    );
  if (depth <= stepDepth)
    return problem(
      'FTR_BLIND_DEPTH_INVALID',
      `blind depth ${depth} does not go below the counterbore / countersink (${stepDepth})`,
      'make extent.depth deeper than the counterbore or countersink',
      'extent.depth',
    );
  const angle = input.drillPointAngle;
  if (angle !== undefined && !(angle === 0 || (angle > 0 && angle < 180)))
    return problem(
      'FTR_DRILL_POINT_ANGLE_OUT_OF_RANGE',
      `drillPointAngle ${angle} is outside (0, 180)`,
      'give degrees, e.g. 118, or 0 for a flat bottom',
      'extent.drillPointAngle',
    );
  if (angle === 0) return { kind: 'blind', depth };
  return angle === undefined
    ? { kind: 'blind', depth, drillPointAngle: DEFAULT_DRILL_POINT_ANGLE, drillPointDefaulted: true }
    : { kind: 'blind', depth, drillPointAngle: angle };
}

/**
 * The hole and extent of `add_hole` params, resolving the fastener catalogue and the countersink depth form.
 * @failure first inconsistency -> SpecProblem with its stable code and offending param paths
 */
export function buildHole(doc: CadDocument, input: HoleParams, extentInput: ExtentParams): BuiltHole | SpecProblem {
  const notes: string[] = [];
  const kind = input.kind ?? 'simple';
  let diameter = input.diameter;
  const fastener: FastenerRef | undefined =
    input.fastener === undefined
      ? undefined
      : {
          catalogId: input.fastener.catalogId,
          partNumber: input.fastener.partNumber,
          ...(input.fastener.fit === undefined ? {} : { fit: input.fastener.fit }),
        };
  if (fastener !== undefined) {
    const found = holeFromFastener(doc, fastener);
    if (typeof found === 'string') {
      return problem(
        'FTR_FASTENER_CATALOG_UNAVAILABLE',
        found,
        'give explicit diameters, or install the fastener catalogue first',
        'hole.fastener',
      );
    }
    diameter ??= found.diameter;
    notes.push(`diameter ${diameter} from fastener ${fastener.catalogId} ${fastener.partNumber} (${found.source})`);
  }
  if (diameter === undefined || !(diameter > 0))
    return problem(
      'FTR_HOLE_DIAMETERS_INCONSISTENT',
      'hole.diameter is required (or a fastener that gives it)',
      'give hole.diameter',
      'hole.diameter',
    );
  let stepDepth = 0;
  let spec: HoleSpec = { kind, diameter };
  if (kind === 'counterbore') {
    const { cboreDiameter, cboreDepth } = input;
    if (cboreDiameter === undefined || cboreDepth === undefined || !(cboreDiameter > diameter))
      return problem(
        'FTR_HOLE_DIAMETERS_INCONSISTENT',
        `counterbore needs cboreDiameter > diameter (${diameter}) and cboreDepth > 0`,
        'countersink / counterbore diameter must exceed the hole diameter',
        'hole.cboreDiameter',
        'hole.cboreDepth',
      );
    stepDepth = cboreDepth;
    spec = { ...spec, cboreDiameter, cboreDepth };
  } else if (kind === 'countersink') {
    const angle = input.cskAngle;
    if (angle === undefined || !(angle > 0 && angle < 180))
      return problem(
        'FTR_CSK_ANGLE_OUT_OF_RANGE',
        `cskAngle ${String(angle)} is not in (0, 180) degrees`,
        'included angle in degrees, e.g. 82, 90, 100',
        'hole.cskAngle',
      );
    const cskDiameter =
      input.cskDiameter ?? (input.cskDepth === undefined ? undefined : countersinkDiameter(diameter, input.cskDepth, angle).value);
    if (cskDiameter === undefined || !(cskDiameter > diameter))
      return problem(
        'FTR_HOLE_DIAMETERS_INCONSISTENT',
        `countersink needs cskDiameter (or cskDepth) giving a diameter above ${diameter}`,
        'countersink / counterbore diameter must exceed the hole diameter',
        'hole.cskDiameter',
        'hole.cskDepth',
      );
    stepDepth = countersinkDepth(diameter, cskDiameter, angle).value;
    spec = { ...spec, cskDiameter, cskAngle: angle };
  }
  if (input.thread !== undefined) {
    const thread = parseThread(input.thread);
    if (thread === null)
      return problem(
        'FTR_THREAD_DESIGNATION_INVALID',
        `thread designation '${input.thread.designation}' fails the grammar of its family`,
        "use the family's designation form, e.g. MJ6x1-4H5H",
        'hole.thread.designation',
      );
    spec = { ...spec, thread };
  }
  if (fastener !== undefined) spec = { ...spec, fastener };
  const extent = extentOf(extentInput, stepDepth);
  if ('code' in extent) return extent;
  if (extent.kind === 'blind' && extent.drillPointDefaulted === true)
    notes.push(`drill point ${DEFAULT_DRILL_POINT_ANGLE} deg applied by default (source R8); pass drillPointAngle 0 for a flat bottom`);
  return { hole: spec, extent, notes };
}
