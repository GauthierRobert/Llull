/**
 * ISO 10303-21 record reader (XCH 04 TR-XCH-18): one pass over the DATA section, independent of OpenCascade. A record is `#id = BODY;`;
 * strings use '' for a quote, `/* ... *\/` comments are dropped, whitespace outside strings collapses to one space.
 * @invariant pure; O(n) in the text; never throws (garbage yields an empty map)
 */

export interface Step21Records {
  readonly header: string;
  readonly bodies: ReadonlyMap<number, string>;
}

const HEADER_END = /ENDSEC\s*;/;

function dataSectionStart(text: string): number {
  const match = /(?:^|\n|;)\s*DATA\s*;/.exec(text);
  return match === null ? -1 : match.index + match[0].length;
}

/** Records of a Part 21 text. Without a DATA section the whole text is scanned (a record fragment). */
export function parseRecords(text: string): Step21Records {
  const start = dataSectionStart(text);
  const headerText = start < 0 ? '' : text.slice(0, start);
  const header = HEADER_END.test(headerText) ? headerText : '';
  const bodies = new Map<number, string>();
  const end = text.length;
  let position = start < 0 ? 0 : start;
  while (position < end) {
    const hash = text.indexOf('#', position);
    if (hash < 0) break;
    let cursor = hash + 1;
    let digits = '';
    while (cursor < end && text.charCodeAt(cursor) >= 48 && text.charCodeAt(cursor) <= 57) digits += text[cursor++];
    while (cursor < end && /\s/.test(text[cursor] ?? '')) cursor++;
    if (digits === '' || text[cursor] !== '=') {
      position = hash + 1;
      continue;
    }
    cursor++;
    let body = '';
    let inString = false;
    let pendingSpace = false;
    let closed = false;
    while (cursor < end) {
      const char = text[cursor] ?? '';
      if (inString) {
        body += char;
        if (char === "'") {
          if (text[cursor + 1] === "'") {
            body += "'";
            cursor++;
          } else inString = false;
        }
      } else if (char === "'") {
        if (pendingSpace && body !== '') body += ' ';
        pendingSpace = false;
        inString = true;
        body += char;
      } else if (char === '/' && text[cursor + 1] === '*') {
        const close = text.indexOf('*/', cursor + 2);
        cursor = close < 0 ? end : close + 1;
        pendingSpace = true;
      } else if (char === ';') {
        closed = true;
        cursor++;
        break;
      } else if (/\s/.test(char)) pendingSpace = true;
      else {
        if (pendingSpace && body !== '') body += ' ';
        pendingSpace = false;
        body += char;
      }
      cursor++;
    }
    if (closed) bodies.set(Number(digits), body.trim());
    position = cursor;
  }
  return { header, bodies };
}

/** Entity type of a record body (`ADVANCED_FACE(...)`), or `(complex)` for an external-mapping instance. */
export function entityName(body: string): string {
  const match = /^([A-Z0-9_]+)\s*\(/.exec(body);
  return match?.[1] ?? '(complex)';
}

/** Every quoted string of a body, with the '' escape undone. */
export function stringsOf(body: string): string[] {
  return [...body.matchAll(/'((?:[^']|'')*)'/g)].map((match) => (match[1] ?? '').replaceAll("''", "'"));
}

/** The `#n` references of a body, in order. */
export function referencesOf(body: string): number[] {
  return [...body.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}
