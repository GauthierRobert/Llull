/** Plant 04 PID M1 (VC-PID-15): the reader on the 12 real DEXPI files of the validation pack, and on truncated copies of them. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readXml, xmlChildren, type XmlElement } from '@lib/xmlRead';

const data = join(import.meta.dirname, '..', '..', '..', 'docs', 'plant', '04-pid-schematics', 'validation', 'data');
const files = [
  ...readdirSync(join(data, 'dexpi13')).map((name) => join(data, 'dexpi13', name)),
  join(data, 'dexpi20', 'reference_pid.xml'),
].filter((path) => path.endsWith('.xml'));

const countElements = (element: XmlElement): number => 1 + xmlChildren(element).reduce((sum, child) => sum + countElements(child), 0);

describe('readXml on the DEXPI validation files', () => {
  it('finds the 12 files', () => {
    expect(files).toHaveLength(12);
  });

  it.each(files)('%s: reads, and the element count equals the number of start tags', (path) => {
    const text = readFileSync(path, 'utf8');
    const result = readXml(text);
    if (!result.ok) throw new Error(`${result.error.code} ${result.error.line}:${result.error.column} ${result.error.message}`);
    const startTags = text.replace(/<!--[^]*?-->/g, '').match(/<[A-Za-z_][^>]*>/g) ?? [];
    expect(countElements(result.root)).toBe(startTags.length);
  });

  it.each(files)('%s: a copy cut in the middle is refused with a position', (path) => {
    const text = readFileSync(path, 'utf8');
    const result = readXml(text.slice(0, Math.floor(text.length / 2)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['XML_UNCLOSED', 'XML_SYNTAX']).toContain(result.error.code);
      expect(result.error.line).toBeGreaterThan(1);
    }
  });

  it('reads the complete reference P&ID within the budget (150 ms, doubled for a loaded machine)', () => {
    const text = readFileSync(join(data, 'dexpi13', 'C01V04-VER.EX01.xml'), 'utf8');
    readXml(text);
    const started = performance.now();
    expect(readXml(text).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(300);
  });
});
