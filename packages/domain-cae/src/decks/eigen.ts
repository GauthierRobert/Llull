/** Eigenvalue procedures (modal `*FREQUENCY`, linear buckling `*BUCKLE`) of the static deck: same materials, sets and constraints as 05. */

import { boundaryData, mechanicalStepLines } from './mechanical';
import { isDeckRefusal, loadCasesOf, type DeckContext, type DeckRefusal, type DeckSections } from './context';
import { commentText, linesText, num } from './format';

/** Modes requested when the case gives none. */
const DEFAULT_MODES = 6;

const modesOf = (ctx: DeckContext): number => Math.max(1, Math.round(ctx.analysis.modes ?? DEFAULT_MODES));

/** Lower bound (Hz) written as the second field of `*FREQUENCY` for a case without supports (singular stiffness matrix). A llull choice: the shift semantics of a negative lower bound are UNVERIFIED (ccx may read it as the shift sigma = (2 pi fmin)^2, i.e. +0.4 for -1 Hz, not as a bound below zero). */
const FREE_FREE_LOWER_BOUND_HZ = -1;

/** Data line of `*FREQUENCY`: `n`, or `n, [min], [max]` for a band (cycles/time = Hz); a supportless case without a stated minimum gets a small negative one. */
function frequencyLine(ctx: DeckContext): string {
  const band = ctx.analysis.frequencyRangeHz;
  const free = ctx.analysis.constraintOrder.length === 0;
  if (band === undefined && !free) return num(modesOf(ctx));
  const minimum = band?.min ?? (free ? FREE_FREE_LOWER_BOUND_HZ : undefined);
  const fields = [num(modesOf(ctx)), minimum === undefined ? '' : num(minimum)];
  if (band?.max !== undefined) fields.push(num(band.max));
  return fields.join(', ');
}

/**
 * Modal step: `*FREQUENCY, <n>`, the constraints (loads are not part of a free vibration), eigenvectors in the `.frd` (`U`) and the
 * eigenvalue table in the `.dat` (CalculiX writes it for every `*FREQUENCY` step).
 * @invariant one step; the result sets of the `.frd` are the modes in ascending frequency
 * @failure unresolved constraint target -> FEA_TARGET_UNRESOLVED
 */
export function modalStep(ctx: DeckContext): DeckSections {
  const boundary = boundaryData(ctx);
  if (!Array.isArray(boundary)) return boundary;
  const lines = ['** modal analysis', '*STEP', '*FREQUENCY', frequencyLine(ctx)];
  if (boundary.length > 0) lines.push('*BOUNDARY', ...boundary);
  lines.push('*NODE FILE', 'U', '*END STEP');
  return { text: linesText(lines) };
}

/**
 * Buckling. Without a `preloadLoadCase`: ONE `*BUCKLE, <n>` step holding the constraints and the loads of the first load case (the reference load,
 * which the factors multiply). With one: a `*STATIC` step first (constraints and the loads of the preload case, no output), then the `*BUCKLE` step
 * with the loads of the first OTHER load case on top (`*CLOAD` / `*DLOAD` without `OP=NEW`, so the preload stays): the preload stresses the
 * structure and is not multiplied. A modifying card REPLACES the value at the same node and dof / element and face / `GRAV` of the earlier step instead
 * of adding to it, so the BUCKLE step writes preload + reference summed (a target loaded in both cases gets the sum; one loaded in only one case gets its
 * own value, which equals the preload value when it comes from the preload). Measured with ccx 2.21 (server/tests/feaBucklingPreload.test.ts): the
 * factors multiply the WHOLE *BUCKLE step load, preload + reference; the static step's stress is not held as a base state (also not with NLGEOM or
 * with reference-only *BUCKLE loads), so a constant preload cannot be expressed this way. Buckling
 * factors are in the `.dat` (`B U C K L I N G   F A C T O R   O U T P U T`), the mode shapes in the `.frd`.
 * @failure no load / no reference load case besides the preload -> FEA_NO_LOADS; unresolved targets -> FEA_TARGET_UNRESOLVED
 */
export function bucklingSteps(ctx: DeckContext): DeckSections {
  if (ctx.analysis.loadOrder.length === 0)
    return refuse('FEA_NO_LOADS', `buckling analysis '${ctx.analysisId}' has no load: the buckling factor multiplies the applied load`, [
      ctx.analysisId,
    ]);
  const preload = ctx.analysis.preloadLoadCase;
  const cases = loadCasesOf(ctx.analysis).filter(({ name }) => name !== preload);
  const loadCase = cases[0]?.name;
  if (loadCase === undefined)
    return refuse(
      'FEA_NO_LOADS',
      `buckling analysis '${ctx.analysisId}' has no load case besides the preload '${preload ?? ''}': nothing to scale`,
      [ctx.analysisId],
    );
  const lines: string[] = [];
  if (preload !== undefined) {
    const preloaded = mechanicalStepLines(ctx, preload);
    if (isDeckRefusal(preloaded)) return preloaded;
    lines.push(`** buckling preload (ccx scales it with the reference): load case ${commentText(preload)}`, '*STEP', '*STATIC');
    lines.push(...preloaded.text.split('\n').filter((line) => line !== ''), '*END STEP');
  }
  const mechanical =
    preload === undefined
      ? mechanicalStepLines(ctx, loadCase)
      : mechanicalStepLines(ctx, loadCase, { scale: () => 1, parameters: '', boundary: false, addLoadCases: [preload] });
  if (isDeckRefusal(mechanical)) return mechanical;
  lines.push(`** buckling reference load case ${commentText(loadCase)}`, '*STEP', '*BUCKLE', num(modesOf(ctx)));
  lines.push(...mechanical.text.split('\n').filter((line) => line !== ''));
  lines.push('*NODE FILE', 'U', '*END STEP');
  return { text: linesText(lines) };
}

const refuse = (code: string, message: string, ids: readonly string[]): DeckRefusal => ({ code, message, ids });
