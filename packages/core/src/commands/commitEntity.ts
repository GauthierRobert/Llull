import type { CadDocument, Entity } from '../model/types';
import type { CommandResult } from './types';
import { withEntity } from './entityOps';

/**
 * `doc` with `entity` appended, reported as the one created entity.
 * @pure
 */
export function commitEntity(doc: CadDocument, entity: Entity, summary: string): CommandResult {
  return { document: withEntity(doc, entity), summary, affected: [entity.id] };
}
