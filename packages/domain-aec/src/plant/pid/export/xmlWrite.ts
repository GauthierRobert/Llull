/** A minimal deterministic XML writer: elements with attributes only (DEXPI Proteus carries every value in an attribute), two-space indent, LF line ends. */

import { escapeXml } from '@lib/escapeXml';

export interface XNode {
  readonly name: string;
  readonly attrs: ReadonlyArray<readonly [string, string]>;
  readonly children: readonly XNode[];
}

export const el = (name: string, attrs: ReadonlyArray<readonly [string, string | undefined]>, children: readonly XNode[] = []): XNode => ({
  name,
  attrs: attrs.flatMap(([key, value]): Array<readonly [string, string]> => (value === undefined ? [] : [[key, value]])),
  children,
});

/** An attribute value as XML: illegal characters dropped, `& < > "` escaped, tab / line breaks as character references (a parser would turn them into spaces). */
export const xmlValue = (text: string): string => escapeXml(text).replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

/** Shortest round-trip decimal text of a finite number, `0` for -0. */
export const num = (value: number): string => (Object.is(value, -0) ? '0' : String(value));

/** The tree as text. Iterative (a deep tree cannot overflow the stack). */
export function writeXml(root: XNode): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n'];
  const stack: Array<{ node: XNode; depth: number; closing: boolean }> = [{ node: root, depth: 0, closing: false }];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const pad = '  '.repeat(top.depth);
    if (top.closing) {
      out.push(`${pad}</${top.node.name}>\n`);
      continue;
    }
    const attrs = top.node.attrs.map(([key, value]) => ` ${key}="${xmlValue(value)}"`).join('');
    if (top.node.children.length === 0) {
      out.push(`${pad}<${top.node.name}${attrs}/>\n`);
      continue;
    }
    out.push(`${pad}<${top.node.name}${attrs}>\n`);
    stack.push({ node: top.node, depth: top.depth, closing: true });
    for (let index = top.node.children.length - 1; index >= 0; index--)
      stack.push({ node: top.node.children[index] as XNode, depth: top.depth + 1, closing: false });
  }
  return out.join('');
}
