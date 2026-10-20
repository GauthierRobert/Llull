/**
 * Canonical form of a Part 21 file (aerospace 04 XCH TR-XCH-05, AF-13): the same model always yields the same bytes. OpenCascade numbers the DATA
 * records in the order its (address-hashed) traversal meets them, so two writes of one document in one long-running process can differ in
 * numbering and emission order although the entity graphs are identical. This pass renumbers the records by a depth-first walk from the
 * structurally ordered roots (structure = entity type, strings, numbers and the structure of the referenced records, never an id) and re-emits
 * every record on one line. The header section is kept as is.
 * @invariant pure; the entity graph (types, attributes, reference structure and list orders) is preserved exactly; never throws (unparseable text is returned unchanged)
 * @failure a reference cycle -> the records outside the walk keep their relative order after the others
 */

import { dataSectionStart, parseRecords } from './records';

/** `body` with every `#n` reference (outside quoted strings) replaced by `fn(n)`. */
function mapReferences(body: string, replace: (id: number) => string): string {
  let out = '';
  let at = 0;
  while (at < body.length) {
    const char = body[at] ?? '';
    if (char === "'") {
      let end = at + 1;
      while (end < body.length) {
        if (body[end] === "'") {
          if (body[end + 1] === "'") end += 2;
          else break;
        } else end++;
      }
      out += body.slice(at, end + 1);
      at = end + 1;
    } else if (char === '#' && /\d/.test(body[at + 1] ?? '')) {
      let end = at + 1;
      while (/\d/.test(body[end] ?? '')) end++;
      out += replace(Number(body.slice(at + 1, end)));
      at = end;
    } else {
      out += char;
      at++;
    }
  }
  return out;
}

const referencesIn = (body: string): number[] => {
  const found: number[] = [];
  mapReferences(body, (id) => {
    found.push(id);
    return '';
  });
  return found;
};

/** 53-bit string hash (cyrb53): ordering key only, never compared across files. */
function hashOf(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** The text with its DATA records renumbered and ordered canonically; the input when it has no records or cannot be walked. */
export function canonicalizeStep21(text: string): string {
  try {
    return canonicalize(text);
  } catch {
    return text;
  }
}

function canonicalize(text: string): string {
  const { bodies } = parseRecords(text);
  if (bodies.size === 0) return text;
  const dataStart = dataSectionStart(text);
  const dataEnd = text.lastIndexOf('ENDSEC;');
  if (dataStart < 0 || dataEnd < 0) return text;
  const head = text.slice(0, dataStart).replace(/\s+$/, '');
  const tail = text.slice(dataEnd);
  const children = new Map<number, number[]>();
  const referenced = new Set<number>();
  for (const [id, body] of bodies) {
    const refs = referencesIn(body).filter((ref) => bodies.has(ref));
    children.set(id, refs);
    for (const ref of refs) referenced.add(ref);
  }
  const signature = new Map<number, number>();
  /** Structural hash of a record, children first (explicit stack: no recursion depth limit); a reference cycle reads as 0 at its back edge. */
  const signatureOf = (start: number): number => {
    const visiting = new Set<number>();
    const stack: number[] = [start];
    while (stack.length > 0) {
      const id = stack[stack.length - 1] as number;
      if (signature.has(id)) {
        stack.pop();
        continue;
      }
      if (!visiting.has(id)) {
        visiting.add(id);
        for (const child of children.get(id) ?? []) if (!signature.has(child) && !visiting.has(child)) stack.push(child);
        continue;
      }
      const flat = mapReferences(bodies.get(id) ?? '', (ref) => `#${bodies.has(ref) ? (signature.get(ref) ?? 0) : 'x'}`);
      signature.set(id, hashOf(flat));
      visiting.delete(id);
      stack.pop();
    }
    return signature.get(start) ?? 0;
  };
  const roots = [...bodies.keys()].filter((id) => !referenced.has(id)).sort((a, b) => signatureOf(a) - signatureOf(b) || a - b);
  const order: number[] = [];
  const seen = new Set<number>();
  /** Depth-first pre-order from `start` (explicit stack, children in reference order). */
  const visit = (start: number): void => {
    const stack: number[] = [start];
    while (stack.length > 0) {
      const id = stack.pop() as number;
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      const kids = children.get(id) ?? [];
      for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k] as number);
    }
  };
  for (const root of roots) visit(root);
  for (const id of [...bodies.keys()].sort((a, b) => a - b)) visit(id);
  const renumbered = new Map(order.map((id, index) => [id, index + 1] as const));
  const lines = order.map(
    (id) => `#${renumbered.get(id)} = ${mapReferences(bodies.get(id) ?? '', (ref) => `#${renumbered.get(ref) ?? ref}`)};`,
  );
  return `${head}\n${lines.join('\n')}\n${tail}`;
}
