/**
 * Plant 04 PID M1 review fixes for the XML reader: namespace scopes in linear time and memory, error positions after CRLF, comment error offsets,
 * reserved namespace URIs, unpaired surrogates.
 */

import { describe, expect, it } from 'vitest';
import { readXml, xmlAttr, xmlText } from '@lib/xmlRead';

function failure(source: string, limits?: Parameters<typeof readXml>[1]): { code: string; line: number; column: number } {
  const result = readXml(source, limits);
  if (result.ok) throw new Error('expected a refusal');
  const { code, line, column } = result.error;
  return { code, line, column };
}

describe('readXml: namespace scopes', () => {
  it('resolves, shadows and restores bindings across siblings and nesting', () => {
    const result = readXml('<r xmlns:p="u1"><a xmlns:p="u2" xmlns="d"><p:x/></a><p:y/><b xmlns=""><c/></b></r>');
    if (!result.ok) throw new Error(result.error.message);
    const [a, y, b] = result.root.children;
    expect(a).toMatchObject({ namespace: 'd' });
    expect(y).toMatchObject({ local: 'y', namespace: 'u1' });
    expect(b).toMatchObject({ namespace: null });
    expect(a && a.type === 'element' && a.children[0]).toMatchObject({ local: 'x', namespace: 'u2' });
  });

  it('keeps 1000 inherited prefixes and 40 000 declaring children in linear time', () => {
    const root = Array.from({ length: 1000 }, (_, i) => ` xmlns:p${i}="u${i}"`).join('');
    const started = performance.now();
    const result = readXml(`<r${root}>${'<c xmlns:q="u"/>'.repeat(40_000)}</r>`);
    expect(result.ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('refuses 250 nested elements declaring 1000 prefixes each by the total declaration limit, quickly', () => {
    const declarations = Array.from({ length: 1000 }, (_, i) => ` xmlns:p${i}="u${i}"`).join('');
    const started = performance.now();
    const source = `<e${declarations}>`.repeat(250) + '</e>'.repeat(250);
    expect(failure(source).code).toBe('XML_TOO_MANY_NAMESPACES');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('reads the same nesting when the limit is raised, still in linear time and memory', () => {
    const declarations = Array.from({ length: 400 }, (_, i) => ` xmlns:p${i}="u${i}"`).join('');
    const started = performance.now();
    const source = `<e${declarations}>`.repeat(250) + '</e>'.repeat(250);
    expect(readXml(source, { maxNamespaceDeclarations: 200_000 }).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('counts every declaration, default ones too', () => {
    expect(failure('<r xmlns="a"><c xmlns="b"/></r>', { maxNamespaceDeclarations: 1 }).code).toBe('XML_TOO_MANY_NAMESPACES');
    expect(readXml('<r xmlns="a"><c xmlns="b"/></r>', { maxNamespaceDeclarations: 2 }).ok).toBe(true);
  });

  it('refuses the XML and xmlns namespace URIs bound to the wrong prefix', () => {
    const xml = 'http://www.w3.org/XML/1998/namespace';
    const xmlns = 'http://www.w3.org/2000/xmlns/';
    expect(failure(`<a xmlns:p="${xml}"/>`).code).toBe('XML_SYNTAX');
    expect(failure(`<a xmlns="${xml}"/>`).code).toBe('XML_SYNTAX');
    expect(failure(`<a xmlns:p="${xmlns}"/>`).code).toBe('XML_SYNTAX');
    expect(failure(`<a xmlns="${xmlns}"/>`).code).toBe('XML_SYNTAX');
    expect(readXml(`<a xmlns:xml="${xml}"/>`).ok).toBe(true);
  });
});

describe('readXml: error positions', () => {
  it('counts CRLF in text before a bad reference', () => {
    expect(failure('<a>\r\n\r\n\r\n&bad;</a>')).toEqual({ code: 'XML_ENTITY_UNDEFINED', line: 4, column: 1 });
    expect(failure('<a>x\rx\ny&#0;</a>')).toEqual({ code: 'XML_CHAR_INVALID', line: 3, column: 2 });
  });

  it('counts CRLF and tabs in an attribute value before a bad reference', () => {
    expect(failure('<a b="x\r\ny\tz&bad;"/>')).toEqual({ code: 'XML_ENTITY_UNDEFINED', line: 2, column: 4 });
  });

  it('does not normalise a decoded character reference', () => {
    const result = readXml('<a b="&#13;&#9;x">&#13;</a>');
    if (!result.ok) throw new Error(result.error.message);
    expect(xmlAttr(result.root, 'b')).toBe('\r\tx');
    expect(xmlText(result.root)).toBe('\r');
  });

  it('points a comment ending in --- at the last dash of the body', () => {
    expect(failure('<a><!--a---></a>')).toEqual({ code: 'XML_SYNTAX', line: 1, column: 9 });
    expect(failure('<a><!--a--b--></a>')).toEqual({ code: 'XML_SYNTAX', line: 1, column: 9 });
  });
});

describe('readXml: unpaired surrogates', () => {
  it('refuses a lone high or low surrogate in text, attributes, comments and CDATA, and keeps a pair', () => {
    expect(failure('<a>x\uD800y</a>')).toEqual({ code: 'XML_CHAR_INVALID', line: 1, column: 5 });
    expect(failure('<a>\uDC00</a>').code).toBe('XML_CHAR_INVALID');
    expect(failure('<a>\uD800').code).toBe('XML_CHAR_INVALID');
    expect(failure('<a b="\uD800"/>').code).toBe('XML_CHAR_INVALID');
    expect(failure('<a><!--\uDFFF--></a>').code).toBe('XML_CHAR_INVALID');
    expect(failure('<a><![CDATA[\uD800]]></a>').code).toBe('XML_CHAR_INVALID');
    expect(readXml('<a b="\u{1F600}">\u{1F600}</a>').ok).toBe(true);
  });
});
