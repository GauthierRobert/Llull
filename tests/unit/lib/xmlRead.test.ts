/**
 * Plant 04 PID M1 (VC-PID-15): the pure XML reader. Well-formed documents of the DEXPI / Proteus shape, then every refusal with its code and
 * position, the safety limits (DTD, entities, depth, size, attributes) and hostile inputs that must stay fast.
 */

import { describe, expect, it } from 'vitest';
import { XMLNS_NAMESPACE, readXml, xmlAttr, xmlChildren, xmlText, type XmlElement, type XmlError } from '@lib/xmlRead';

function parsed(source: string): XmlElement {
  const result = readXml(source);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.message}`);
  return result.root;
}

function refused(source: string, limits?: Parameters<typeof readXml>[1]): XmlError {
  const result = readXml(source, limits);
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

describe('readXml: documents', () => {
  it('reads a Proteus-shaped document: declaration, attributes, nesting, positions', () => {
    const source = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<PlantModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="ProteusXML.xsd">',
      '  <PlantInformation SchemaVersion="4.1.1" Units="mm" />',
      '  <Equipment ID="T-1" ComponentClass="Tank"><Nozzle ID="N1"/></Equipment>',
      '</PlantModel>',
    ].join('\n');
    const result = readXml(source);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.declaration).toEqual({ version: '1.0', encoding: 'utf-8' });
    const root = result.root;
    expect(root.name).toBe('PlantModel');
    expect(root.namespace).toBeNull();
    expect([root.line, root.column]).toEqual([2, 1]);
    expect(xmlChildren(root).map((child) => child.name)).toEqual(['PlantInformation', 'Equipment']);
    const info = xmlChildren(root, 'PlantInformation')[0] as XmlElement;
    expect(xmlAttr(info, 'SchemaVersion')).toBe('4.1.1');
    expect([info.line, info.column]).toEqual([3, 3]);
    const equipment = xmlChildren(root, 'Equipment')[0] as XmlElement;
    expect(xmlChildren(equipment, 'Nozzle')).toHaveLength(1);
    expect(root.children.every((child) => child.type === 'element')).toBe(true);
  });

  it('resolves namespaces: default, prefixed, shadowed, undeclared and the xml prefix', () => {
    const root = parsed(
      '<a:Model xmlns:a="urn:a" xmlns="urn:d" xml:lang="en"><Plain/><a:Item xmlns:a="urn:b" a:key="1" id="2"/><Off xmlns=""><In/></Off></a:Model>',
    );
    expect(root.namespace).toBe('urn:a');
    expect(root.local).toBe('Model');
    expect(root.prefix).toBe('a');
    expect(xmlAttr(root, 'xml:lang')).toBe('en');
    expect(root.attributes.find((attribute) => attribute.name === 'xml:lang')?.namespace).toBe('http://www.w3.org/XML/1998/namespace');
    expect(root.attributes.find((attribute) => attribute.name === 'xmlns:a')?.namespace).toBe(XMLNS_NAMESPACE);
    const [plain, item, off] = xmlChildren(root);
    expect(plain?.namespace).toBe('urn:d');
    expect(item?.namespace).toBe('urn:b');
    expect(item?.attributes.find((attribute) => attribute.local === 'key')?.namespace).toBe('urn:b');
    expect(item?.attributes.find((attribute) => attribute.name === 'id')?.namespace).toBeNull();
    expect(off?.namespace).toBeNull();
    expect(xmlChildren(off as XmlElement)[0]?.namespace).toBeNull();
    expect(xmlChildren(root, 'Item', 'urn:b')).toHaveLength(1);
    expect(xmlChildren(root, 'Item', 'urn:zzz')).toHaveLength(0);
  });

  it('decodes the five entities and numeric references in text and attributes', () => {
    const root = parsed('<r v="a&lt;b&amp;c&quot;d&apos;e&gt;&#65;&#x42;&#x1F600;">x &lt; y &#38; &#x3E;</r>');
    expect(xmlAttr(root, 'v')).toBe('a<b&c"d\'e>AB\u{1F600}');
    expect(xmlText(root)).toBe('x < y & >');
  });

  it('does not decode twice: &amp;lt; stays the text &lt;', () => {
    expect(xmlText(parsed('<r>&amp;lt;</r>'))).toBe('&lt;');
  });

  it('merges CDATA and text, keeps its markup characters, drops comments and processing instructions', () => {
    const root = parsed('<r>a<!-- c -->b<![CDATA[<x>&amp; ]]>c<?pi data?>d<![CDATA[]]></r>');
    expect(root.children).toEqual([{ type: 'text', value: 'ab<x>&amp; cd' }]);
  });

  it('keeps text of leaf elements verbatim and drops whitespace between child elements', () => {
    const root = parsed('<r>\n  <a> </a>\n  <b>\n  keep\n  </b>\n</r>');
    expect(root.children).toHaveLength(2);
    expect(xmlText(xmlChildren(root, 'a')[0] as XmlElement)).toBe(' ');
    expect(xmlText(xmlChildren(root, 'b')[0] as XmlElement)).toBe('\n  keep\n  ');
  });

  it('keeps mixed content text next to elements', () => {
    const root = parsed('<p>one <b>two</b> three</p>');
    expect(root.children.map((child) => (child.type === 'text' ? child.value : child.name))).toEqual(['one ', 'b', ' three']);
    expect(xmlText(root)).toBe('one two three');
  });

  it('accepts both quote styles, spaces around =, > inside values, an empty value and an empty root', () => {
    const root = parsed(`<r a = "1" b='2' c="x>y" d="" e='say "hi"' f="it's"/>`);
    expect(root.attributes.map((attribute) => attribute.value)).toEqual(['1', '2', 'x>y', '', 'say "hi"', "it's"]);
  });

  it('normalises line ends and attribute white space', () => {
    const root = parsed('<r a="x\ty\nz&#10;w">l1\r\nl2\rl3</r>');
    expect(xmlAttr(root, 'a')).toBe('x y z\nw');
    expect(xmlText(root)).toBe('l1\nl2\nl3');
  });

  it('strips a byte-order mark and reads non-ASCII names and text', () => {
    const root = parsed('﻿<?xml version="1.1" standalone="yes"?><Pläne größe="Ø80 mm">日本語 – ü</Pläne>');
    expect(root.name).toBe('Pläne');
    expect(xmlAttr(root, 'größe')).toBe('Ø80 mm');
    expect(xmlText(root)).toBe('日本語 – ü');
    expect(readXml('﻿<?xml version="1.1" standalone="yes"?><a/>')).toMatchObject({ declaration: { version: '1.1', standalone: 'yes' } });
  });

  it('allows comments and processing instructions around the root, and a stylesheet PI named xml-…', () => {
    const root = parsed('<!-- head --><?xml-stylesheet href="s.css"?>\n<r/>\n<!-- tail -->\n');
    expect(root.name).toBe('r');
  });

  it('reads a self-closing root and a large flat document', () => {
    expect(parsed('<r/>').children).toEqual([]);
    const body = Array.from({ length: 20_000 }, (_, i) => `<i n="${i}"/>`).join('');
    expect(xmlChildren(parsed(`<r>${body}</r>`))).toHaveLength(20_000);
  });

  it('reports positions of elements by line and column', () => {
    const root = parsed('<r>\n\r\n   <deep/>\r  <next/></r>');
    const [deep, next] = xmlChildren(root);
    expect([deep?.line, deep?.column]).toEqual([3, 4]);
    expect([next?.line, next?.column]).toEqual([4, 3]);
  });
});

describe('readXml: refusals with code and position', () => {
  const cases: Array<[label: string, source: string, code: XmlError['code'], line: number, column: number]> = [
    ['empty text', '', 'XML_EMPTY', 1, 1],
    ['only whitespace and a comment', '  <!-- x -->  ', 'XML_EMPTY', 1, 15],
    ['text before the root', 'hello <r/>', 'XML_SYNTAX', 1, 1],
    ['no tag name', '<r><></r>', 'XML_SYNTAX', 1, 4],
    ['mismatched end tag', '<a>\n <b></a>', 'XML_MISMATCHED_TAG', 2, 5],
    ['unclosed element', '<a>\n<b>', 'XML_UNCLOSED', 2, 4],
    ['end tag without start', '</a>', 'XML_SYNTAX', 1, 1],
    ['second root', '<a/><b/>', 'XML_TRAILING_CONTENT', 1, 5],
    ['text after the root', '<a/>junk', 'XML_TRAILING_CONTENT', 1, 5],
    ['end tag after the root', '<a/></a>', 'XML_TRAILING_CONTENT', 1, 5],
    ['unquoted attribute', '<a b=1/>', 'XML_SYNTAX', 1, 6],
    ['attribute without value', '<a b/>', 'XML_SYNTAX', 1, 5],
    ['attributes without separating space', '<a b="1"c="2"/>', 'XML_SYNTAX', 1, 9],
    ['unterminated attribute value', '<a b="1/>', 'XML_UNCLOSED', 1, 6],
    ['< in an attribute value', '<a b="<"/>', 'XML_SYNTAX', 1, 7],
    ['duplicate attribute', '<a b="1" b="2"/>', 'XML_DUPLICATE_ATTRIBUTE', 1, 10],
    ['duplicate expanded attribute', '<a xmlns:p="u" xmlns:q="u" p:k="1" q:k="2"/>', 'XML_DUPLICATE_ATTRIBUTE', 1, 36],
    ['unbound element prefix', '<p:a/>', 'XML_NAMESPACE_UNBOUND', 1, 2],
    ['unbound attribute prefix', '<a p:b="1"/>', 'XML_NAMESPACE_UNBOUND', 1, 4],
    ['empty prefix binding', '<a xmlns:p=""/>', 'XML_SYNTAX', 1, 4],
    ['xmlns prefix declared', '<a xmlns:xmlns="u"/>', 'XML_SYNTAX', 1, 4],
    ['bad qualified name', '<a:b:c/>', 'XML_SYNTAX', 1, 2],
    ['undefined entity', '<a>&nbsp;</a>', 'XML_ENTITY_UNDEFINED', 1, 4],
    ['entity without semicolon', '<a>&amp</a>', 'XML_SYNTAX', 1, 4],
    ['character reference to NUL', '<a>&#0;</a>', 'XML_CHAR_INVALID', 1, 4],
    ['character reference to a surrogate', '<a>&#xD800;</a>', 'XML_CHAR_INVALID', 1, 4],
    ['character reference above U+10FFFF', '<a>&#x110000;</a>', 'XML_CHAR_INVALID', 1, 4],
    ['malformed character reference', '<a>&#12x;</a>', 'XML_CHAR_INVALID', 1, 4],
    ['control character in text', '<a>x\u0001</a>', 'XML_CHAR_INVALID', 1, 5],
    ['control character in an attribute', '<a b="\u0002"/>', 'XML_CHAR_INVALID', 1, 7],
    [']]> in text', '<a>x]]>y</a>', 'XML_SYNTAX', 1, 5],
    ['-- inside a comment', '<a><!-- a -- b --></a>', 'XML_SYNTAX', 1, 11],
    ['unclosed comment', '<a><!-- x </a>', 'XML_UNCLOSED', 1, 4],
    ['unclosed CDATA', '<a><![CDATA[x</a>', 'XML_UNCLOSED', 1, 4],
    ['CDATA outside the root', '<![CDATA[x]]><a/>', 'XML_SYNTAX', 1, 1],
    ['unclosed processing instruction', '<a><?pi x</a>', 'XML_UNCLOSED', 1, 4],
    ['processing instruction without a target', '<a><? x?></a>', 'XML_SYNTAX', 1, 4],
    ['XML declaration not first', '<a/><?xml version="1.0"?>', 'XML_SYNTAX', 1, 5],
    ['declaration without version', '<?xml encoding="utf-8"?><a/>', 'XML_SYNTAX', 1, 6],
    ['declaration with a bad standalone', '<?xml version="1.0" standalone="maybe"?><a/>', 'XML_SYNTAX', 1, 6],
    ['declaration with junk', '<?xml version="1.0" junk?><a/>', 'XML_SYNTAX', 1, 20],
    ['unclosed declaration', '<?xml version="1.0"<a/>', 'XML_UNCLOSED', 1, 1],
    ['unknown markup declaration', '<a><!ELEMENT x></a>', 'XML_SYNTAX', 1, 4],
    ['start tag cut off', '<a b="1"', 'XML_UNCLOSED', 1, 1],
    ['slash not followed by >', '<a / >', 'XML_SYNTAX', 1, 4],
    ['end tag not closed', '<a></a', 'XML_UNCLOSED', 1, 4],
    ['junk in an end tag', '<a></a x>', 'XML_SYNTAX', 1, 4],
  ];

  it.each(cases)('%s', (_label, source, code, line, column) => {
    const error = refused(source);
    expect({ code: error.code, line: error.line, column: error.column }).toEqual({ code, line, column });
    expect(error.message.length).toBeGreaterThan(5);
    expect(error.offset).toBeGreaterThanOrEqual(0);
  });

  it('counts lines across CR, LF and CRLF in the error position', () => {
    expect(refused('<a>\r\n\n\r<b></a></a>')).toMatchObject({ code: 'XML_MISMATCHED_TAG', line: 4, column: 4 });
  });

  it('positions an error after a BOM from the first character of the text', () => {
    expect(refused('﻿<a>&x;</a>')).toMatchObject({ code: 'XML_ENTITY_UNDEFINED', line: 1, column: 4 });
  });

  it('names both elements of a mismatch', () => {
    const error = refused('<a>\n <b></c></a>');
    expect(error.message).toContain('</c>');
    expect(error.message).toContain('<b>');
    expect(error.message).toContain('line 2');
  });
});

describe('readXml: safety', () => {
  it('refuses any DOCTYPE, so no entity can be declared or fetched (XXE)', () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>';
    expect(refused(xxe)).toMatchObject({ code: 'XML_DTD_FORBIDDEN', line: 1, column: 22 });
    expect(refused('<!DOCTYPE r SYSTEM "http://evil.example/r.dtd"><r/>').code).toBe('XML_DTD_FORBIDDEN');
    expect(refused('<!DOCTYPE html><r/>').code).toBe('XML_DTD_FORBIDDEN');
  });

  it('does not expand a billion-laughs payload: the entities are undefined and the output is never larger than the input', () => {
    const lol =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';
    expect(refused(lol).code).toBe('XML_DTD_FORBIDDEN');
    expect(refused('<lolz>&lol2;</lolz>').code).toBe('XML_ENTITY_UNDEFINED');
    const flood = `<r>${'&amp;'.repeat(100_000)}</r>`;
    const root = parsed(flood);
    expect(xmlText(root)).toBe('&'.repeat(100_000));
  });

  it('refuses nesting deeper than the limit and accepts exactly the limit', () => {
    const nest = (depth: number): string => '<a>'.repeat(depth) + '</a>'.repeat(depth);
    expect(refused(nest(257)).code).toBe('XML_TOO_DEEP');
    expect(readXml(nest(256)).ok).toBe(true);
    expect(refused(nest(11), { maxDepth: 10 }).code).toBe('XML_TOO_DEEP');
    expect(refused('<a>'.repeat(1_000_000)).code).toBe('XML_TOO_DEEP');
  });

  it('refuses text over the size limit and over the element limit', () => {
    expect(refused('<r>' + 'x'.repeat(100) + '</r>', { maxChars: 50 })).toMatchObject({ code: 'XML_TOO_LARGE', line: 1, column: 1 });
    expect(refused('<r><a/><a/><a/></r>', { maxElements: 3 }).code).toBe('XML_TOO_MANY_ELEMENTS');
    expect(readXml('<r><a/><a/></r>', { maxElements: 3 }).ok).toBe(true);
  });

  it('limits the attributes of one element, including namespace declarations', () => {
    const many = Array.from({ length: 11 }, (_, i) => ` a${i}="1"`).join('');
    expect(refused(`<r${many}/>`, { maxAttributes: 10 }).code).toBe('XML_TOO_MANY_ATTRIBUTES');
    expect(readXml(`<r${many}/>`, { maxAttributes: 11 }).ok).toBe(true);
    const declarations = Array.from({ length: 11 }, (_, i) => ` xmlns:p${i}="u${i}"`).join('');
    expect(refused(`<r${declarations}/>`, { maxAttributes: 10 }).code).toBe('XML_TOO_MANY_ATTRIBUTES');
  });

  it('refuses names longer than 1024 characters', () => {
    expect(refused(`<${'n'.repeat(1025)}/>`).code).toBe('XML_SYNTAX');
    expect(readXml(`<${'n'.repeat(1000)}/>`).ok).toBe(true);
  });

  it('handles hostile shapes in linear time', () => {
    const started = performance.now();
    for (const source of [
      '<r>' + '&'.repeat(200_000),
      '<r a="' + '&#x'.repeat(100_000),
      '<r>' + '<!--'.repeat(50_000),
      '<r>' + '<![CDATA['.repeat(20_000),
      '<' + 'a'.repeat(900) + ' ' + 'b="1" '.repeat(200_000),
      '<r>' + '<?'.repeat(100_000),
      '<r ' + Array.from({ length: 10 }, (_, i) => `xmlns:p${i}="u"`).join(' ') + '>' + '<p3:q/>'.repeat(50_000) + '</r',
      '<r>' + '<a b="1"/>'.repeat(100_000) + '</r',
    ])
      expect(readXml(source).ok).toBe(false);
    expect(readXml('<r>' + 'x]]'.repeat(100_000) + '</r>').ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('declared namespaces never leak to siblings', () => {
    const error = refused('<r><a xmlns:p="u"/><p:b/></r>');
    expect(error).toMatchObject({ code: 'XML_NAMESPACE_UNBOUND', line: 1, column: 21 });
  });

  it('never throws, whatever the text', () => {
    const noise = [
      '<',
      '<<',
      '<a',
      '<a b',
      '<a b=',
      '<a b="',
      '<!',
      '<!-',
      '<![',
      '<?',
      '<?x',
      '&',
      '</',
      '<a></',
      '\u0000',
      '<a>\u{D800}</a>',
      "<a b='\"'/>x",
    ];
    for (const source of noise) expect(() => readXml(source)).not.toThrow();
    expect(readXml('<a>\u{D800}</a>').ok).toBe(false);
  });
});

describe('readXml helpers', () => {
  it('xmlAttr finds by qualified name, xmlChildren filters by local name, xmlText joins descendants', () => {
    const root = parsed('<r k="v"><x>1</x><y>2<x>3</x></y></r>');
    expect(xmlAttr(root, 'k')).toBe('v');
    expect(xmlAttr(root, 'missing')).toBeUndefined();
    expect(xmlChildren(root, 'x')).toHaveLength(1);
    expect(xmlChildren(root)).toHaveLength(2);
    expect(xmlText(root)).toBe('123');
  });
});
