import type { CadDocument } from '../model/types';

export interface NoOpResult {
  document: CadDocument;
  summary: string;
  affected: [];
}

/** Graceful no-op: the unchanged document, `affected: []`, and an explanatory summary. */
export function noOp(document: CadDocument, summary: string): NoOpResult {
  return { document, summary, affected: [] };
}
