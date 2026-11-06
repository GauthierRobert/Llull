/**
 * Clashes of external bodies (pipe parts and their insulation envelopes, `clashSources`) against building solids and against each other: a sweep along
 * x finds the boxes whose extents overlap, then the oriented-box test (`boxOverlap`) gives the penetration depth.
 * @invariant an `insulation` or `clearance` (keep-clear zone) clash is reported only for a pair that has no hard clash of its own; bodies of one group, and groups connected to each other
 *   by design, never clash
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import { getBuilding } from '../../building/model';
import { type OrientedBox, boxExtent, boxOverlap, elementBoxes } from './clashBoxes';
import type { ExternalBody } from './clashSources';

export interface ExternalClash {
  readonly a: string;
  readonly b: string;
  readonly kind: 'hard' | 'insulation' | 'clearance';
  /** Penetration depth in document units. */
  readonly depth: number;
}

interface Item {
  readonly id: string;
  /** Run id of an external body, the element id of a building solid. */
  readonly group: string;
  readonly envelope: boolean;
  readonly zone: boolean;
  readonly external: boolean;
  readonly connectedTo: readonly string[];
  readonly box: OrientedBox;
  readonly min: Vec3;
  readonly max: Vec3;
}

const itemOf = (
  id: string,
  group: string,
  kind: ExternalBody['kind'] | 'building',
  connectedTo: readonly string[],
  box: OrientedBox,
): Item => ({
  id,
  group,
  envelope: kind === 'envelope',
  zone: kind === 'clearance',
  external: kind !== 'building',
  connectedTo,
  box,
  ...boxExtent(box),
});

const disjoint = (a: Item, b: Item): boolean =>
  [1, 2].some((axis) => (a.max[axis] as number) < (b.min[axis] as number) || (b.max[axis] as number) < (a.min[axis] as number));

/**
 * Clashes between `bodies` and `solids` (building elements as `{ elementId, box }`) and among the bodies, deeper than `tolerance`.
 * @invariant deterministic: the sweep order is (min x, id)
 */
export function externalClashes(
  bodies: readonly ExternalBody[],
  solids: ReadonlyArray<{ readonly elementId: string; readonly box: OrientedBox }>,
  tolerance: number,
): ExternalClash[] {
  if (bodies.length === 0) return [];
  const items: Item[] = [
    ...bodies.map((body) => itemOf(body.id, body.group, body.kind, body.connectedTo, body.box)),
    ...solids.map((solid) => itemOf(solid.elementId, solid.elementId, 'building', [], solid.box)),
  ].sort((p, q) => (p.min[0] as number) - (q.min[0] as number) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const found = new Map<string, ExternalClash>();
  for (let i = 0; i < items.length; i++) {
    const first = items[i] as Item;
    for (let j = i + 1; j < items.length && (items[j] as Item).min[0] <= first.max[0]; j++) {
      const second = items[j] as Item;
      if (!(first.external || second.external) || first.id === second.id || first.group === second.group || disjoint(first, second))
        continue;
      if (first.connectedTo.includes(second.group) || second.connectedTo.includes(first.group)) continue;
      const depth = boxOverlap(first.box, second.box);
      if (!(depth > tolerance)) continue;
      const kind = first.zone || second.zone ? 'clearance' : first.envelope || second.envelope ? 'insulation' : 'hard';
      const [a, b] = first.id < second.id ? [first.id, second.id] : [second.id, first.id];
      const key = `${kind}:${a}:${b}`;
      const existing = found.get(key);
      if (existing === undefined || existing.depth < depth) found.set(key, { a, b, kind, depth });
    }
  }
  return [...found.values()].filter((clash) => clash.kind === 'hard' || !found.has(`hard:${clash.a}:${clash.b}`));
}

/**
 * The clashes of the accessory bodies (valve operators) among `bodies` with every other body and every building solid, deeper than `tolerance`.
 * @invariant empty when no body is an accessory (no building boxes are built then)
 */
export function accessoryClashes(
  doc: CadDocument,
  bodies: readonly ExternalBody[],
  tolerance: number,
): Array<ExternalClash & { readonly kind: 'hard' | 'insulation' }> {
  const accessories = new Set(bodies.filter((body) => body.accessoryOf !== undefined).map((body) => body.id));
  if (accessories.size === 0) return [];
  const building = getBuilding(doc);
  const solids = Object.values(building.elements).flatMap((element) =>
    elementBoxes(doc, building, element).map((box) => ({ elementId: element.id, box })),
  );
  return externalClashes(bodies, solids, tolerance).flatMap((clash) =>
    clash.kind !== 'clearance' && (accessories.has(clash.a) || accessories.has(clash.b)) ? [{ ...clash, kind: clash.kind }] : [],
  );
}
