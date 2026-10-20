/**
 * The geometric validation properties a STEP file embeds, grouped per product and converted to a target length unit with the file's exact unit
 * factor (aerospace 04 FR-XCH-12), plus the same-kernel self-check that matches them with the values llull computed for the model.
 * @invariant pure; reads only `Step21Summary` (the independent Part 21 reader), never OpenCascade
 */

import type { EmbeddedGvp, GvpCheck, GvpComparison } from '../../model/exchange';
import type { Vec3 } from '../../model/types';
import type { FileGvp, Step21Summary } from '../../lib/step21/summary';
import { type GvpSample, compareGvp, isPlaceholder, worstBand } from './gvpBands';

/** Tolerances of a same-kernel round trip (validation `tolerancePolicy.sameKernelRoundTrip`): only decimal serialisation intervenes. */
export const SAME_KERNEL_POLICY = { greenRel: 1e-9, yellowRel: 1e-6, greenCentroidPerDiag: 1e-9, yellowCentroidMm: 1e-3 } as const;

export interface FileGvpGroup extends GvpSample {
  readonly product: string | null;
  readonly target: EmbeddedGvp['target'];
  readonly placeholder: boolean;
  /** Record type the property is attached to: PRODUCT_DEFINITION_SHAPE = the whole product, SHAPE_ASPECT = one sub-shape (a solid or a sheet). */
  readonly definition: string | null;
}

/**
 * The group that describes the solids of `names` by record linkage, never by value: the only unused sub-shape group (SHAPE_ASPECT, the solid body)
 * of that product that carries a volume, else the property attached to the product itself (PRODUCT_DEFINITION_SHAPE, which some senders extend
 * with their sheet areas), else none. Two candidates that both fit are never told apart by which value is nearer.
 */
export function groupOfProduct(
  groups: readonly FileGvpGroup[],
  names: readonly string[],
  used: ReadonlySet<FileGvpGroup>,
): FileGvpGroup | undefined {
  const candidates = groups.filter((group) => group.product !== null && names.includes(group.product) && !used.has(group));
  const bodies = candidates.filter((group) => group.definition === 'SHAPE_ASPECT' && group.volume !== undefined);
  if (bodies.length === 1) return bodies[0];
  return candidates.find((group) => group.definition === 'PRODUCT_DEFINITION_SHAPE');
}

const isVolume = (item: string): boolean => item.toLowerCase().includes('volume');
const isArea = (item: string): boolean => item.toLowerCase().includes('area');
const isCentre = (item: string): boolean => /cent(re|er|roid)/i.test(item);

function targetOf(group: readonly FileGvp[]): EmbeddedGvp['target'] {
  const independent = group.some((entry) => entry.values.some((value) => value.item.toLowerCase().includes('independent')));
  const solid = group.some((entry) => entry.values.some((value) => typeof value.value === 'number' && isVolume(value.item)));
  return independent && !solid ? 'independent-surface' : 'part';
}

/**
 * One group per target of a `geometric validation property`: volume (volume measure), area (surface / wetted / independent area measure) and
 * centre point, in `mmPerUnit` millimetres. Each group uses the length unit of its own representation context, else the global one; an unknown unit stays unconverted.
 */
export function groupFileGvp(summary: Step21Summary, mmPerUnit: number): FileGvpGroup[] {
  const globalFactor =
    summary.lengthUnit !== null && Number.isFinite(summary.lengthUnit.mmPerUnit) ? summary.lengthUnit.mmPerUnit : mmPerUnit;
  const byTarget = new Map<string, FileGvp[]>();
  for (const entry of summary.geometricValidationProperties) {
    const key = `${entry.target ?? `own-${entry.propertyDefinition}`}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), entry]);
  }
  const groups: FileGvpGroup[] = [];
  for (const entries of byTarget.values()) {
    const values = entries.flatMap((entry) => entry.values);
    // the unit of the representation that carries the values (its own GLOBAL_UNIT_ASSIGNED_CONTEXT), else the file's global one
    const own = entries.find((entry) => entry.lengthUnit !== null && Number.isFinite(entry.lengthUnit.mmPerUnit))?.lengthUnit;
    const length = (own?.mmPerUnit ?? globalFactor) / mmPerUnit;
    const volume = values.find((value) => typeof value.value === 'number' && isVolume(value.item));
    const area = values.find((value) => typeof value.value === 'number' && isArea(value.item));
    const centre = values.find((value) => Array.isArray(value.value) && isCentre(value.item));
    const sample: GvpSample = {
      ...(volume === undefined ? {} : { volume: (volume.value as number) * length ** 3 }),
      ...(area === undefined ? {} : { area: (area.value as number) * length ** 2 }),
      ...(centre === undefined ? {} : { centroid: (centre.value as Vec3).map((component) => component * length) as unknown as Vec3 }),
    };
    groups.push({
      ...sample,
      product: entries[0]?.product ?? null,
      target: targetOf(entries),
      placeholder: isPlaceholder(sample),
      definition: entries[0]?.definitionTarget ?? null,
    });
  }
  return groups;
}

/** The embedded record of `groups` as stored in the document (`ImportProvenance.embeddedGvp`). */
export const embeddedOf = (group: FileGvpGroup): EmbeddedGvp => ({
  target: group.target,
  ...(group.volume === undefined ? {} : { volume: group.volume }),
  ...(group.area === undefined ? {} : { area: group.area }),
  ...(group.centroid === undefined ? {} : { centroid: group.centroid }),
  placeholder: group.placeholder,
});

/** What llull computed for one written product (or the root assembly). */
export interface ExpectedGvp extends GvpSample {
  readonly name: string;
  readonly assembly: boolean;
}

export interface SelfCheck extends GvpCheck {
  /** Products the file carries no validation property for (named). */
  readonly missing: readonly string[];
  readonly products: number;
}

/**
 * Same-kernel self-check (TR-XCH-06): every expected product must have a group of the same name in the file whose values agree within the
 * same-kernel policy; among same-named groups the closest volume is taken. A missing group is `missing` and turns the band red.
 */
export function selfCheckGvp(
  expected: readonly ExpectedGvp[],
  groups: readonly FileGvpGroup[],
  diagonalOf: (name: string) => number,
): SelfCheck {
  const used = new Set<FileGvpGroup>();
  const comparisons: GvpComparison[] = [];
  const missing: string[] = [];
  for (const want of expected) {
    const best = groupOfProduct(groups, [want.name], used);
    if (best === undefined) {
      missing.push(want.name);
      continue;
    }
    used.add(best);
    comparisons.push(...compareGvp(best, want, diagonalOf(want.name), 1, SAME_KERNEL_POLICY).comparisons);
  }
  const band = missing.length > 0 ? 'red' : worstBand(comparisons.map((entry) => entry.band));
  return { band, comparisons, policy: SAME_KERNEL_POLICY, missing, products: expected.length };
}
