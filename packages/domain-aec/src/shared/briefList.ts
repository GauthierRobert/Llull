/**
 * Truncated list text for command summaries.
 * @layer domain-aec
 * @pure
 */

/** The labels of the first `max` items, joined by `separator`; `separator` + "…" follows when there are more. */
export const briefList = <Item>(items: readonly Item[], label: (item: Item) => string, max = 8, separator = ', '): string =>
  `${items.slice(0, max).map(label).join(separator)}${items.length > max ? `${separator}…` : ''}`;
