/**
 * SC-Q4b judge helper: a recipe is a list of top-level commands run one `execute` at a time, so each one is its own FeatureStep
 * (a `build_project` is a single step). History meta-commands are judged against the SAME recipe rebuilt from scratch.
 */
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { normalizeGeometry } from './normalize';

export interface RecipeStep {
  command: string;
  params: Record<string, unknown>;
  /** Alias for `affected[0]` of this step; later steps reference it as `$alias` inside their params. */
  as?: string;
}

function resolve(value: unknown, aliases: Map<string, string>): { value: unknown; missing: boolean } {
  if (typeof value === 'string' && value.startsWith('$')) {
    const id = aliases.get(value.slice(1));
    return { value: id ?? value, missing: id === undefined };
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => resolve(item, aliases));
    return { value: items.map((i) => i.value), missing: items.some((i) => i.missing) };
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, child]) => [key, resolve(child, aliases)] as const);
    return { value: Object.fromEntries(entries.map(([key, r]) => [key, r.value])), missing: entries.some(([, r]) => r.missing) };
  }
  return { value, missing: false };
}

/**
 * Run `steps` in order. A step whose `$alias` has no producer (its producing step was edited away) is skipped: that is what a replayed
 * step does when the entity it needs is gone.
 */
export function buildRecipe(steps: readonly RecipeStep[]): CadDocument {
  const aliases = new Map<string, string>();
  let doc = createEmptyDocument();
  for (const step of steps) {
    const params = resolve(step.params, aliases);
    if (params.missing) continue;
    const result = execute(doc, step.command, params.value);
    doc = result.document;
    const first = result.affected[0];
    if (step.as !== undefined && first !== undefined) aliases.set(step.as, first);
  }
  return doc;
}

/** What a regenerated document must share with the same recipe built from scratch. */
export function recipeState(doc: CadDocument): { geometry: unknown; materials: unknown; parameters: unknown; componentIds: string[] } {
  return {
    geometry: normalizeGeometry(doc),
    materials: doc.materials,
    parameters: doc.parameters,
    componentIds: Object.keys(doc.components).sort(),
  };
}
