/** `--save` of a render_animation result (PHY-22 MOV TR-MOV-17, VC-MOV-22): the extension of the target picks the file; a directory takes all. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveDataFiles } from '../src/cli/saveFiles';

const b64 = (text: string): string => Buffer.from(text).toString('base64');
const data = (video: { fileName: string; content: string }): unknown => ({
  files: [
    { fileName: video.fileName, base64: b64(video.content) },
    { fileName: 'timeline.json', base64: b64('{"frames":2}') },
    { fileName: 'sheet.png', base64: b64('SHEET') },
  ],
});
const frames = (): unknown => ({
  files: [
    { fileName: 'frame-0001.png', base64: b64('F1') },
    { fileName: 'frame-0002.png', base64: b64('F2') },
    { fileName: 'timeline.json', base64: b64('{}') },
  ],
});

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-save-animation-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const at = (...parts: string[]): string => path.join(dir, ...parts);

describe('--save <file with an extension> (VC-MOV-22)', () => {
  it('writes the mp4 and out.timeline.json beside it, not a directory named out.mp4', () => {
    const saved = saveDataFiles(data({ fileName: 'animation.mp4', content: 'MP4' }), at('out.mp4'));
    expect(saved.map((file) => path.basename(file.path))).toEqual(['out.mp4', 'out.timeline.json']);
    expect(readFileSync(at('out.mp4'), 'utf8')).toBe('MP4');
    expect(readFileSync(at('out.timeline.json'), 'utf8')).toBe('{"frames":2}');
    expect(readdirSync(dir).sort()).toEqual(['out.mp4', 'out.timeline.json']);
  });

  it('picks .gif and .apng by extension and creates the folder of the target', () => {
    saveDataFiles(data({ fileName: 'animation.gif', content: 'GIF' }), at('deep', 'x.gif'));
    expect(readFileSync(at('deep', 'x.gif'), 'utf8')).toBe('GIF');
    expect(existsSync(at('deep', 'x.timeline.json'))).toBe(true);
    saveDataFiles(data({ fileName: 'animation.apng', content: 'APNG' }), at('y.APNG'));
    expect(readFileSync(at('y.APNG'), 'utf8')).toBe('APNG');
  });

  it('writes the contact sheet alone for a .png target', () => {
    const saved = saveDataFiles(data({ fileName: 'animation.mp4', content: 'MP4' }), at('sheet.png'));
    expect(saved).toHaveLength(1);
    expect(readFileSync(at('sheet.png'), 'utf8')).toBe('SHEET');
    expect(readdirSync(dir)).toEqual(['sheet.png']);
  });

  it('writes every file into a directory target (trailing slash, existing directory or no extension)', () => {
    saveDataFiles(data({ fileName: 'animation.mp4', content: 'MP4' }), `${at('all')}/`);
    expect(readdirSync(at('all')).sort()).toEqual(['animation.mp4', 'sheet.png', 'timeline.json']);
    mkdirSync(at('existing.d'));
    saveDataFiles(data({ fileName: 'animation.mp4', content: 'MP4' }), at('existing.d'));
    expect(readdirSync(at('existing.d'))).toContain('animation.mp4');
    saveDataFiles(frames(), at('plain'));
    expect(readdirSync(at('plain')).sort()).toEqual(['frame-0001.png', 'frame-0002.png', 'timeline.json']);
  });

  it('names what the result has when the extension asks for a file it lacks', () => {
    expect(() => saveDataFiles(data({ fileName: 'animation.apng', content: 'A' }), at('out.mp4'))).toThrow(
      /no \.mp4 file.*format "mp4".*animation\.apng/,
    );
    expect(() => saveDataFiles(frames(), at('sheet.png'))).toThrow(/no sheet\.png.*sheet/);
    expect(existsSync(at('out.mp4'))).toBe(false);
  });

  it('leaves other results alone: several files with an unrelated extension keep the generic directory save', () => {
    const other = {
      files: [
        { fileName: 'a.txt', base64: b64('a') },
        { fileName: 'b.txt', base64: b64('b') },
      ],
    };
    saveDataFiles(other, at('out.mp4'));
    expect(readdirSync(at('out.mp4')).sort()).toEqual(['a.txt', 'b.txt']);
  });
});
