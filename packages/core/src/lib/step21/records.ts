/**
 * ISO 10303-21 record reader (XCH 04 TR-XCH-18): one pass over the DATA section, independent of OpenCascade. A record is `#id = BODY;`;
 * strings use '' for a quote, `/* ... *\/` comments are dropped, whitespace outside strings collapses to one space.
 * @invariant pure; O(n) in the text; never throws (garbage yields an empty map)
 */

export interface Step21Records {
  readonly header: string;
  readonly bodies: ReadonlyMap<number, string>;
}

const HEADER_END = /ENDSEC\s{0,1024};/;

const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13;

/** Index just after the `DATA;` keyword that opens the data section (at the start of a line or after a `;`), or -1. One pass, no backtracking. */
export function dataSectionStart(text: string): number {
  let from = 0;
  for (;;) {
    const at = text.indexOf('DATA', from);
    if (at < 0) return -1;
    from = at + 4;
    let after = at + 4;
    while (after < text.length && isSpace(text.charCodeAt(after))) after++;
    if (text[after] !== ';') continue;
    let before = at - 1;
    let newline = false;
    while (before >= 0 && isSpace(text.charCodeAt(before))) {
      if (text.charCodeAt(before) === 10) newline = true;
      before--;
    }
    if (before < 0 || newline || text[before] === ';') return after + 1;
  }
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
  const match = /^([A-Z0-9_]{1,128})\s{0,64}\(/.exec(body);
  return match?.[1] ?? '(complex)';
}

/**
 * The entity types a record is made of: its own name, or for a complex record `( A() B(...) )` the names directly inside the outer parentheses.
 * Strings and nested arguments are skipped, so a name inside an attribute never counts. Linear time; no backtracking.
 */
export function leadingNames(body: string): string[] {
  const names: string[] = [];
  const target = body.startsWith('(') ? 1 : 0;
  let depth = 0;
  let inString = false;
  let word = '';
  let spaced = false;
  for (let at = 0; at < body.length; at++) {
    const char = body.charCodeAt(at);
    if (inString) {
      if (char === 39) inString = false;
      continue;
    }
    if (char === 39) {
      inString = true;
      word = '';
      continue;
    }
    const isWord = (char >= 65 && char <= 90) || (char >= 48 && char <= 57) || char === 95;
    if (isWord) {
      if (spaced) word = '';
      spaced = false;
      if (word.length < 128) word += body[at];
      continue;
    }
    if (char === 32) {
      spaced = true;
      continue;
    }
    if (char === 40) {
      if (word !== '' && depth === target && word.charCodeAt(0) >= 65 && word.charCodeAt(0) <= 90) names.push(word);
      depth++;
    } else if (char === 41) depth--;
    word = '';
    spaced = false;
  }
  return names;
}

/** Every quoted string of a body, with the '' escape undone. */
export function stringsOf(body: string): string[] {
  const strings: string[] = [];
  let at = 0;
  while (at < body.length) {
    const open = body.indexOf("'", at);
    if (open < 0) break;
    let text = '';
    let cursor = open + 1;
    let closed = false;
    while (cursor < body.length) {
      const quote = body.indexOf("'", cursor);
      if (quote < 0) break;
      text += body.slice(cursor, quote);
      if (body[quote + 1] === "'") {
        text += "'";
        cursor = quote + 2;
      } else {
        closed = true;
        cursor = quote + 1;
        break;
      }
    }
    if (!closed) break;
    strings.push(text);
    at = cursor;
  }
  return strings;
}

/** The `#n` references of a body, in order. */
export function referencesOf(body: string): number[] {
  return [...body.matchAll(/#(\d{1,16})/g)].map((match) => Number(match[1]));
}
