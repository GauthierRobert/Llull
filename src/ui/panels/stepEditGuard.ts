/**
 * @layer ui/panels
 * @pure
 *
 * Pre-flight for the History step editor. `edit_step_params` accepts any params object and a
 * replay that cannot run the step just drops its geometry. This dry-runs the edit (no document is
 * changed) and refuses when the step's own entities would all disappear.
 */

import { execute } from '@core/commands/registry';
import type { CadDocument, FeatureStep } from '@core/model/types';

/** A refusal message, or null when the edit keeps the step's geometry (or the step has none). */
export function stepEditRefusal(
  document: CadDocument,
  step: FeatureStep,
  params: Record<string, unknown>,
): string | null {
  const owned = (step.affected ?? []).filter((id) => id in document.entities);
  if (owned.length === 0 || step.suppressed === true) return null;
  const preview = execute(document, 'edit_step_params', { stepId: step.id, params });
  if (preview.document === document) return preview.summary;
  const survives = owned.some((id) => id in preview.document.entities);
  return survives
    ? null
    : `Refused: these parameters make '${step.name}' fail, which would remove its geometry. Nothing was changed.`;
}
