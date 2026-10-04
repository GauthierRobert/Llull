import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { CheckOutcome, Criterion, GradeContext } from '../contract';

/**
 * @layer tests/production/criteria
 *
 * Data integrity: the saved project reopens identical, and the feature history replays to the same
 * model — an office archives the file and must be able to regenerate it years later.
 */

/** Key-order-independent JSON: the same model serialized with a different insertion order. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

const definition = (doc: CadDocument): unknown => JSON.parse(serializeDocument(doc));

function saveLoadCheck({ document, deliverable }: GradeContext): CheckOutcome {
  const saved = deliverable('save');
  const reopened = execute(createEmptyDocument(), 'load_document', { json: saved });
  const same = canonical(definition(reopened.document)) === canonical(definition(document));
  return {
    pass: same,
    detail: same
      ? `project file (${Math.round(saved.length / 1024)} kB) reopens identical`
      : `reopened project differs: ${reopened.summary}`,
  };
}

function replayCheck({ document }: GradeContext): CheckOutcome {
  const replayed = execute(document, 'replay_history', {});
  const before = canonical(definition(document));
  const after = canonical(definition(replayed.document));
  if (before === after) {
    return {
      pass: true,
      detail: `${document.featureHistory.length} history steps replay to the same model`,
    };
  }
  const a = JSON.parse(before) as { document: Record<string, unknown> };
  const b = JSON.parse(after) as { document: Record<string, unknown> };
  const differing = Object.keys(a.document).filter(
    (key) => JSON.stringify(a.document[key]) !== JSON.stringify(b.document[key]),
  );
  return { pass: false, detail: `replay changes: ${differing.join(', ')} (${replayed.summary})` };
}

export function integrityCriteria(): Criterion[] {
  return [
    {
      id: 'save-load',
      area: 'data-integrity',
      requirement: 'The saved project file reopens to the identical model.',
      check: saveLoadCheck,
    },
    {
      id: 'replay',
      area: 'data-integrity',
      requirement: 'Replaying the feature history regenerates the identical model.',
      check: replayCheck,
    },
  ];
}
