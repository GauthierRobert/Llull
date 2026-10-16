/**
 * Links and grounding of the connection graph (FR-FPR-06), read from the document: rigid bodies, dynamic joints, kinematic joints,
 * declared intents and the grounded list.
 */

import type { CadDocument } from '../../model/types';
import { GROUND } from '../../model/dynamics';

export interface AssemblyLinks {
  readonly strongLinks: Array<readonly [string, string]>;
  readonly grounded: Set<string>;
  /** Part id -> rigid body id (pairs inside one body are welded and skipped). */
  readonly bodyOf: Map<string, string>;
}

/** Links between `partIds` implied by the document. */
export function assemblyLinks(doc: CadDocument, partIds: ReadonlySet<string>): AssemblyLinks {
  const strongLinks: Array<readonly [string, string]> = [];
  const grounded = new Set<string>();
  const bodyOf = new Map<string, string>();
  const members = (bodyId: string): string[] => (doc.dynamics?.bodies[bodyId]?.entityIds ?? []).filter((id) => partIds.has(id));
  const unite = (a: readonly string[], b: readonly string[]): void => {
    const [first, second] = [a[0], b[0]];
    if (first !== undefined && second !== undefined) strongLinks.push([first, second]);
  };
  for (const body of Object.values(doc.dynamics?.bodies ?? {})) {
    const ids = members(body.id);
    ids.forEach((id, index) => {
      bodyOf.set(id, body.id);
      if (index > 0) strongLinks.push([ids[0] as string, id]);
      if (body.fixed) grounded.add(id);
    });
  }
  for (const joint of Object.values(doc.dynamics?.joints ?? {})) {
    if (joint.parent === GROUND) members(joint.child).forEach((id) => grounded.add(id));
    else unite(members(joint.parent), members(joint.child));
  }
  const jointChildren = new Set(Object.values(doc.joints).map((joint) => joint.b.instanceId));
  for (const joint of Object.values(doc.joints)) {
    const [a, b] = [joint.a.instanceId, joint.b.instanceId];
    if (partIds.has(a) && partIds.has(b)) strongLinks.push([a, b]);
    if (partIds.has(a) && !jointChildren.has(a)) grounded.add(a);
  }
  for (const intent of Object.values(doc.prototype?.intents ?? {}))
    if (intent.kind !== 'overlap_by_design' && partIds.has(intent.a) && partIds.has(intent.b)) strongLinks.push([intent.a, intent.b]);
  for (const id of doc.prototype?.grounded ?? []) if (partIds.has(id)) grounded.add(id);
  return { strongLinks, grounded, bodyOf };
}

/** Declared intent on the unordered pair, if any (first in creation order). */
export function intentOf(doc: CadDocument, a: string, b: string): NonNullable<CadDocument['prototype']>['intents'][string] | undefined {
  return Object.values(doc.prototype?.intents ?? {}).find(
    (intent) => (intent.a === a && intent.b === b) || (intent.a === b && intent.b === a),
  );
}
