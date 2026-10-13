export function orderedValues<T>(order: ReadonlyArray<string>, record: Readonly<Record<string, T | undefined>>): T[] {
  return order.flatMap((id) => {
    const value = record[id];
    return value === undefined ? [] : [value];
  });
}
