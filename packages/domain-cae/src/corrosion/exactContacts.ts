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
  readonly kind: ContactPair['kind'] | 'contact';
  readonly source: ContactPair['source'] | 'kernel';
  readonly approximate: boolean;
  readonly materials: ContactPair['materials'];
  readonly stack?: boolean;
}

interface KernelContacts {
  readonly pairs: ItemContact[];
  /** null = no kernel or one without `distance`: every non-box pair stays an AABB `possible`. */
  readonly kernel: string | null;
  /** Possible pairs the kernel confirmed in contact / the exact kernel found separated (dropped) / left possible (cannot tell, mesh-kernel separation, threw). */
  readonly resolved: number;
  readonly separated: number;
  readonly unresolved: number;
  /** Possible pairs past MAX_KERNEL_PAIRS, left possible unexamined. */
  readonly capped: number;
}

/** Kernel budget per check: as check_motion_clearance (2000 kernel pairs); the rest stay `possible` (never dropped). */
const MAX_KERNEL_PAIRS = 2000;
/** Overlap below this fraction of the smaller part's volume is a touch, not an interference (as check_assembly VOLUME_RELATIVE). */
const VOLUME_RELATIVE = 1e-6;

const entityOf = (doc: CadDocument, id: string): Entity | undefined =>
  !id.includes('/') && Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;

/** Volume of a shape through `analyze` (null = the kernel cannot tell). */
function volumeOf(kernel: GeometryKernel, shape: ShapeHandle | null): number | null {
  const analysis = shape === null || kernel.analyze === undefined ? null : kernel.analyze(shape);
  return analysis === null || !analysis.valid ? null : analysis.volume;
}

type Resolution = ItemContact | 'separated' | null;

function resolve(doc: CadDocument, kernel: GeometryKernel, pair: ItemContact, tolerance: number, exact: boolean): Resolution {
  const [a, b] = [entityOf(doc, pair.a), entityOf(doc, pair.b)];
  if (a === undefined || b === undefined || kernel.distance === undefined) return null;
  const [shapeA, shapeB] = [kernel.evaluate(recipeOf(a)), kernel.evaluate(recipeOf(b))];
  if (shapeA === null || shapeB === null) return null;
  const distance = kernel.distance(shapeA, shapeB, tolerance);
  if (distance === null) return null;
  if (!distance.inside && distance.distance > tolerance) return exact ? 'separated' : null;
  const common = volumeOf(kernel, kernel.evaluate({ op: 'boolean', boolean: 'intersect', a: recipeOf(a), b: recipeOf(b) }));
  const [volumeA, volumeB] = [volumeOf(kernel, shapeA), volumeOf(kernel, shapeB)];
  if (common === null || volumeA === null || volumeB === null) return { ...pair, kind: 'contact', source: 'kernel', approximate: true };
  const kind = common > VOLUME_RELATIVE * Math.min(volumeA, volumeB) ? 'interference' : 'contact';
  return { ...pair, kind, source: 'kernel', approximate: !exact };
}

/** One pair through the kernel; a kernel that throws leaves the pair unresolved. */
function guardedResolve(doc: CadDocument, kernel: GeometryKernel, pair: ItemContact, tolerance: number, exact: boolean): Resolution {
  try {
    return resolve(doc, kernel, pair, tolerance, exact);
  } catch {
    return null;
  }
}

/**
 * Resolve the `possible` pairs of top-level solids through `kernel` (`tolerance` in document units); every other pair passes unchanged.
 * @invariant kernel-optional: without a kernel (or `distance`) the pairs come back as given; a pair the kernel cannot evaluate, measure or that
 *   throws stays `possible`, never dropped
 * @invariant only the exact kernel (`occt`) drops a pair, on a measured separation above the tolerance; a mesh kernel's facets can be farther apart
 *   than the tolerance, so a mesh-kernel separation keeps the pair `possible`; a mesh kernel keeps `approximate: true`, as does a contact whose
 *   overlap volume is unknown (no / invalid `analyze`)
 * @invariant at most MAX_KERNEL_PAIRS pairs are examined; the rest stay `possible` and are counted in `capped`
 */
export function kernelContacts(
  doc: CadDocument,
  pairs: readonly ItemContact[],
  tolerance: number,
  kernel: GeometryKernel | null | undefined,
): KernelContacts {
  if (kernel === null || kernel === undefined || kernel.distance === undefined)
    return { pairs: [...pairs], kernel: null, resolved: 0, separated: 0, unresolved: 0, capped: 0 };
  const exact = kernel.name === 'occt';
  const out: ItemContact[] = [];
  let [resolved, separated, unresolved, capped] = [0, 0, 0, 0];
  for (const pair of pairs) {
    if (pair.kind !== 'possible') {
      out.push(pair);
      continue;
    }
    if (resolved + separated + unresolved >= MAX_KERNEL_PAIRS) {
      capped += 1;
      out.push(pair);
      continue;
    }
    const result = guardedResolve(doc, kernel, pair, tolerance, exact);
    if (result === 'separated') separated += 1;
    else if (result === null) {
      unresolved += 1;
      out.push(pair);
    } else {
      resolved += 1;
      out.push(result);
    }
  }
  return { pairs: out, kernel: kernel.name ?? 'anonymous', resolved, separated, unresolved, capped };
}
