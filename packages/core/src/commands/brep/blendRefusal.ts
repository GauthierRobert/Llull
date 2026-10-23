/**
 * Refusal of a fillet the kernel could not build (BLD M0): asks the kernel why (`blendReport`), maps the OCCT status to a stable BLD_* code
 * with the edges involved, and for a radius that is too large measures the largest scale of the requested sizes that builds.
 * @invariant a fillet the kernel cannot diagnose falls back to the generic summary of `modifyFailure`
 */

import { round6 } from '../../lib/compactNumber';
import { bisectLargestRadius } from '../../geometry/blend/probe';
import { type BlendFailure, diagnoseBlend, remediationOf } from '../../geometry/blend/diagnose';
import type { GeometryKernel, ShapeTopology } from '../../geometry/kernel';
import type { CadDocument, EdgeRadius, ShapeRecipe } from '../../model/types';
import type { CommandResult } from '../types';
import { codedRejection } from '../noop';
import { modifyFailure } from './modifyTarget';

type FilletRecipe = Extract<ShapeRecipe, { op: 'fillet' | 'chamfer' }>;

const SCALE_EVALUATIONS = 8;
const SCALE_TOLERANCE = 1 / 128;

const scaleRadius = (law: EdgeRadius, factor: number): EdgeRadius => ({
  ...law,
  size: law.size * factor,
  ...(law.sizeEnd === undefined ? {} : { sizeEnd: law.sizeEnd * factor }),
  ...(law.sizes === undefined ? {} : { sizes: law.sizes.map((point) => ({ t: point.t, size: point.size * factor })) }),
});

/** `recipe` with every size (size, sizeEnd, radii) multiplied by `factor`. */
function scaledFillet(recipe: FilletRecipe, factor: number): FilletRecipe {
  return {
    ...recipe,
    size: recipe.size * factor,
    ...(recipe.sizeEnd === undefined ? {} : { sizeEnd: recipe.sizeEnd * factor }),
    ...(recipe.radii === undefined ? {} : { radii: recipe.radii.map((law) => scaleRadius(law, factor)) }),
  };
}

/** The largest factor in (0, 1) of the requested sizes that builds, or null when nothing smaller was found to build. */
function largestWorkingScale(kernel: GeometryKernel, recipe: FilletRecipe): number | null {
  const outcome = bisectLargestRadius(
    (factor) => kernel.evaluate(scaledFillet(recipe, factor)) !== null,
    1,
    SCALE_TOLERANCE,
    SCALE_EVALUATIONS,
  );
  return outcome.maxRadius > 0 ? outcome.maxRadius : null;
}

const edgeText = (edge: number, topology: ShapeTopology | null): string => {
  const name = topology?.edges[edge]?.name;
  return name === undefined ? `${edge}` : `${edge} (${name})`;
};

/** What the failure message should say about the sizes the kernel refused. */
function sizeHint(kernel: GeometryKernel, recipe: FilletRecipe, failure: BlendFailure, unit: string): string {
  if (failure.code !== 'BLD_RADIUS_TOO_LARGE') return '';
  const factor = largestWorkingScale(kernel, recipe);
  if (factor === null) return '; no smaller size builds either';
  const radii = recipe.radii === undefined ? `${round6(recipe.size * factor)} ${unit}` : `all sizes x ${round6(factor)}`;
  return `; largest that builds: ${radii} (sizes scaled together; probe_fillet gives the limit per edge)`;
}

/** The param a refusal of `modified` is about: the radius (or edges of per-edge laws), or the center set of a full round. */
function refusalPath(modified: ShapeRecipe): string {
  if (modified.op === 'fullRound') return 'center';
  return modified.op === 'fillet' && modified.radii !== undefined ? 'edges' : 'radius';
}

/**
 * The refusal of `command` for `modified`: a coded BLD_* rejection when the kernel can explain a fillet failure, else the generic no-op.
 * @failure no `blendReport`, a non-fillet recipe, or a report that finds nothing wrong -> the generic summary (`modifyFailure`)
 */
export function blendRefusal(
  doc: CadDocument,
  command: string,
  id: string,
  kernel: GeometryKernel,
  modified: ShapeRecipe,
  result: 'refused' | 'empty',
  topology: ShapeTopology | null,
): CommandResult {
  const generic = (): CommandResult => ({ document: doc, summary: modifyFailure(command, kernel, modified, result), affected: [] });
  const reported = modified.op === 'fillet' || modified.op === 'faceBlend' || modified.op === 'fullRound';
  if (result !== 'refused' || !reported || kernel.blendReport === undefined) return generic();
  const report = kernel.blendReport(modified);
  const failure = report === null ? null : diagnoseBlend(report);
  if (failure === null) return generic();
  const where = failure.edges.length === 0 ? '' : ` [edges ${failure.edges.map((edge) => edgeText(edge, topology)).join(', ')}]`;
  const hint = modified.op === 'fillet' ? sizeHint(kernel, modified, failure, doc.units) : '';
  const partial = report?.partial === true ? '; OCCT built a partial result, discarded' : '';
  return codedRejection(
    doc,
    command,
    failure.code,
    `${failure.message}${where} on '${id}'${hint}${partial}`,
    remediationOf(failure.code),
    [id],
    [refusalPath(modified)],
  );
}
