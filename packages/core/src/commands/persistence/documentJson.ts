/**
 * `JSON.stringify` of a document, byte for byte, built from the text of each entity and each feature step remembered by object identity.
 * A pure command shares every untouched entity and step with the previous document (L3), so serializing the next document (autosave after
 * each edit, File > Save) costs what changed plus a concatenation, instead of printing every number of every mesh again.
 */

const textByPart = new WeakMap<object, string>();

function partJson(part: unknown): string | undefined {
  if (part === null || typeof part !== 'object') return JSON.stringify(part);
  const known = textByPart.get(part);
  if (known !== undefined) return known;
  // A value with its own toJSON may print as nothing (undefined): never remembered, the caller decides what an absent text means.
  const text = JSON.stringify(part) as string | undefined;
  if (text !== undefined) textByPart.set(part, text);
  return text;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { toJSON?: unknown }).toJSON !== 'function';

/** A record of parts (`entities`): `{"id":<part>,...}` in `Object.keys` order, members that print as nothing left out. */
function recordOfParts(record: Record<string, unknown>): string {
  const members: string[] = [];
  for (const key of Object.keys(record)) {
    const text = partJson(record[key]);
    if (text !== undefined) members.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${members.join(',')}}`;
}

/** A list of parts (`featureHistory`): `[<part>,...]`, an element that prints as nothing written `null`. */
function listOfParts(list: readonly unknown[]): string {
  const elements: string[] = [];
  for (let index = 0; index < list.length; index += 1) elements.push(partJson(list[index]) ?? 'null');
  return `[${elements.join(',')}]`;
}

/**
 * @invariant equals `JSON.stringify(document)` for any value JSON.stringify accepts
 * @param document a document record (any other value is passed to JSON.stringify)
 */
export function documentJson(document: unknown): string {
  if (!isPlainRecord(document)) return JSON.stringify(document);
  const members: string[] = [];
  for (const key of Object.keys(document)) {
    const value = document[key];
    const text =
      key === 'entities' && isPlainRecord(value)
        ? recordOfParts(value)
        : key === 'featureHistory' && Array.isArray(value)
          ? listOfParts(value)
          : (JSON.stringify(value) as string | undefined);
    if (text !== undefined) members.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${members.join(',')}}`;
}
