/**
 * A small XML reader for untrusted QIF files (M6, 09 PLM threat model): one pass, no recursion, no external resources.
 * @invariant DOCTYPE, ENTITY and processing instructions (other than the XML declaration) are refused, so there is nothing to expand and nothing external to load (no XXE,
 *   no entity blow-up); only the five predefined entities and numeric character references are decoded; size, depth, element count and attribute count are capped and
 *   checked while reading; tokens are matched with anchored, non-nested patterns and text with indexOf from the current position, so the work is proportional to the input (tested on 2 to 5 MB hostile shapes)
 * @failure malformed or over-limit input -> `{ ok: false, code, message }` with the line of the fault; never throws
 */

export interface XmlNode {
  /** Local name (the namespace prefix is dropped; `xmlns*` attributes keep their names so the namespace can be checked). */
  readonly name: string;
  /** The name as written, prefix included (an end tag must repeat it). */
  readonly qname: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
  readonly line: number;
}

export interface XmlLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxElements: number;
  readonly maxAttributes: number;
}

export const QIF_LIMITS: XmlLimits = { maxBytes: 8 * 1024 * 1024, maxDepth: 48, maxElements: 400_000, maxAttributes: 24 };

export type XmlResult =
  | { readonly ok: true; readonly root: XmlNode; readonly elements: number }
  | { readonly ok: false; readonly code: 'PLM_QIF_INVALID' | 'PLM_QIF_LIMIT'; readonly message: string };

class Fault extends Error {
  constructor(
    readonly code: 'PLM_QIF_INVALID' | 'PLM_QIF_LIMIT',
    message: string,
  ) {
    super(message);
  }
}

