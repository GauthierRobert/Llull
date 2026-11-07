/**
 * Hierarchy-scoped IFC export (plant 08 DAT §5.8, follow-up DAT-VIS-FU): the products of the plant objects in one hierarchy subtree, under the spatial
 * nodes from the root down to that subtree. A building element or a routed line without a plant object is not in any subtree, so it is left out.
 * @invariant pure; the scoped view lists only the ancestors of the scope node and its subtree, in definition order
 */

import { ancestry, resolveNode, subtreeIds } from '../../plant/data/hierarchy';
import { type PlantIfcView, plantIfcView } from '../../plant/data/view';
import type { CadDocument } from '@core/model/types';

export interface IfcScope {
  /** The plant view restricted to the scope: `nodes` are the ancestors and the subtree. */
  readonly view: PlantIfcView;
  /** The scope node id. */
  readonly nodeId: string;
  /** True when the building element is the target of a plant object inside the subtree. */
  readonly hasElement: (elementId: string) => boolean;
  /** True when the routed piping line (provider `pipeLine`) is the target of a plant object inside the subtree. */
  readonly hasRoutedLine: (lineId: string) => boolean;
}

export type IfcScopeOutcome = { readonly ok: true; readonly scope: IfcScope } | { readonly ok: false; readonly message: string };

export function ifcScopeOf(doc: CadDocument, reference: string): IfcScopeOutcome {
  const full = plantIfcView(doc);
  const node = resolveNode(full.data, reference);
  if (node === null || node === 'ambiguous')
    return { ok: false, message: `no (or an ambiguous) hierarchy node "${reference}": use its id, code or S1/P1/U10 path` };
  const inside = subtreeIds(full.data, node.id);
  const kept = new Set([...ancestry(full.data, node.id).map((entry) => entry.id), ...inside]);
  const owns = (object: { readonly object: { readonly hierarchyId: string } } | undefined): boolean =>
    object !== undefined && inside.has(object.object.hierarchyId);
  return {
    ok: true,
    scope: {
      nodeId: node.id,
      view: { ...full, nodes: full.nodes.filter((entry) => kept.has(entry.id)) },
      hasElement: (elementId) => owns(full.forElement(elementId)),
      hasRoutedLine: (lineId) => owns(full.forTarget('pipeLine', lineId)),
    },
  };
}
