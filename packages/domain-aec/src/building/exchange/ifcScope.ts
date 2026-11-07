/**
 * Hierarchy-scoped IFC export (plant 08 DAT §5.8, follow-up DAT-VIS-FU): the products of the plant objects in one hierarchy subtree, under the spatial
 * nodes from the root down to that subtree. A building element or a routed line is IN scope when a plant object standing for it sits in the subtree;
 * the others are counted as omitted (no plant object at all, or a plant object above or beside the scope) and reported by the export.
 * @invariant pure; the scoped view lists only the ancestors of the scope node and its subtree, in definition order
 */

import { ancestry, resolveNode, subtreeIds } from '../../plant/data/hierarchy';
import { type PlantIfcView, plantIfcView } from '../../plant/data/view';
import type { CadDocument } from '@core/model/types';
import { getPiping } from '../../plant/piping/model';

/** `inScope`, or why not: no plant object stands for it / its plant object is outside the subtree (above it or in another branch). */
export type ScopeMembership = 'inScope' | 'noPlantObject' | 'outsideScope';

export interface IfcOmitted {
  readonly elements: { readonly noPlantObject: number; readonly outsideScope: number };
  readonly routedLines: { readonly noPlantObject: number; readonly outsideScope: number };
}

export interface IfcScope {
  /** The plant view restricted to the scope: `nodes` are the ancestors and the subtree. */
  readonly view: PlantIfcView;
  /** The scope node id. */
  readonly nodeId: string;
  readonly elementMembership: (elementId: string) => ScopeMembership;
  /** Membership of the routed piping line (provider `pipeLine`). */
  readonly lineMembership: (lineId: string) => ScopeMembership;
  /** True when the plant object sits in the subtree. */
  readonly hasObject: (objectId: string) => boolean;
}

export type IfcScopeOutcome = { readonly ok: true; readonly scope: IfcScope } | { readonly ok: false; readonly message: string };

export const emptyOmitted = (): {
  elements: { noPlantObject: number; outsideScope: number };
  routedLines: { noPlantObject: number; outsideScope: number };
} => ({ elements: { noPlantObject: 0, outsideScope: 0 }, routedLines: { noPlantObject: 0, outsideScope: 0 } });

export function ifcScopeOf(doc: CadDocument, reference: string): IfcScopeOutcome {
  const full = plantIfcView(doc);
  const node = reference.trim() === '' ? null : resolveNode(full.data, reference);
  if (node === null || node === 'ambiguous')
    return {
      ok: false,
      message: `no (or an ambiguous) hierarchy node "${reference}": use its id, code or S1/P1/U10 path (a code shared by two nodes needs the path)`,
    };
  const inside = subtreeIds(full.data, node.id);
  const kept = new Set([...ancestry(full.data, node.id).map((entry) => entry.id), ...inside]);
  const membership = (object: { readonly object: { readonly hierarchyId: string } } | undefined): ScopeMembership =>
    object === undefined ? 'noPlantObject' : inside.has(object.object.hierarchyId) ? 'inScope' : 'outsideScope';
  return {
    ok: true,
    scope: {
      nodeId: node.id,
      view: { ...full, nodes: full.nodes.filter((entry) => kept.has(entry.id)) },
      elementMembership: (elementId) => membership(full.forElement(elementId)),
      lineMembership: (lineId) => membership(full.forTarget('pipeLine', lineId)),
      hasObject: (objectId) => membership(full.forObject(objectId)) === 'inScope',
    },
  };
}

type Omitted = ReturnType<typeof emptyOmitted>;

/** The counts of what the scope left out: the elements (counted by the level loop) and the routed lines that have a run. */
export function omittedOf(doc: CadDocument, scope: IfcScope, elements: Omitted['elements']): IfcOmitted {
  const routedLines = emptyOmitted().routedLines;
  const lineIds = new Set(Object.values(getPiping(doc).runs).map((run) => run.lineId));
  for (const lineId of lineIds) {
    const membership = scope.lineMembership(lineId);
    if (membership !== 'inScope') routedLines[membership] += 1;
  }
  return { elements: { ...elements }, routedLines };
}

export const omittedTotal = (omitted: IfcOmitted): number =>
  omitted.elements.noPlantObject + omitted.elements.outsideScope + omitted.routedLines.noPlantObject + omitted.routedLines.outsideScope;

export const omittedMessage = (omitted: IfcOmitted): string =>
  `the scope left out ${omitted.elements.noPlantObject} building element(s) and ${omitted.routedLines.noPlantObject} routed line(s) with no plant object, and ${omitted.elements.outsideScope} element(s) and ${omitted.routedLines.outsideScope} routed line(s) whose plant object is outside the scope`;
