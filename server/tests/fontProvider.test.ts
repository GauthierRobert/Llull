import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getFontProvider, setFontProvider } from '@core/commands/fontPort';
import { createFontProvider, installFontProvider } from '../src/fontProvider';

afterEach(() => setFontProvider(null));

describe('the bundled font provider (03 WRP)', () => {
  it('lists Fira Sans and reads bytes that match the pinned hash', () => {
    const provider = createFontProvider();
    const [font] = provider.list();
    expect(font?.family).toBe('Fira Sans');
    const bytes = provider.bytes('fira-sans-regular');
    expect(bytes).not.toBeNull();
    expect(
      crypto
        .createHash('sha256')
        .update(bytes as Uint8Array)
        .digest('hex'),
    ).toBe(font?.sha256);
    expect(provider.bytes('missing')).toBeNull();
  });

  it('lists nothing from a folder without the file, and installs nothing then', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-fonts-'));
    try {
      expect(createFontProvider(empty).list()).toEqual([]);
      expect(installFontProvider({ LLULL_FONTS_DIR: empty })).toBe(false);
      expect(getFontProvider()).toBeNull();
      expect(installFontProvider({})).toBe(true);
      expect(getFontProvider()?.list()).toHaveLength(1);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('answers null when the file cannot be read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-fonts-'));
    try {
      fs.mkdirSync(path.join(dir, 'FiraSans-Regular.ttf'));
      expect(createFontProvider(dir).bytes('fira-sans-regular')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