const NAME = /[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/y;
const ATTRIBUTE = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const TAG_END = /\s*(\/?)>/y;
const REFERENCE = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g;
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

class Reader {
  private readonly stack: XmlNode[] = [];
  private root: XmlNode | null = null;
  private elements = 0;
  private scanned = 0;
  private line = 1;

  constructor(
    private readonly text: string,
    private readonly limits: XmlLimits,
  ) {}

  private invalid(message: string, position: number): never {
    for (; this.scanned < position; this.scanned += 1) if (this.text.charCodeAt(this.scanned) === 10) this.line += 1;
    throw new Fault('PLM_QIF_INVALID', `line ${this.line}: ${message}`);
  }

  private decode(raw: string, position: number): string {
    if (!raw.includes('&')) return raw;
    if (raw.replace(REFERENCE, '').includes('&'))
      this.invalid('only the five predefined entities and numeric references are accepted', position);
    return raw.replace(REFERENCE, (_, body: string) => {
      if (!body.startsWith('#')) return NAMED[body] ?? '';
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      const allowed =
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff);
      if (!allowed) this.invalid('a character reference to a character XML does not allow', position);
      return String.fromCodePoint(code);
    });
  }

  private startTag(at: number): number {
    NAME.lastIndex = at + 1;
    const name = NAME.exec(this.text);
    if (name === null) return this.invalid('bad start tag', at);
    this.elements += 1;
    if (this.elements > this.limits.maxElements) throw new Fault('PLM_QIF_LIMIT', `more than ${this.limits.maxElements} elements`);
    if (this.stack.length >= this.limits.maxDepth) throw new Fault('PLM_QIF_LIMIT', `nesting deeper than ${this.limits.maxDepth}`);
    let position = NAME.lastIndex;
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    for (;;) {
      ATTRIBUTE.lastIndex = position;
      const attribute = ATTRIBUTE.exec(this.text);
      if (attribute === null) break;
      if (Object.keys(attrs).length >= this.limits.maxAttributes)
        throw new Fault('PLM_QIF_LIMIT', `more than ${this.limits.maxAttributes} attributes on <${name[0]}>`);
      const key = attribute[1] ?? '';
      if (Object.hasOwn(attrs, key)) this.invalid(`attribute ${key} is repeated`, position);
      attrs[key] = this.decode(attribute[2] ?? attribute[3] ?? '', position);
      position = ATTRIBUTE.lastIndex;
    }
    TAG_END.lastIndex = position;
    const end = TAG_END.exec(this.text);
    if (end === null) return this.invalid(`bad attribute syntax in <${name[0]}>`, position);
    const node: XmlNode = {
      name: name[0].slice(name[0].indexOf(':') + 1),
      qname: name[0],
      attrs,
      children: [],
      text: '',
      line: this.lineAt(at),
    };
    const parent = this.stack[this.stack.length - 1];
    if (parent !== undefined) parent.children.push(node);
    else if (this.root !== null) this.invalid('more than one root element', at);
    else this.root = node;
    if (end[1] !== '/') this.stack.push(node);
    return TAG_END.lastIndex;
  }

  private lineAt(position: number): number {
    for (; this.scanned < position; this.scanned += 1) if (this.text.charCodeAt(this.scanned) === 10) this.line += 1;
    return this.line;
  }

  private endTag(at: number): number {
    NAME.lastIndex = at + 2;
    const name = NAME.exec(this.text);
    const top = this.stack.pop();
    if (name === null || top === undefined) return this.invalid('bad end tag', at);
    const close = this.text.indexOf('>', NAME.lastIndex);
    if (name[0] !== top.qname || close < 0 || this.text.slice(NAME.lastIndex, close).trim() !== '')
      return this.invalid(`end tag </${name[0]}> does not close <${top.qname}>`, at);
    return close + 1;
  }

  read(): { readonly root: XmlNode; readonly elements: number } {
    const { text } = this;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    if (/^<\?xml[ \t\r\n]/.test(text.slice(i, i + 7))) {
      const end = text.indexOf('?>', i);
      if (end < 0) this.invalid('unterminated XML declaration', i);
      i = end + 2;
    }
    while (i < text.length) {
      if (text[i] !== '<') {
        const next = text.indexOf('<', i);
        const stop = next < 0 ? text.length : next;
        const chunk = text.slice(i, stop);
        const top = this.stack[this.stack.length - 1];
        if (top === undefined) {
          if (chunk.trim() !== '') this.invalid('text outside the root element', i);
        } else top.text += this.decode(chunk, i);
        i = stop;
      } else if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end < 0) this.invalid('unterminated comment', i);
        i = end + 3;
      } else if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i + 9);
        const top = this.stack[this.stack.length - 1];
        if (end < 0 || top === undefined) this.invalid('bad CDATA section', i);
        else top.text += text.slice(i + 9, end);
        i = end + 3;
      } else if (text.startsWith('<!', i)) this.invalid('DOCTYPE and ENTITY declarations are not accepted', i);
      else if (text.startsWith('<?', i)) this.invalid('processing instructions are not accepted', i);
      else i = text.startsWith('</', i) ? this.endTag(i) : this.startTag(i);
    }
    const open = this.stack[this.stack.length - 1];
    if (open !== undefined) this.invalid(`<${open.name}> is never closed`, text.length);
    if (this.root === null) this.invalid('no root element', 0);
    return { root: this.root as unknown as XmlNode, elements: this.elements };
  }
}

/** Parse `text`; the size is checked first (UTF-8 bytes), then the structure while reading. */
export function parseXml(text: string, limits: XmlLimits = QIF_LIMITS): XmlResult {
  if (text.length > limits.maxBytes) return { ok: false, code: 'PLM_QIF_LIMIT', message: `more than ${limits.maxBytes} bytes` };
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > limits.maxBytes)
    return { ok: false, code: 'PLM_QIF_LIMIT', message: `${bytes} bytes exceed the ${limits.maxBytes} byte limit` };
  if (text.includes('\0')) return { ok: false, code: 'PLM_QIF_INVALID', message: 'NUL characters are not allowed' };
  try {
    return { ok: true, ...new Reader(text, limits).read() };
  } catch (error) {
    if (error instanceof Fault) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}
