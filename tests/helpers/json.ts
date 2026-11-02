/** Reading untyped JSON (a data sheet) in tests without `any`: dotted-path access and typed views of arrays / objects. */

export type JsonObject = Record<string, unknown>;

/** The value at a dotted path (`weights.body.emptyKg`, `nozzles.0.mark`), undefined when a step is missing. */
export function at(root: unknown, path: string): unknown {
  return path === ''
    ? root
    : path
        .split('.')
        .reduce<unknown>((node, key) => (node !== null && typeof node === 'object' ? (node as JsonObject)[key] : undefined), root);
}

/** The array at `path` as objects (empty when it is not an array). */
export function rowsAt(root: unknown, path: string): JsonObject[] {
  const value = at(root, path);
  return Array.isArray(value) ? (value as JsonObject[]) : [];
}

export const objectAt = (root: unknown, path: string): JsonObject => (at(root, path) ?? {}) as JsonObject;

export const arrayAt = (root: unknown, path: string): unknown[] => {
  const value = at(root, path);
  return Array.isArray(value) ? value : [];
};

/** The string at `path` (throws when it is not one: a test reading the wrong key fails loudly). */
export function textAt(root: unknown, path: string): string {
  const value = at(root, path);
  if (typeof value !== 'string') throw new Error(`${path} is not a string`);
  return value;
}
