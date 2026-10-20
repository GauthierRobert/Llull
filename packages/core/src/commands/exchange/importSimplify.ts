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

export function simplifyTree(tree: ImportedExchange): ImportedExchange {
  const products: (ImportedProduct | null)[] = tree.products.map((product) => ({ ...product }));
  let uses: ImportedOccurrence[] = tree.occurrences.map((use) => ({ ...use }));
  const hasContent = (index: number, seen: ReadonlySet<number> = new Set()): boolean => {
    const product = products[index];
    if (product === null || product === undefined || seen.has(index)) return false;
    if (product.solids.length > 0) return true;
    return uses.some((use) => use.parent === index && hasContent(use.product, new Set([...seen, index])));
  };
  uses = uses.filter((use) => hasContent(use.product));
  // fold single-child identity wrappers (outer product with no solids and exactly one use of a child nothing else references)
  let folded = true;
  while (folded) {
    folded = false;
    for (const [index, outer] of products.entries()) {
      if (outer === null || outer.solids.length > 0) continue;
      const own = uses.filter((use) => use.parent === index);
      const [only] = own;
      if (own.length !== 1 || only === undefined || !isIdentity(only.matrix)) continue;
      if (uses.filter((use) => use.product === only.product).length !== 1) continue;
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
      uses = uses.filter((use) => use !== only).map((use) => (use.parent === only.product ? { ...use, parent: index } : use));
      folded = true;
    }
  }
  const live = tree.roots.filter((root) => hasContent(root));
  const kept = products.flatMap((product, index) =>
    product !== null && (live.includes(index) || uses.some((use) => use.product === index || use.parent === index)) ? [index] : [],
  );
  const renumber = new Map(kept.map((old, index) => [old, index] as const));
  return {
    ...tree,
    products: kept.map((old) => products[old]!),
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
