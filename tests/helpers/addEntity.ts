import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

type Added = { doc: CadDocument; id: string };

export function add(doc: CadDocument, name: string, params: unknown): Added {
  const result = execute(doc, name, params);
  return { doc: result.document, id: result.affected[0] as string };
}
