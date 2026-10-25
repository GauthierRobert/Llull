/**
 * Pure, DOM-free XML 1.0 reader with namespaces, for untrusted text (DEXPI / Proteus, plant 04 PID). Never throws: `readXml` returns the tree or a
 * coded error with line / column (1-based, UTF-16 units; a lone CR or CRLF is one line break).
 *
 * Safety: DOCTYPE / DTDs are refused (`XML_DTD_FORBIDDEN`), so no external entity is ever resolved and no entity can expand (no XXE, no billion laughs);
 * only the five predefined entities and numeric character references are decoded (output never longer than input). Size, nesting depth, element count,
 * attributes per element and namespace declarations are bounded. One iterative pass; namespace scopes are push/pop stacks (linear time and memory);
 * the few regexes are linear (no nested quantifiers) and no recursion is used while reading, so no stack overflow.
 *
 * Tree: elements keep qualified name, prefix, local name, resolved namespace, attributes (namespace declarations included, namespace
 * `XMLNS_NAMESPACE`) and children (elements and text; CDATA is merged into text; comments and processing instructions are dropped). Whitespace-only text
 * between child elements is dropped; an element with text only keeps it verbatim. Line ends are normalised to LF; literal tab / LF in attribute values become spaces.
 */

export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

type XmlErrorCode =
  | 'XML_EMPTY'
  | 'XML_TOO_LARGE'
  | 'XML_TOO_DEEP'
  | 'XML_TOO_MANY_ELEMENTS'
  | 'XML_TOO_MANY_ATTRIBUTES'
  | 'XML_TOO_MANY_NAMESPACES'
  | 'XML_SYNTAX'
  | 'XML_DTD_FORBIDDEN'
  | 'XML_ENTITY_UNDEFINED'
  | 'XML_CHAR_INVALID'
  | 'XML_MISMATCHED_TAG'
  | 'XML_UNCLOSED'
  | 'XML_DUPLICATE_ATTRIBUTE'
  | 'XML_NAMESPACE_UNBOUND'
  | 'XML_TRAILING_CONTENT';

export interface XmlError {
  readonly code: XmlErrorCode;
  readonly message: string;
  readonly line: number;
  readonly column: number;
  /** Zero-based offset into the text after the byte-order mark was removed. */
  readonly offset: number;
}

interface XmlAttribute {
  /** Qualified name as written (`xsi:schemaLocation`). */
  readonly name: string;
  readonly prefix: string;
  readonly local: string;
  /** Namespace URI; null for an unprefixed attribute (the default namespace does not apply to attributes). */
  readonly namespace: string | null;
  readonly value: string;
}

interface XmlText {
  readonly type: 'text';
  readonly value: string;
}

export interface XmlElement {
  readonly type: 'element';
  readonly name: string;
  readonly prefix: string;
  readonly local: string;
  readonly namespace: string | null;
  readonly attributes: readonly XmlAttribute[];
  readonly children: readonly XmlNode[];
  readonly line: number;
  readonly column: number;
}

type XmlNode = XmlElement | XmlText;

interface XmlDeclaration {
  readonly version: string;
  readonly encoding?: string;
  readonly standalone?: 'yes' | 'no';
}

export type XmlReadResult =
  | { readonly ok: true; readonly root: XmlElement; readonly declaration?: XmlDeclaration }
  | { readonly ok: false; readonly error: XmlError };

export interface XmlReadLimits {
  /** Text length in UTF-16 units (default 50 000 000). */
  readonly maxChars?: number;
  /** Element nesting depth (default 256). */
  readonly maxDepth?: number;
  /** Total elements (default 5 000 000). */
  readonly maxElements?: number;
  /** Attributes on one element (default 1024). */
  readonly maxAttributes?: number;
  /** Namespace declarations (xmlns, xmlns:p) in the whole document (default 100 000). */
  readonly maxNamespaceDeclarations?: number;
}

const XML_DEFAULT_LIMITS = {
  maxChars: 50_000_000,
  maxDepth: 256,
  maxElements: 5_000_000,
  maxAttributes: 1024,
  maxNamespaceDeclarations: 100_000,
} as const;

