/**
 * Product tree clean-up before it becomes document structure (aerospace 04 XCH M3): CAx-IF and CAD files wrap one part in assembly shells that
 * carry no geometry of their own (a product holding one identity-placed sub-product, PMI-only or empty representations). Those would import as
 * nested components named `SOLID` / `COMPOUND`; this pass drops the empty products and folds a single-child identity wrapper into its child, so a plain
 * part imports as the part and a real assembly keeps exactly its placed parts.
 * @invariant solids are never dropped, copied or reordered; the product that survives a fold keeps the name of the outer product
 */

import type { ImportedExchange, ImportedOccurrence, ImportedProduct } from '../../geometry/kernelExchange';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const isIdentity = (matrix: readonly number[]): boolean => IDENTITY.every((value, index) => Math.abs((matrix[index] ?? 0) - value) < 1e-9);

type MutableUse = { -readonly [K in keyof ImportedOccurrence]: ImportedOccurrence[K] };

export function simplifyTree(tree: ImportedExchange): ImportedExchange {
  const products: (ImportedProduct | null)[] = tree.products.map((product) => ({ ...product }));
  // products that hold a solid or reach one through a use: a breadth-first walk up the reversed uses (linear, cycle-safe)
  const parentsOf = new Map<number, number[]>();
  for (const use of tree.occurrences) parentsOf.set(use.product, [...(parentsOf.get(use.product) ?? []), use.parent]);
  const contentful = new Set<number>(products.flatMap((product, index) => (product !== null && product.solids.length > 0 ? [index] : [])));
  const frontier = [...contentful];
  for (let next = frontier.pop(); next !== undefined; next = frontier.pop()) {
    for (const parent of parentsOf.get(next) ?? []) {
      if (contentful.has(parent) || products[parent] === undefined) continue;
      contentful.add(parent);
      frontier.push(parent);
    }
  }
  let uses: MutableUse[] = tree.occurrences.filter((use) => contentful.has(use.product)).map((use) => ({ ...use }));
  // fold single-child identity wrappers (outer product with no solids and exactly one use of a child nothing else references)
  const byParent = new Map<number, MutableUse[]>();
  const references = new Map<number, number>();
  for (const use of uses) {
    byParent.set(use.parent, [...(byParent.get(use.parent) ?? []), use]);
    references.set(use.product, (references.get(use.product) ?? 0) + 1);
  }
  const folded = new Set<MutableUse>();
  const pending = [...products.keys()];
  for (let index = pending.pop(); index !== undefined; index = pending.pop()) {
    const outer = products[index];
    if (outer === null || outer === undefined || outer.solids.length > 0) continue;
    const own = byParent.get(index) ?? [];
    const [only] = own;
    if (own.length !== 1 || only === undefined || !isIdentity(only.matrix) || references.get(only.product) !== 1) continue;
    const child = products[only.product];
    if (child === null || child === undefined || only.product === index) continue;
    products[index] = {
      ...outer,
      aliases: [...new Set([...(outer.aliases ?? [outer.name]), ...(child.aliases ?? [child.name])])],
      assembly: child.assembly,
      solids: child.solids,
      layers: [...new Set([...outer.layers, ...child.layers])],
      ...(outer.color === undefined && child.color !== undefined ? { color: child.color } : {}),
      ...(outer.validation === undefined && child.validation !== undefined ? { validation: child.validation } : {}),
      ...(outer.pmi === undefined && child.pmi !== undefined ? { pmi: child.pmi } : {}),
    };
    products[only.product] = null;
    const inherited = byParent.get(only.product) ?? [];
    for (const use of inherited) use.parent = index;
    byParent.set(index, inherited);
    byParent.delete(only.product);
    references.delete(only.product);
    folded.add(only);
    pending.push(index);
  }
  uses = uses.filter((use) => !folded.has(use));
  const live = tree.roots.filter((root) => products[root] !== null && products[root] !== undefined && contentful.has(root));
  const kept = products.flatMap((product, index) =>
    product !== null && (live.includes(index) || uses.some((use) => use.product === index || use.parent === index)) ? [index] : [],
  );
  const renumber = new Map(kept.map((old, index) => [old, index] as const));
  return {
    ...tree,
    products: kept.flatMap((old) => {
      const product = products[old];
      return product === null || product === undefined ? [] : [product];
    }),
    occurrences: uses.flatMap((use) => {
      const parent = renumber.get(use.parent);
      const product = renumber.get(use.product);
      return parent === undefined || product === undefined ? [] : [{ ...use, parent, product }];
    }),
    roots: live.flatMap((root) => {
      const index = renumber.get(root);
      return index === undefined ? [] : [index];
    }),
  };
}
