/**
 * Schema-first validation of a plugin's document slice: declare the slice as a zod schema and let `DocumentExtension.validate` return its issues
 * as path-prefixed error strings, instead of hand-writing every `typeof` / `isRecord` check.
 * @invariant pure; never throws (a malformed value is an error list, not an exception); at most `MAX_SLICE_ERRORS` errors per call
 */

import type { z } from '../commands/schema';

/** Far more than a human reads; stops a hostile file with a million bad leaves from building a million-line message. */
const MAX_SLICE_ERRORS = 50;

/** `plant.pid` + `['sheets', 'S1', 'items', 0, 'x']` -> `plant.pid.sheets.S1.items[0].x`. */
function pathOf(root: string, segments: ReadonlyArray<PropertyKey>): string {
  return segments.reduce<string>(
    (path, segment) => (typeof segment === 'number' ? `${path}[${segment}]` : `${path}${path === '' ? '' : '.'}${String(segment)}`),
    root,
  );
}

/**
 * The errors of `value` against `schema`, each `<root>.<path inside the value>: <what is wrong>`; empty when valid.
 * `root` is the dotted location of `value` in the document (`plant.pid`), so errors name a path inside the slice.
 */
export function sliceSchemaErrors(schema: z.ZodType, value: unknown, root: string): string[] {
  const parsed = schema.safeParse(value);
  if (parsed.success) return [];
  return parsed.error.issues.slice(0, MAX_SLICE_ERRORS).map((issue) => `${pathOf(root, issue.path)}: ${issue.message}`);
}
