import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { xy } from './xy';

type Added = { doc: CadDocument; id: string };

export function add(doc: CadDocument, name: string, params: unknown): Added {
  const result = execute(doc, name, params);
  return { doc: result.document, id: result.affected[0] as string };
}

/** Runs `[command, params]` steps in order from an empty doc; `ids[i]` is step i's first affected id. */
export function build(...steps: Array<readonly [string, unknown]>): { doc: CadDocument; ids: string[] } {
  let doc = createEmptyDocument();
  const ids = steps.map(([name, params]) => {
    const r = add(doc, name, params);
    doc = r.doc;
    return r.id;
  });
  return { doc, ids };
}

/** A `draw_polyline` step through flat coordinates (2 points → a line). */
export const pline = (c: number[], extra: object = {}): readonly [string, object] => ['draw_polyline', { points: xy(...c), ...extra }];