const MAX_NAME_LENGTH = 1024;
const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };
const CHAR_REF = /^#(?:x([0-9A-Fa-f]{1,8})|([0-9]{1,9}))$/;
/** XML 1.0 Char excludes C0 controls other than TAB, LF, CR, and U+FFFE / U+FFFF. */
const isBadControl = (code: number): boolean =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff;
const DECL_PAIR = /\s*([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

class XmlFailure {
  constructor(
    readonly code: XmlErrorCode,
    readonly message: string,
    readonly offset: number,
  ) {}
}

const NOT_SPACE = /[^ \t\r\n]/;
const hasContent = (value: string): boolean => NOT_SPACE.test(value);
const isSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

function isNameStart(code: number): boolean {
  return (
    code === 0x3a ||
    code === 0x5f ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0xc0 && code <= 0xd6) ||
    (code >= 0xd8 && code <= 0xf6) ||
    (code >= 0xf8 && code <= 0x2ff) ||
    (code >= 0x370 && code <= 0x37d) ||
    (code >= 0x37f && code <= 0x1fff) ||
    (code >= 0x200c && code <= 0x200d) ||
    (code >= 0x2070 && code <= 0x218f) ||
    (code >= 0x2c00 && code <= 0x2fef) ||
    (code >= 0x3001 && code <= 0xd7ff) ||
    (code >= 0xf900 && code <= 0xfdcf) ||
    (code >= 0xfdf0 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0xeffff)
  );
}

const isNameChar = (code: number): boolean =>
  isNameStart(code) ||
  code === 0x2d ||
  code === 0x2e ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0xb7 ||
  (code >= 0x300 && code <= 0x36f) ||
  (code >= 0x203f && code <= 0x2040);

const isXmlChar = (code: number): boolean =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

interface MutableElement {
  type: 'element';
  name: string;
  prefix: string;
  local: string;
  namespace: string | null;
  attributes: XmlAttribute[];
  children: XmlNode[];
  line: number;
  column: number;
}

/** Normalised line ends (CRLF and lone CR become LF). */
const lineEnds = (value: string): string => (value.includes('\r') ? value.replace(/\r\n?/g, '\n') : value);

/** Attribute-value normalisation of a literal run: line ends, then tab and LF become spaces. */
const attributeRun = (run: string): string => lineEnds(run).replace(/[\t\n]/g, ' ');

/** Reads `source` as an XML document. Never throws. */
export function readXml(source: string, limits: XmlReadLimits = {}): XmlReadResult {
  const maxChars = limits.maxChars ?? XML_DEFAULT_LIMITS.maxChars;
  const maxDepth = limits.maxDepth ?? XML_DEFAULT_LIMITS.maxDepth;
  const maxElements = limits.maxElements ?? XML_DEFAULT_LIMITS.maxElements;
  const maxAttributes = limits.maxAttributes ?? XML_DEFAULT_LIMITS.maxAttributes;
  const maxNamespaceDeclarations = limits.maxNamespaceDeclarations ?? XML_DEFAULT_LIMITS.maxNamespaceDeclarations;
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const length = text.length;

  let lineCursor = { offset: 0, line: 1, lineStart: 0 };
  const locate = (offset: number): { line: number; column: number } => {
    if (offset < lineCursor.offset) lineCursor = { offset: 0, line: 1, lineStart: 0 };
    let { line, lineStart } = lineCursor;
    for (let at = lineCursor.offset; at < offset && at < length; at++) {
      const code = text.charCodeAt(at);
      if (code === 0x0a || (code === 0x0d && text.charCodeAt(at + 1) !== 0x0a)) {
        line++;
        lineStart = at + 1;
      }
    }
    lineCursor = { offset: Math.min(offset, length), line, lineStart };
    return { line, column: offset - lineStart + 1 };
  };
  function fail(code: XmlErrorCode, message: string, offset: number): never {
    throw new XmlFailure(code, message, offset);
  }

  /** Decodes the references of `raw` (error offsets are raw offsets); `literal` normalises the text between references, never a decoded character. */
  const decodeRefs = (raw: string, offset: number, literal: (run: string) => string): string => {
    let amp = raw.indexOf('&');
    if (amp < 0) return literal(raw);
    let out = '';
    let from = 0;
    while (amp >= 0) {
      out += literal(raw.slice(from, amp));
      const semicolon = raw.indexOf(';', amp + 1);
      if (semicolon < 0 || semicolon - amp > 12) fail('XML_SYNTAX', 'unterminated entity or character reference', offset + amp);
      const name = raw.slice(amp + 1, semicolon);
      const predefined = Object.hasOwn(PREDEFINED, name) ? PREDEFINED[name] : undefined;
      if (predefined !== undefined) out += predefined;
      else if (name.startsWith('#')) {
        const match = CHAR_REF.exec(name);
        const code = match ? (match[1] !== undefined ? parseInt(match[1], 16) : parseInt(match[2] ?? '', 10)) : NaN;
        if (!isXmlChar(code)) fail('XML_CHAR_INVALID', `character reference &${name}; is not a valid XML character`, offset + amp);
        out += String.fromCodePoint(code);
      } else
        fail(
          'XML_ENTITY_UNDEFINED',
          `entity &${name}; is not defined (only lt, gt, amp, apos, quot and numeric references are)`,
          offset + amp,
        );
      from = semicolon + 1;
      amp = raw.indexOf('&', from);
    }
    return out + literal(raw.slice(from));
  };

  const checkChars = (raw: string, offset: number, what: string): void => {
    for (let index = 0; index < raw.length; index++) {
      const code = raw.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = raw.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          index++;
          continue;
        }
      }
      if (isBadControl(code) || (code >= 0xd800 && code <= 0xdfff))
        fail(
          'XML_CHAR_INVALID',
          `${what} contains the invalid character U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
          offset + index,
        );
    }
  };

  const readName = (at: number): number => {
    const first = text.codePointAt(at) ?? -1;
    if (!isNameStart(first)) return at;
    let end = at + (first > 0xffff ? 2 : 1);
    while (end < length) {
      const code = text.codePointAt(end) ?? -1;
      if (!isNameChar(code)) break;
      end += code > 0xffff ? 2 : 1;
      if (end - at > MAX_NAME_LENGTH) fail('XML_SYNTAX', `a name is longer than ${MAX_NAME_LENGTH} characters`, at);
    }
    return end;
  };

  const skipSpace = (at: number): number => {
    while (at < length && isSpace(text.charCodeAt(at))) at++;
    return at;
  };

  const splitName = (name: string, offset: number): { prefix: string; local: string } => {
    const colon = name.indexOf(':');
    if (colon < 0) return { prefix: '', local: name };
    if (colon === 0 || colon === name.length - 1 || name.indexOf(':', colon + 1) >= 0)
      fail('XML_SYNTAX', `"${name}" is not a valid qualified name`, offset);
    return { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
  };

  const readDeclaration = (body: string, offset: number): XmlDeclaration => {
    const values: Record<string, string> = {};
    DECL_PAIR.lastIndex = 0;
    let consumed = 0;
    for (let match = DECL_PAIR.exec(body); match; match = DECL_PAIR.exec(body)) {
      values[match[1] ?? ''] = match[2] ?? match[3] ?? '';
      consumed = DECL_PAIR.lastIndex;
    }
    if (body.slice(consumed).trim() !== '') fail('XML_SYNTAX', 'malformed XML declaration', offset + consumed);
    const version = values['version'];
    if (version === undefined || !/^1\.[0-9]+$/.test(version)) fail('XML_SYNTAX', 'the XML declaration needs version="1.x"', offset);
    const standalone = values['standalone'];
    if (standalone !== undefined && standalone !== 'yes' && standalone !== 'no')
      fail('XML_SYNTAX', 'standalone must be "yes" or "no"', offset);
    const encoding = values['encoding'];
    return {
      version: version ?? '1.0',
      ...(encoding !== undefined ? { encoding } : {}),
      ...(standalone !== undefined ? { standalone: standalone as 'yes' | 'no' } : {}),
    };
  };

  const parse = (): { root: XmlElement; declaration?: XmlDeclaration } => {
    if (length > maxChars) fail('XML_TOO_LARGE', `text is ${length} characters, over the limit of ${maxChars}`, 0);
    let declaration: XmlDeclaration | undefined;
    let at = 0;
    if (text.startsWith('<?xml') && isSpace(text.charCodeAt(5))) {
      const end = text.indexOf('?>', 5);
      if (end < 0) fail('XML_UNCLOSED', 'the XML declaration is not closed with ?>', 0);
      declaration = readDeclaration(text.slice(5, end), 5);
      at = end + 2;
    }
    /** prefix -> stack of bound URIs (innermost last); '' is the default namespace, an empty URI undeclares it. */
    const bindings = new Map<string, string[]>([['xml', [XML_NAMESPACE]]]);
    /** Per open element, the prefixes it declared (undone when it closes). */
    const declaredStack: string[][] = [];
    let declarations = 0;
    /** Undoes the bindings an element declared (innermost first is not needed: each prefix pops its own stack). */
    const popBindings = (declared: readonly string[]): void => {
      for (const prefix of declared) {
        const uris = bindings.get(prefix);
        if (uris && uris.length > 1) uris.pop();
        else bindings.delete(prefix);
      }
    };
    const stack: MutableElement[] = [];
    let root: MutableElement | undefined;
    let elements = 0;
    let pendingText = '';

    const flushText = (): void => {
      const top = stack[stack.length - 1];
      if (pendingText !== '' && top) top.children.push({ type: 'text', value: pendingText });
      pendingText = '';
    };
    const closeElement = (element: MutableElement): void => {
      if (element.children.some((child) => child.type === 'element'))
        element.children = element.children.filter((child) => child.type === 'element' || hasContent(child.value));
    };

    const readStartTag = (start: number): number => {
      const nameEnd = readName(start + 1);
      if (nameEnd === start + 1) fail('XML_SYNTAX', 'a tag name is expected after <', start);
      const name = text.slice(start + 1, nameEnd);
      const qualified = splitName(name, start + 1);
      if (stack.length >= maxDepth) fail('XML_TOO_DEEP', `elements are nested deeper than ${maxDepth}`, start);
      if (++elements > maxElements) fail('XML_TOO_MANY_ELEMENTS', `more than ${maxElements} elements`, start);
      const raw: Array<{ name: string; prefix: string; local: string; value: string; offset: number }> = [];
      let cursor = nameEnd;
      let selfClosing = false;
      for (;;) {
        const afterSpace = skipSpace(cursor);
        const code = text.charCodeAt(afterSpace);
        if (afterSpace >= length) fail('XML_UNCLOSED', `the start tag <${name}> is not closed`, start);
        if (code === 0x3e) {
          cursor = afterSpace + 1;
          break;
        }
        if (code === 0x2f) {
          if (text.charCodeAt(afterSpace + 1) !== 0x3e) fail('XML_SYNTAX', 'a / in a tag must be followed by >', afterSpace);
          selfClosing = true;
          cursor = afterSpace + 2;
          break;
        }
        if (afterSpace === cursor) fail('XML_SYNTAX', 'attributes must be separated by white space', afterSpace);
        const attrEnd = readName(afterSpace);
        if (attrEnd === afterSpace) fail('XML_SYNTAX', 'an attribute name is expected', afterSpace);
        const attrName = text.slice(afterSpace, attrEnd);
        const split = splitName(attrName, afterSpace);
        const eq = skipSpace(attrEnd);
        if (text.charCodeAt(eq) !== 0x3d) fail('XML_SYNTAX', `attribute ${attrName} needs =`, eq);
        const quoteAt = skipSpace(eq + 1);
        const quote = text.charCodeAt(quoteAt);
        if (quote !== 0x22 && quote !== 0x27) fail('XML_SYNTAX', `attribute ${attrName} needs a quoted value`, quoteAt);
        const close = text.indexOf(quote === 0x22 ? '"' : "'", quoteAt + 1);
        if (close < 0) fail('XML_UNCLOSED', `the value of attribute ${attrName} is not closed`, quoteAt);
        const rawValue = text.slice(quoteAt + 1, close);
        if (rawValue.includes('<')) fail('XML_SYNTAX', `attribute ${attrName} contains <`, quoteAt + 1 + rawValue.indexOf('<'));
        checkChars(rawValue, quoteAt + 1, `attribute ${attrName}`);
        if (raw.length >= maxAttributes) fail('XML_TOO_MANY_ATTRIBUTES', `more than ${maxAttributes} attributes on <${name}>`, afterSpace);
        raw.push({ name: attrName, ...split, value: decodeRefs(rawValue, quoteAt + 1, attributeRun), offset: afterSpace });
        cursor = close + 1;
      }

      const declared: string[] = [];
      for (const attr of raw) {
        const declaresDefault = attr.name === 'xmlns';
        if (!declaresDefault && attr.prefix !== 'xmlns') continue;
        const prefix = declaresDefault ? '' : attr.local;
        if (prefix === 'xmlns' || (prefix === 'xml' && attr.value !== XML_NAMESPACE))
          fail('XML_SYNTAX', `the prefix ${prefix} cannot be declared`, attr.offset);
        if (attr.value === XML_NAMESPACE && prefix !== 'xml')
          fail('XML_SYNTAX', 'the XML namespace can only be bound to the prefix xml', attr.offset);
        if (attr.value === XMLNS_NAMESPACE) fail('XML_SYNTAX', 'the xmlns namespace cannot be bound', attr.offset);
        if (attr.value === '' && !declaresDefault) fail('XML_SYNTAX', `xmlns:${prefix} cannot be bound to an empty namespace`, attr.offset);
        if (++declarations > maxNamespaceDeclarations)
          fail('XML_TOO_MANY_NAMESPACES', `more than ${maxNamespaceDeclarations} namespace declarations`, attr.offset);
        const uris = bindings.get(prefix);
        if (uris) uris.push(attr.value);
        else bindings.set(prefix, [attr.value]);
        declared.push(prefix);
      }
      const resolve = (prefix: string, offset: number): string | null => {
        const uri = bindings.get(prefix)?.at(-1);
        if (prefix === '') return uri === undefined || uri === '' ? null : uri;
        if (uri === undefined) fail('XML_NAMESPACE_UNBOUND', `the namespace prefix "${prefix}" is not declared`, offset);
        return uri ?? null;
      };
      const seen = new Set<string>();
      const attributes: XmlAttribute[] = raw.map((attr) => {
        const namespace =
          attr.prefix === ''
            ? attr.name === 'xmlns'
              ? XMLNS_NAMESPACE
              : null
            : attr.prefix === 'xmlns'
              ? XMLNS_NAMESPACE
              : resolve(attr.prefix, attr.offset);
        const key = `${namespace ?? ''}\u0000${attr.prefix === 'xmlns' || attr.name === 'xmlns' ? attr.name : attr.local}`;
        if (seen.has(key)) fail('XML_DUPLICATE_ATTRIBUTE', `attribute ${attr.name} is given twice on <${name}>`, attr.offset);
        seen.add(key);
        return { name: attr.name, prefix: attr.prefix, local: attr.local, namespace, value: attr.value };
      });
      const where = locate(start);
      const element: MutableElement = {
        type: 'element',
        name,
        prefix: qualified.prefix,
        local: qualified.local,
        namespace: resolve(qualified.prefix, start + 1),
        attributes,
        children: [],
        line: where.line,
        column: where.column,
      };
      flushText();
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(element);
      else root = element;
      if (selfClosing) popBindings(declared);
      else {
        stack.push(element);
        declaredStack.push(declared);
      }
      return cursor;
    };

    for (;;) {
      if (at >= length) break;
      const lt = text.indexOf('<', at);
      const runEnd = lt < 0 ? length : lt;
      if (runEnd > at) {
        const run = text.slice(at, runEnd);
        if (stack.length === 0) {
          if (hasContent(run))
            fail(root ? 'XML_TRAILING_CONTENT' : 'XML_SYNTAX', 'text outside the root element', at + run.search(NOT_SPACE));
        } else {
          checkChars(run, at, 'text');
          if (run.includes(']]>')) fail('XML_SYNTAX', 'the sequence ]]> is not allowed in text', at + run.indexOf(']]>'));
          pendingText += decodeRefs(run, at, lineEnds);
        }
      }
      if (lt < 0) break;
      at = lt;
      const next = text.charCodeAt(at + 1);
      if (next === 0x2f) {
        const top = stack[stack.length - 1];
        const nameEnd = readName(at + 2);
        if (!top) fail(root ? 'XML_TRAILING_CONTENT' : 'XML_SYNTAX', 'an end tag without a start tag', at);
        const endName = text.slice(at + 2, nameEnd);
        const close = skipSpace(nameEnd);
        if (text.charCodeAt(close) !== 0x3e)
          fail(close >= length ? 'XML_UNCLOSED' : 'XML_SYNTAX', `the end tag </${endName}> is not closed with >`, at);
        if (top && endName !== top.name)
          fail('XML_MISMATCHED_TAG', `</${endName}> closes <${top.name}> (opened at line ${top.line}, column ${top.column})`, at);
        flushText();
        closeElement(stack.pop() as MutableElement);
        popBindings(declaredStack.pop() ?? []);
        at = close + 1;
      } else if (next === 0x21) {
        if (text.startsWith('<!--', at)) {
          const end = text.indexOf('-->', at + 4);
          if (end < 0) fail('XML_UNCLOSED', 'the comment is not closed with -->', at);
          const body = text.slice(at + 4, end);
          if (body.includes('--') || body.endsWith('-'))
            fail('XML_SYNTAX', 'a comment cannot contain --', at + 4 + (body.includes('--') ? body.indexOf('--') : body.length - 1));
          checkChars(body, at + 4, 'comment');
          at = end + 3;
        } else if (text.startsWith('<![CDATA[', at)) {
          if (stack.length === 0) fail(root ? 'XML_TRAILING_CONTENT' : 'XML_SYNTAX', 'CDATA outside the root element', at);
          const end = text.indexOf(']]>', at + 9);
          if (end < 0) fail('XML_UNCLOSED', 'the CDATA section is not closed with ]]>', at);
          const body = text.slice(at + 9, end);
          checkChars(body, at + 9, 'CDATA');
          pendingText += lineEnds(body);
          at = end + 3;
        } else if (text.startsWith('<!DOCTYPE', at)) {
          fail('XML_DTD_FORBIDDEN', 'a DOCTYPE / DTD is refused (no entity expansion, no external entities)', at);
        } else fail('XML_SYNTAX', 'unknown markup declaration', at);
      } else if (next === 0x3f) {
        const end = text.indexOf('?>', at + 2);
        if (end < 0) fail('XML_UNCLOSED', 'the processing instruction is not closed with ?>', at);
        const targetEnd = readName(at + 2);
        const target = text.slice(at + 2, targetEnd);
        if (targetEnd === at + 2 || (targetEnd < end && !isSpace(text.charCodeAt(targetEnd))))
          fail('XML_SYNTAX', 'a processing instruction needs a target name', at);
        if (target.toLowerCase() === 'xml') fail('XML_SYNTAX', 'the XML declaration is only allowed at the very start', at);
        checkChars(text.slice(at + 2, end), at + 2, 'processing instruction');
        at = end + 2;
      } else {
        if (root && stack.length === 0) fail('XML_TRAILING_CONTENT', 'a second root element', at);
        at = readStartTag(at);
        if (stack.length === 0 && root) closeElement(root);
      }
    }
    const open = stack[stack.length - 1];
    if (open) fail('XML_UNCLOSED', `<${open.name}> (line ${open.line}, column ${open.column}) is never closed`, length);
    if (!root) fail('XML_EMPTY', 'the text has no root element', length);
    return { root: root as unknown as XmlElement, ...(declaration ? { declaration } : {}) };
  };

  try {
    return { ok: true, ...parse() };
  } catch (error) {
    if (!(error instanceof XmlFailure)) throw error;
    return { ok: false, error: { code: error.code, message: error.message, offset: error.offset, ...locate(error.offset) } };
  }
}

/** Child elements of `element`, optionally those with the local name `local` (and namespace `namespace` when given). */
export function xmlChildren(element: XmlElement, local?: string, namespace?: string | null): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of element.children)
    if (
      child.type === 'element' &&
      (local === undefined || child.local === local) &&
      (namespace === undefined || child.namespace === namespace)
    )
      found.push(child);
  return found;
}

/** Value of the unprefixed attribute `name` (or the exact qualified name), or undefined. */
export function xmlAttr(element: XmlElement, name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.name === name)?.value;
}

/** Concatenated text of `element` and all its descendants, in document order. */
export function xmlText(element: XmlElement): string {
  let out = '';
  for (const child of element.children) out += child.type === 'text' ? child.value : xmlText(child);
  return out;
}
