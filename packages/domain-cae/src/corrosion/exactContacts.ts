/**
 * Kernel narrow phase of the corrosion check (PHY-13 M4, spec §5.2, COR-b): the AABB `possible` contacts of find_contacts resolved through the
 * injected kernel's existing `distance` query and the recipe `intersect` + `analyze` volume. No new kernel method: the face contact AREA needs the
 * proposed `contactArea` (§3.4), so an exact touch is reported as kind `contact` with no area.
 */

import type { ContactPair } from '@core/geometry/contacts';
import type { GeometryKernel, ShapeHandle } from '@core/geometry/kernel';
import { recipeOf } from '@core/geometry/shapeRecipe';
import type { CadDocument, Entity } from '@core/model/types';

/** A contact as the galvanic item reads it (find_contacts pairs and the kernel-resolved ones). */
export interface ItemContact {
  readonly a: string;
  readonly b: string;
  readonly kind: string;
  readonly source: string;
  readonly approximate: boolean;
  readonly materials: ContactPair['materials'];
  readonly stack?: boolean;
}

export interface KernelContacts {
  readonly pairs: ItemContact[];
  /** null = no kernel or one without `distance`: every non-box pair stays an AABB `possible`. */
  readonly kernel: string | null;
  /** Possible pairs the kernel confirmed in contact / found separated (dropped) / could not resolve (kept as AABB). */
  readonly resolved: number;
  readonly separated: number;
  readonly unresolved: number;
}

const entityOf = (doc: CadDocument, id: string): Entity | undefined =>
  !id.includes('/') && Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;

/** Overlap volume of two shapes through the recipe path (null = the kernel cannot tell). */
function commonVolume(kernel: GeometryKernel, a: Entity, b: Entity): number | null {
  if (kernel.analyze === undefined) return null;
  const common = kernel.evaluate({ op: 'boolean', boolean: 'intersect', a: recipeOf(a), b: recipeOf(b) });
  const analysis = common === null ? null : kernel.analyze(common);
  return analysis === null || !analysis.valid ? null : analysis.volume;
}

type Resolution = ItemContact | 'separated' | null;

function resolve(doc: CadDocument, kernel: GeometryKernel, pair: ItemContact, tolerance: number, exact: boolean): Resolution {
  const [a, b] = [entityOf(doc, pair.a), entityOf(doc, pair.b)];
  if (a === undefined || b === undefined || kernel.distance === undefined) return null;
  const shapes: (ShapeHandle | null)[] = [kernel.evaluate(recipeOf(a)), kernel.evaluate(recipeOf(b))];
  const [shapeA, shapeB] = shapes;
  if (shapeA === null || shapeA === undefined || shapeB === null || shapeB === undefined) return null;
  const distance = kernel.distance(shapeA, shapeB, tolerance);
  if (distance === null) return null;
  if (!distance.inside && distance.distance > tolerance) return 'separated';
  const volume = commonVolume(kernel, a, b);
  const kind = volume !== null && volume > tolerance * tolerance * tolerance ? 'interference' : 'contact';
  return { ...pair, kind, source: 'kernel', approximate: !exact };
}

/**
 * Resolve the `possible` pairs of top-level solids through `kernel` (`tolerance` in document units); every other pair passes unchanged.
 * @invariant kernel-optional: without a kernel (or `distance`) the pairs come back as given; a pair the kernel cannot evaluate stays `possible`,
 *   never dropped; only a measured separation above the tolerance drops a pair; a mesh kernel (any but `occt`) keeps `approximate: true`
 */
export function kernelContacts(
  doc: CadDocument,
  pairs: readonly ItemContact[],
  tolerance: number,
  kernel: GeometryKernel | null | undefined,
): KernelContacts {
  if (kernel === null || kernel === undefined || kernel.distance === undefined)
    return { pairs: [...pairs], kernel: null, resolved: 0, separated: 0, unresolved: 0 };
  const exact = kernel.name === 'occt';
  const out: ItemContact[] = [];
  let [resolved, separated, unresolved] = [0, 0, 0];
  for (const pair of pairs) {
    if (pair.kind !== 'possible') {
      out.push(pair);
      continue;
    }
    const result = resolve(doc, kernel, pair, tolerance, exact);
    if (result === 'separated') separated += 1;
    else if (result === null) {
      unresolved += 1;
      out.push(pair);
    } else {
      resolved += 1;
      out.push(result);
    }
  }
  return { pairs: out, kernel: kernel.name ?? 'anonymous', resolved, separated, unresolved };
}
