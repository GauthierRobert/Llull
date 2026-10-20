/**
 * Decoding of the escapes of an ISO 10303-21 string (the text between the quotes, '' already undone by `stringsOf`): `\\`, `\X\hh` (ISO 8859-1), `\S\c`
 * (high-bit character), `\X2\hhhh..\X0\` (UTF-16 units) and `\X4\hhhhhhhh..\X0\` (code points), read left to right so an escaped backslash never starts an escape.
 * @invariant pure; a damaged escape is kept literally; never throws
 */

const HEX = /^[0-9A-Fa-f]+$/;

/** Decodes a run of `width`-digit units that ends at the next `\X0\`; returns the text and the index after the terminator, or null. */
function decodeRun(raw: string, from: number, width: 4 | 8): { text: string; next: number } | null {
  const end = raw.indexOf('\\X0\\', from);
  if (end < 0) return null;
  const digits = raw.slice(from, end);
  if (digits.length === 0 || digits.length % width !== 0 || !HEX.test(digits)) return null;
  let text = '';
  for (let at = 0; at < digits.length; at += width) {
    const code = parseInt(digits.slice(at, at + width), 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff && width === 8)) return null;
    text += String.fromCodePoint(code);
  }
  return { text, next: end + 4 };
}

export function unescapeStep(raw: string): string {
  let out = '';
  let at = 0;
  while (at < raw.length) {
    const char = raw[at] as string;
    if (char !== '\\') {
      out += char;
      at++;
    } else if (raw[at + 1] === '\\') {
      out += '\\';
      at += 2;
    } else if (raw.startsWith('\\X2\\', at) || raw.startsWith('\\X4\\', at)) {
      const run = decodeRun(raw, at + 4, raw[at + 2] === '2' ? 4 : 8);
      if (run === null) {
        out += char;
        at++;
      } else {
        out += run.text;
        at = run.next;
      }
    } else if (raw.startsWith('\\X\\', at) && raw.length >= at + 5 && HEX.test(raw.slice(at + 3, at + 5))) {
      out += String.fromCharCode(parseInt(raw.slice(at + 3, at + 5), 16));
      at += 5;
    } else if (raw.startsWith('\\S\\', at) && raw.length > at + 3) {
      out += String.fromCharCode((raw.charCodeAt(at + 3) + 128) & 0xff);
      at += 4;
    } else {
      out += char;
      at++;
    }
  }
  return out;
}
