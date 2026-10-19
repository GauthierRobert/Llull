/** SC-D3 in the desktop app: the main process's crash report (with the autosave as its document) and Help > Crash Reports. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crashReportsView, writeDesktopCrashReport } from '../src/crashes';

let dir = '';
let crashes = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-desktop-crash-'));
  crashes = path.join(dir, 'llull', 'crashes');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('desktop crash reports', () => {
  it('Help > Crash Reports with none: says so, no issue draft', () => {
    const view = crashReportsView(crashes);
    expect(view.message).toBe('No crash reports.');
    expect(view.issueUrl).toBe(null);
  });

  it('a main-process crash keeps the autosave as the document; the view drafts an issue for the newest report', () => {
    const autosavePath = path.join(dir, 'autosave.json');
    writeFileSync(autosavePath, '{"format":"llull-document","version":3,"document":{}}');
    const report = writeDesktopCrashReport(new TypeError('menu handler broke'), { directory: crashes, autosavePath, appVersion: '9.9.9' });
    if (report === null) throw new Error('no report');
    expect(readdirSync(report).sort()).toEqual(['commands.json', 'document.llull.json', 'error.txt', 'meta.json']);
    expect(readFileSync(path.join(report, 'document.llull.json'), 'utf8')).toContain('llull-document');
    expect(JSON.parse(readFileSync(path.join(report, 'meta.json'), 'utf8'))).toMatchObject({ source: 'desktop-main', appVersion: '9.9.9' });
    const view = crashReportsView(crashes);
    expect(view.message).toBe('1 crash report (the last 20 are kept).');
    expect(view.detail).toContain('TypeError: menu handler broke');
    expect(view.detail).toContain('nothing is sent automatically');
    expect(new URL(view.issueUrl ?? '').searchParams.get('title')).toBe('Crash: TypeError: menu handler broke');
  });

  it('without an autosave the report has the error only', () => {
    const report = writeDesktopCrashReport('plain failure', {
      directory: crashes,
      autosavePath: path.join(dir, 'missing.json'),
      appVersion: '1',
    });
    expect(readdirSync(report ?? '').sort()).toEqual(['error.txt', 'meta.json']);
  });
});
