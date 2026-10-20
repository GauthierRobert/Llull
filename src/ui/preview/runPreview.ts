// Dry run of one command on a document through the same `execute` the store uses. `execute` is pure (L3): the input document is
// never touched, so a preview is just "what would this produce"; only `dispatch` (on commit) changes anything.

import { execute } from '@core/commands/registry';
import type { CadDocument, Entity, EntityId } from '@core/model/types';

export interface PreviewOutcome {
  /** The command would change the document. */
  ok: boolean;
  /** The command's own summary; on refusal this is the reason shown to the user. */
  summary: string;
  /** Result entities the command created or changed (what the ghost draws). */
  entities: readonly Entity[];
  /** Existing entities the command would consume or replace (drawn faint underneath the ghost). */
  replacedIds: readonly EntityId[];
}

const refused = (summary: string): PreviewOutcome => ({ ok: false, summary, entities: [], replacedIds: [] });

/** @pure */
export function runPreview(doc: CadDocument, name: string, params: unknown): PreviewOutcome {
  try {
    const result = execute(doc, name, params);
    if (result.document === doc || result.affected.length === 0) return refused(result.summary);
    const entities = result.affected.map((id) => result.document.entities[id]).filter((entity): entity is Entity => entity !== undefined);
    const replacedIds = result.affected.filter((id) => id in doc.entities && !(id in result.document.entities));
    return { ok: true, summary: result.summary, entities, replacedIds };
  } catch (error) {
    return refused(`Preview failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
