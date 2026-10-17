/** `llull` CLI pure helpers: argv parsing, params sources, catalog views, file payload extraction. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { booleanFlag, missingValueFlag, paramsSource, parseArgv, stringFlag } from '../src/cli/argv';
import { describeCommand, listCatalog, searchCatalog, shortDescription, suggestNames, toolsetCounts } from '../src/cli/catalog';
import { filesOfData, saveDataFiles, withoutPayloads, withSaveDefaults } from '../src/cli/saveFiles';
import { imageDataUrl, resolveImageRefs } from '../src/cli/imageParams';
import { listCommands } from '@core/commands/registry';
import { exchangeToolDefinitions } from '../src/cli/exchange';

describe('parseArgv', () => {
  it('splits positionals, value flags, boolean flags and --k=v', () => {
    const parsed = parseArgv(['exec', 'add_box', '--doc', 'a.json', '--json', 'size=[1,1,1]', '--save=x.stl']);
    expect(parsed.positionals).toEqual(['exec', 'add_box', 'size=[1,1,1]']);
    expect(stringFlag(parsed, 'doc')).toBe('a.json');
    expect(stringFlag(parsed, 'save')).toBe('x.stl');
    expect(booleanFlag(parsed, 'json')).toBe(true);
    expect(booleanFlag(parsed, 'quiet')).toBe(false);
  });

  it('treats -h as --help, -- as end of flags, and a trailing value flag as true', () => {
    const parsed = parseArgv(['-h', 'run', '--', '--literal', '--doc']);
    expect(booleanFlag(parsed, 'help')).toBe(true);
    expect(parsed.positionals).toEqual(['run', '--literal', '--doc']);
    expect(stringFlag(parseArgv(['--doc']), 'doc')).toBeUndefined();
    expect(booleanFlag(parseArgv(['--json=false']), 'json')).toBe(false);
  });
});

describe('paramsSource', () => {
  it('parses key=value pairs as JSON when possible', () => {
    expect(paramsSource(['size=[1,2,3]', 'name=lid', 'n=4', 'on=true'])).toEqual({
      kind: 'pairs',
      params: { size: [1, 2, 3], name: 'lid', n: 4, on: true },
    });
    expect(paramsSource([])).toEqual({ kind: 'pairs', params: {} });
  });

  it('recognises a JSON literal, @file and stdin', () => {
    expect(paramsSource(['{"a":1}'])).toEqual({ kind: 'json', text: '{"a":1}' });
    expect(paramsSource(['@p.json'])).toEqual({ kind: 'file', path: 'p.json' });
    expect(paramsSource(['-'])).toEqual({ kind: 'stdin' });
  });

  it('keeps string-typed keys raw', () => {
    expect(paramsSource(['name=123', 'n=123'], new Set(['name']))).toEqual({ kind: 'pairs', params: { name: '123', n: 123 } });
  });

  it('finds a value flag given without its value', () => {
    expect(missingValueFlag(parseArgv(['exec', 'x', '--save']))).toBe('save');
    expect(missingValueFlag(parseArgv(['--server', '--json']))).toBe('server');
    expect(missingValueFlag(parseArgv(['--save', 'a.stl', '--json']))).toBeUndefined();
  });

  it('rejects a token that is not key=value', () => {
    expect(() => paramsSource(['width', '10'])).toThrow(/not key=value/);
  });
});

describe('imageParams', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  it('sniffs png / jpeg from magic bytes and rejects anything else', () => {
    expect(imageDataUrl(png, 'a')).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(imageDataUrl(jpeg, 'b')).toMatch(/^data:image\/jpeg;base64,/);
    expect(() => imageDataUrl(Buffer.from('GIF89a'), 'c.gif')).toThrow(/c\.gif is not a PNG/);
  });

  it('replaces only top-level "@img:" strings of an object', () => {
    const read = (file: string): Buffer => (file === 'scan.jpg' ? jpeg : png);
    const resolved = resolveImageRefs({ dataUrl: '@img:scan.jpg', name: 'scan', nested: { dataUrl: '@img:x.png' }, n: 2 }, read) as Record<
      string,
      unknown
    >;
    expect(resolved['dataUrl']).toMatch(/^data:image\/jpeg;base64,/);
    expect(resolved['name']).toBe('scan');
    expect(resolved['nested']).toEqual({ dataUrl: '@img:x.png' });
    expect(resolved['n']).toBe(2);
    expect(resolveImageRefs(['@img:a.png'], read)).toEqual(['@img:a.png']);
    expect(resolveImageRefs(null, read)).toBeNull();
  });
});

describe('catalog', () => {
  it('lists every registry command and exchange tool exactly once, filterable by toolset', () => {
    const all = listCatalog();
    expect(all).toHaveLength(listCommands().length + exchangeToolDefinitions().length);
    expect(new Set(all.map((entry) => entry.name)).size).toBe(all.length);
    const twoD = listCatalog('2d');
    expect(twoD.length).toBeGreaterThan(0);
    expect(twoD.every((entry) => entry.toolset === '2d')).toBe(true);
    expect(toolsetCounts().reduce((sum, c) => sum + c.commands, 0)).toBe(all.length);
  });

  it('searches registry commands only (no MCP-only discovery tools)', () => {
    const hits = searchCatalog('fillet edge', 5);
    expect(hits[0]?.name).toBe('fillet_edge');
    expect(searchCatalog('search tools toolset', 20).map((h) => h.name)).not.toContain('search_tools');
  });

  it('describes a command with its params, and null for an unknown one', () => {
    const described = describeCommand('add_box');
    expect(described?.text).toMatch(/- size \(number\[\], required\)/);
    expect(described?.json).toMatchObject({ name: 'add_box', toolset: '3d' });
    expect(describeCommand('nope')).toBeNull();
    expect(suggestNames('add_bx')).toContain('add_box');
  });

  it('shortens descriptions to the first sentence, capped', () => {
    expect(shortDescription('One. Two.')).toBe('One.');
    expect(shortDescription('x'.repeat(300))).toHaveLength(110);
  });
});

describe('saveFiles', () => {
  const dir = (): string => mkdtempSync(path.join(tmpdir(), 'llull-cli-save-'));

  it('extracts base64, text and multi-file payloads', () => {
    expect(filesOfData({ stlBase64: Buffer.from('ab').toString('base64') })[0]?.bytes.toString()).toBe('ab');
    expect(filesOfData({ text: 'code', fileName: 'm.py' })).toEqual([{ name: 'm.py', bytes: Buffer.from('code') }]);
    expect(filesOfData({ files: [{ name: 'a.nc1', content: 'A' }, { name: 'b.nc1', content: 'B' }, 3] })).toHaveLength(2);
    expect(filesOfData({ count: 1 })).toEqual([]);
    expect(filesOfData('text')).toEqual([]);
  });

  it('writes one file to a path, several files into a directory', () => {
    const root = dir();
    const single = saveDataFiles({ step: 'ISO-10303' }, path.join(root, 'nested', 'p.step'));
    expect(readFileSync(single[0]?.path ?? '', 'utf8')).toBe('ISO-10303');
    const many = saveDataFiles({ files: [{ name: 'a.nc1', content: 'A' }, { content: 'B' }] }, path.join(root, 'nc'));
    expect(many.map((f) => path.basename(f.path))).toEqual(['a.nc1', 'file-2']);
    const intoDir = saveDataFiles({ text: 'x', fileName: 'm.scad' }, `${root}/`);
    expect(intoDir[0]?.path).toBe(path.join(root, 'm.scad'));
  });

  it('rasterizes svg for a .png target and fails clearly without a payload', () => {
    const root = dir();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    const [png] = saveDataFiles({ svg, width: 20 }, path.join(root, 'v.png'));
    expect(
      readFileSync(png?.path ?? '')
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    expect(() => saveDataFiles({ count: 1 }, path.join(root, 'x.png'))).toThrow(/no data.svg/);
    expect(() => saveDataFiles({ svg: 'not svg', text: 'x' }, path.join(root, 'bad.png'))).toThrow(/no data.svg that rasterizes/);
    expect(existsSync(path.join(root, 'bad.png'))).toBe(false);
    expect(() => saveDataFiles({ count: 1 }, path.join(root, 'x.txt'))).toThrow(/no file payload/);
    expect(existsSync(path.join(root, 'x.txt'))).toBe(false);
  });

  it('saves dxf / ifc / step text payloads and civil svg held in data.text (also to .png)', () => {
    const root = dir();
    const [dxf] = saveDataFiles({ partId: 'p', filename: 'p_flat.dxf', dxf: '0\nSECTION' }, path.join(root, 'part.dxf'));
    expect(readFileSync(dxf?.path ?? '', 'utf8')).toBe('0\nSECTION');
    expect(filesOfData({ dxf: 'D', filename: 'a.dxf' })[0]?.name).toBe('a.dxf');
    expect(filesOfData({ ifc: 'ISO-10303-21;' })).toHaveLength(1);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    const [png] = saveDataFiles({ text: svg, fileName: 'civil.svg' }, path.join(root, 'civil.png'));
    expect(
      readFileSync(png?.path ?? '')
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    expect(() => saveDataFiles({ text: 'LandXML' }, path.join(root, 'land.png'))).toThrow(/no data.svg/);
  });

  it('picks export_gltf binary from the --save extension unless the caller set it', () => {
    expect(withSaveDefaults('export_gltf', { entityIds: ['a'] }, 'x.glb')).toEqual({ entityIds: ['a'], binary: true });
    expect(withSaveDefaults('export_gltf', {}, 'x.GLTF')).toEqual({ binary: false });
    expect(withSaveDefaults('export_gltf', { binary: false }, 'x.glb')).toEqual({ binary: false });
    expect(withSaveDefaults('export_gltf', {}, 'x.bin')).toEqual({});
    expect(withSaveDefaults('export_gltf', {}, undefined)).toEqual({});
    expect(withSaveDefaults('export_stl', {}, 'x.glb')).toEqual({});
  });

  it('replaces payloads with size markers, recursing into files[]', () => {
    expect(withoutPayloads({ text: 'abc', count: 2, files: [{ content: 'xy', name: 'a' }] })).toEqual({
      text: '<3 chars, saved>',
      count: 2,
      files: [{ content: '<2 chars, saved>', name: 'a' }],
    });
    expect(withoutPayloads(5)).toBe(5);
  });
});
