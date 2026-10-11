import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

/** Two unit boxes grouped as `name`; returns the document and the two box ids. */
export function groupedBoxes(name: string): { doc: CadDocument; ids: [string, string] } {
  const a = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  const b = execute(a.document, 'add_box', { size: [1, 1, 1] });
  const ids: [string, string] = [a.affected[0]!, b.affected[0]!];
  return { doc: execute(b.document, 'group_entities', { ids, name }).document, ids };
}
