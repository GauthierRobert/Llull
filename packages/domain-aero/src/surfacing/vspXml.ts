/** A small tolerant XML reader for OpenVSP `.vsp3` text (elements, attributes, text; no DTD, no namespaces) and OpenVSP parameter lookup. */

export interface XmlNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

const MAX_DEPTH = 256;
const ENTITIES: Readonly<Record<string, string>> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const decode = (text: string): string => text.replace(/&(?:lt|gt|amp|quot|apos);/g, (match) => ENTITIES[match] ?? match);

const CONSTRUCTS = [
  ['<!--', '-->', 'comment'],
  ['<?', '?>', 'processing instruction'],
  ['<![CDATA[', ']]>', 'CDATA section'],
  ['<!DOCTYPE', '>', 'DOCTYPE'],
] as const;

/** Name of the first comment / instruction / CDATA / DOCTYPE without its closer, or null. One pass: each closer is searched once. */
function unterminatedConstruct(text: string): string | null {
  let at = text.indexOf('<');
  while (at >= 0) {
    const construct = CONSTRUCTS.find(([opener]) => text.startsWith(opener, at));
    if (construct === undefined) at = text.indexOf('<', at + 1);
    else {
      const end = text.indexOf(construct[1], at + construct[0].length);
      if (end < 0) return construct[2];
      at = text.indexOf('<', end + construct[1].length);
    }
  }
  return null;
}

/**
 * The element tree of `text`, or an error message. Comments, processing instructions and CDATA wrappers are skipped; attribute values may use
 * single or double quotes.
 * @invariant linear in the text: an unterminated comment / instruction / CDATA / DOCTYPE is refused up front (no rescanning per opener)
 */
export function parseXml(text: string): XmlNode | string {
  const open = unterminatedConstruct(text);
  if (open !== null) return `unterminated ${open}`;
  const root: XmlNode = { tag: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const token =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const match of text.matchAll(token)) {
    const [, cdata, closing, tag, attributes, selfClosing, chunk] = match;
    const top = stack[stack.length - 1] as XmlNode;
    if (cdata !== undefined) top.text += cdata;
    else if (chunk !== undefined) top.text += decode(chunk);
    else if (tag !== undefined && closing === '/') {
      if (stack.length < 2 || top.tag !== tag) return `unexpected closing tag </${tag}>`;
      stack.pop();
    } else if (tag !== undefined) {
      const attrs: Record<string, string> = {};
      for (const attribute of (attributes ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
        attrs[attribute[1] as string] = decode((attribute[2] ?? attribute[3]) as string);
      const node: XmlNode = { tag, attrs, children: [], text: '' };
      top.children.push(node);
      if (selfClosing !== '/') {
        stack.push(node);
        if (stack.length > MAX_DEPTH) return `elements nested deeper than ${MAX_DEPTH}`;
      }
    }
  }
  if (stack.length !== 1) return `unclosed element <${(stack[stack.length - 1] as XmlNode).tag}>`;
  return root.children.length === 1 ? (root.children[0] as XmlNode) : 'the text is not one XML document';
}

/** Every descendant element (depth first) satisfying `test`. */
export function findAll(node: XmlNode, test: (node: XmlNode) => boolean): XmlNode[] {
  return node.children.flatMap((child) => [...(test(child) ? [child] : []), ...findAll(child, test)]);
}

/**
 * Value of the OpenVSP parameter `name` under `node`: an element `<name Value="..."/>` or `<Parm Name="name" Value="..."/>`, taking the first
 * match (null when absent or not a number). The value is the `Value` attribute, else the element text.
 */
export function parameter(node: XmlNode, name: string): number | null {
  const [found] = findAll(node, (candidate) => candidate.tag === name || (candidate.tag === 'Parm' && candidate.attrs['Name'] === name));
  if (found === undefined) return null;
  const raw = (found.attrs['Value'] ?? found.text).trim();
  const value = raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}
