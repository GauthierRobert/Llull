/**
 * Names and colors for the assembly STEP a kernel writes (`GeometryKernel.exportStepAssembly`): the translator names every product
 * `Open CASCADE STEP translator <ver> <n>` and every NEXT_ASSEMBLY_USAGE_OCCURRENCE by a bare number. The occurrences appear in the
 * order they were given, which carries the part each one uses; products and solids are then renamed through the file's own links.
 * @failure an occurrence count or a link that does not match the plan -> the text is returned untouched (never throws, never corrupts)
 */

import { REPRESENTATION_PATTERN, type StepLabel, addColors, geometryItems, rgbOf, stepString } from './stepLabels';

/** What to stamp on the assembly: one entry per distinct part and one per occurrence (in kernel input order). */
export interface AssemblyStepLabels {
  readonly rootName: string;
  readonly parts: readonly {
    readonly name: string;
    readonly description?: string;
    readonly solids: readonly StepLabel[];
    /** Uses of other parts inside this one (sub-assembly), in kernel input order. */
    readonly occurrences?: readonly NestedOccurrence[];
  }[];
  readonly occurrences: readonly NestedOccurrence[];
}

const NAUO_PATTERN = /#(\d+) = NEXT_ASSEMBLY_USAGE_OCCURRENCE\('[^']*','[^']*','[^']*',#(\d+),#(\d+),\$\);/g;

/** `#id` of the PRODUCT behind a PRODUCT_DEFINITION, or null. */
function productOf(step: string, definition: string): string | null {
  const formation = new RegExp(`#${definition} = PRODUCT_DEFINITION\\('[^']*','[^']*',#(\\d+),#\\d+\\);`).exec(step)?.[1];
  if (formation === undefined) return null;
  return new RegExp(`#${formation} = PRODUCT_DEFINITION_FORMATION\\('[^']*','[^']*',#(\\d+)\\);`).exec(step)?.[1] ?? null;
}

function renameProduct(step: string, product: string, name: string, description: string): string {
  const text = stepString(name);
  return step.replace(new RegExp(`(#${product} = PRODUCT\\()'[^']*',\\s*'[^']*',''`), `$1'${text}','${text}','${stepString(description)}'`);
}

/** The geometry items (solids) of the shape representation of a PRODUCT_DEFINITION, with the representation's context ref. */
function solidsOf(step: string, definition: string): { items: string[]; context: string } | null {
  const shape = new RegExp(`#(\\d+) = PRODUCT_DEFINITION_SHAPE\\('[^']*','[^']*',#${definition}\\);`).exec(step)?.[1];
  if (shape === undefined) return null;
  const representation = new RegExp(`SHAPE_DEFINITION_REPRESENTATION\\(#${shape},#(\\d+)\\)`).exec(step)?.[1];
  if (representation === undefined) return null;
  for (const match of step.matchAll(REPRESENTATION_PATTERN))
    if (match[1] === representation) return { items: geometryItems(step, match[2] ?? ''), context: match[3] ?? '' };
  return null;
}

interface Nauo {
  readonly id: string;
  readonly parent: string;
  readonly child: string;
}

/** Product, solid and color labels of one single-solid product definition; null when its representation is not as expected. */
function stampSolid(
  step: string,
  definition: string,
  solid: StepLabel,
  styled: { items: string[]; rgb: [number, number, number] }[],
): { step: string; context: string } | null {
  const found = solidsOf(step, definition);
  const item = found?.items[0];
  if (found === null || item === undefined || found.items.length !== 1) return null;
  const rgb = rgbOf(solid.color);
  if (rgb !== null) styled.push({ items: [item], rgb });
  const text = step.replace(new RegExp(`(${item} = (?:MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS)\\()''`), `$1'${stepString(solid.name)}'`);
  return { step: text, context: found.context };
}

function renameOccurrence(step: string, nauo: Nauo, name: string): string {
  return step.replace(new RegExp(`(#${nauo.id} = NEXT_ASSEMBLY_USAGE_OCCURRENCE\\()'[^']*','[^']*'`), `$1'${stepString(name)}',''`);
}

