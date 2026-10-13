/**
 * Utilisation helpers shared by the check rows and summaries.
 * @layer domain-aec
 * @pure
 */

/** The first item of highest utilisation; undefined when there is none. */
export const highestUtilisation = <Item extends { utilisation: number }>(items: readonly Item[]): Item | undefined =>
  items.reduce<Item | undefined>((best, item) => (best === undefined || item.utilisation > best.utilisation ? item : best), undefined);

/** Highest utilisation of the items; 0 when there are none. */
export const maxUtilisation = (items: readonly { utilisation: number }[]): number => Math.max(0, ...items.map((item) => item.utilisation));

/** The items whose utilisation exceeds 1 (failing the check). */
export const failingRows = <Item extends { utilisation: number }>(items: readonly Item[]): Item[] =>
  items.filter((item) => item.utilisation > 1);
