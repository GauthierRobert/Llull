/** Eigenvalue procedures (modal `*FREQUENCY`, linear buckling `*BUCKLE`) of the static deck: same materials, sets and constraints as 05. */

import { boundaryData, mechanicalStepLines } from './mechanical';
import { isDeckRefusal, loadCasesOf, type DeckContext, type DeckRefusal, type DeckSections } from './context';
import { commentText, linesText, num } from './format';

/** Modes requested when the case gives none. */
const DEFAULT_MODES = 6;

const modesOf = (ctx: DeckContext): number => Math.max(1, Math.round(ctx.analysis.modes ?? DEFAULT_MODES));

/**
 * Modal step: `*FREQUENCY, <n>`, the constraints (loads are not part of a free vibration), eigenvectors in the `.frd` (`U`) and the
 * eigenvalue table in the `.dat` (CalculiX writes it for every `*FREQUENCY` step).
 * @invariant one step; the result sets of the `.frd` are the modes in ascending frequency
 * @failure unresolved constraint target -> FEA_TARGET_UNRESOLVED
 */
export function modalStep(ctx: DeckContext): DeckSections {
  const boundary = boundaryData(ctx);
  if (!Array.isArray(boundary)) return boundary;
  const lines = ['** modal analysis', '*STEP', '*FREQUENCY', num(modesOf(ctx))];
  if (boundary.length > 0) lines.push('*BOUNDARY', ...boundary);
  lines.push('*NODE FILE', 'U', '*END STEP');
  return { text: linesText(lines) };
}

/**
 * Buckling: ONE `*BUCKLE, <n>` step holding the constraints and the loads of the first load case (CalculiX takes the reference load of
 * a buckling step from the step itself; a preceding `*STATIC` step is a pre-stress, not the reference). Buckling factors multiply that load
 * pattern; they are in the `.dat` (`B U C K L I N G   F A C T O R   O U T P U T`), the mode shapes in the `.frd`.
 * @failure no load -> FEA_NO_LOADS; unresolved targets -> FEA_TARGET_UNRESOLVED
 */
export function bucklingSteps(ctx: DeckContext): DeckSections {
  if (ctx.analysis.loadOrder.length === 0)
    return refuse('FEA_NO_LOADS', `buckling analysis '${ctx.analysisId}' has no load: the buckling factor multiplies the applied load`, [
      ctx.analysisId,
    ]);
  const loadCase = loadCasesOf(ctx.analysis)[0]?.name ?? 'LC1';
  const mechanical = mechanicalStepLines(ctx, loadCase);
  if (isDeckRefusal(mechanical)) return mechanical;
  const lines = [`** buckling reference load case ${commentText(loadCase)}`, '*STEP', '*BUCKLE', num(modesOf(ctx))];
  lines.push(...mechanical.text.split('\n').filter((line) => line !== ''));
  lines.push('*NODE FILE', 'U', '*END STEP');
  return { text: linesText(lines) };
}

const refuse = (code: string, message: string, ids: readonly string[]): DeckRefusal => ({ code, message, ids });
