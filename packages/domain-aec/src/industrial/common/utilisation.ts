/**
 * Utilisation helpers shared by the check rows and summaries.
 * @layer domain-aec
 * @pure
 */

/** The first item of highest utilisation; undefined when there is none. */
export const highestUtilisation = <Item extends { utilisation: number }>(
  items: readonly Item[],
): Item | undefined =>
  items.reduce<Item | undefined>(
    (best, item) => (best === undefined || item.utilisation > best.utilisation ? item : best),
    undefined,
  );

/** The labels of the first 8 items, joined; ", …" follows when there are more. */
export const briefList = <Item>(items: readonly Item[], label: (item: Item) => string): string =>
  `${items.slice(0, 8).map(label).join(', ')}${items.length > 8 ? ', …' : ''}`;
