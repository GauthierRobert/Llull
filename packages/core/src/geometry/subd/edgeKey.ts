/** Order-independent key of the cage edge a-b. */
export const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
