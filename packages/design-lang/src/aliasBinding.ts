/** What a design line's alias names, and the hint for commands a design may not run. Pure helpers of the interpreter. */

import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

/** Why a metaHistory / session command is not a design line, and where it goes instead. */
export function metaHint(name: string): string {
  if (name === 'set_parameter' || name === 'delete_parameter')
    return 'Declare parameters with `param <name> = <default>` (apply_design set= overrides).';
  if (['create_configuration', 'activate_configuration', 'save_recipe'].includes(name))
    return `Configurations and recipes are document inputs: run \`llull ${name} …\` after apply_design.`;
  if (name === 'set_camera' || name === 'fit_view') return 'The view is not part of the model: run it after apply_design.';
  return 'Run it outside the design (it is not part of the recipe).';
}

export interface LineRecords {
  /** What the alias names (record ids, else entity ids). */
  readonly ids: string[];
  readonly geometry: string[];
  /** Entities the line created (`alias.entity`). */
  readonly entities: string[];
}

/**
 * The records of one executed line: non-entity ids in `affected` and `data.*Id(s)` (walls, pipes, surfaces, fastener stacks…) if any,
 * else the entities it created, else what it changed. Geometry = its created entities (those derived from its records when it has both).
 */
export function lineRecords(
  before: CadDocument,
  after: CadDocument,
  created: readonly string[],
  affected: readonly string[],
  data: unknown,
): LineRecords {
  const isEntity = (id: string): boolean => after.entities[id] !== undefined || before.entities[id] !== undefined;
  const records: string[] = [];
  const add = (id: unknown): void => {
    if (typeof id === 'string' && id !== '' && !isEntity(id) && !records.includes(id)) records.push(id);
  };
  affected.forEach(add);
  if (isRecord(data))
    for (const [key, value] of Object.entries(data)) if (/Ids?$/.test(key)) (Array.isArray(value) ? value : [value]).forEach(add);
  const derived = created.filter((id) => records.some((record) => id.startsWith(`${record}:`)));
  const changed = affected.filter((id) => after.entities[id] !== undefined);
  const ids = records.length > 0 ? records : created.length > 0 ? [...created] : changed;
  const geometry = derived.length > 0 ? derived : created.length > 0 ? [...created] : changed;
  return { ids, geometry, entities: records.length > 0 ? [...created] : ids };
}