/** The occurrences nested inside one part (a sub-assembly), in the order the kernel was given them (after the part's own solids). */
export interface NestedOccurrence {
  readonly name: string;
  readonly part: number;
}

/** Number of NAUOs hanging under a part: none for a lone solid (stored in the part itself), else one per solid plus one per nested use. */
function innerCount(part: AssemblyStepLabels['parts'][number]): number {
  const nested = part.occurrences?.length ?? 0;
  return part.solids.length === 1 && nested === 0 ? 0 : part.solids.length + nested;
}

export function labelStepAssembly(step: string, labels: AssemblyStepLabels): string {
  const all: Nauo[] = [...step.matchAll(NAUO_PATTERN)].map((match) => ({
    id: match[1] ?? '',
    parent: match[2] ?? '',
    child: match[3] ?? '',
  }));
  const children = new Set(all.map((nauo) => nauo.child));
  const roots = [...new Set(all.map((nauo) => nauo.parent))].filter((definition) => !children.has(definition));
  const root = roots[0];
  if (roots.length !== 1 || root === undefined) return step;
  const placed = all.filter((nauo) => nauo.parent === root);
  if (placed.length !== labels.occurrences.length) return step;
  // walk the occurrence tree: every use of a part must resolve to the same product definition, at every depth
  const definitionOfPart = new Map<number, string>();
  const names: { nauo: Nauo; name: string }[] = [];
  const walk = (uses: readonly Nauo[], used: readonly NestedOccurrence[]): boolean => {
    for (const [index, nauo] of uses.entries()) {
      const part = used[index]?.part;
      if (part === undefined || (definitionOfPart.get(part) ?? nauo.child) !== nauo.child) return false;
      names.push({ nauo, name: used[index]?.name ?? '' });
      if (definitionOfPart.has(part)) continue;
      definitionOfPart.set(part, nauo.child);
      const spec = labels.parts[part];
      const nested = spec?.occurrences ?? [];
      if (spec === undefined || nested.length === 0) continue;
      const inner = all.filter((candidate) => candidate.parent === nauo.child);
      if (inner.length !== innerCount(spec)) continue;
      if (!walk(inner.slice(spec.solids.length), nested)) return false;
    }
    return true;
  };
  if (!walk(placed, labels.occurrences)) return step;
  let named = step;
  for (const { nauo, name } of names) named = renameOccurrence(named, nauo, name);
  const rootProduct = productOf(named, root);
  if (rootProduct !== null) named = renameProduct(named, rootProduct, labels.rootName, '');
  const styled: { items: string[]; rgb: [number, number, number] }[] = [];
  let context: string | undefined;
  for (const [partIndex, definition] of definitionOfPart) {
    const part = labels.parts[partIndex];
    const product = productOf(named, definition);
    if (part === undefined || product === null) continue;
    named = renameProduct(named, product, part.name, part.description ?? '');
    const inner = all.filter((nauo) => nauo.parent === definition);
    if (inner.length !== innerCount(part)) continue;
    // one solid stays inside the part's own representation; several are written as one sub-product each (in input order)
    const targets =
      inner.length === 0
        ? [{ definition, solid: part.solids[0] }]
        : inner.slice(0, part.solids.length).map((nauo, k) => ({ definition: nauo.child, solid: part.solids[k], nauo }));
    for (const target of targets) {
      if (target.solid === undefined) continue;
      if ('nauo' in target) {
        named = renameOccurrence(named, target.nauo, target.solid.name);
        const sub = productOf(named, target.definition);
        if (sub !== null) named = renameProduct(named, sub, target.solid.name, part.description ?? '');
      }
      const stamped = stampSolid(named, target.definition, target.solid, styled);
      if (stamped === null) continue;
      named = stamped.step;
      context ??= stamped.context;
    }
  }
  return context === undefined ? named : addColors(named, styled, context);
}
