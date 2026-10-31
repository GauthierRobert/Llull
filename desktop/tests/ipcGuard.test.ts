import { describe, expect, it } from 'vitest';
import { ipcSenderAllowed } from '../src/ipcGuard';

const ORIGIN = 'http://127.0.0.1:47827';
const main = { id: 1 };
const frame = (url: string, parent: unknown = null): { url: string; parent: unknown } => ({ url, parent });

describe('ipcSenderAllowed', () => {
  it('accepts the main frame of the app window loaded from the backend origin', () => {
    expect(ipcSenderAllowed({ sender: main, senderFrame: frame(`${ORIGIN}/#token=abc`) }, main, ORIGIN)).toBe(true);
  });

  it('refuses another window, a subframe, a page from another origin, a missing frame, an unparseable url and a missing window', () => {
    expect(ipcSenderAllowed({ sender: { id: 2 }, senderFrame: frame(`${ORIGIN}/`) }, main, ORIGIN)).toBe(false);
    expect(ipcSenderAllowed({ sender: main, senderFrame: frame(`${ORIGIN}/`, { frame: 'parent' }) }, main, ORIGIN)).toBe(false);
    expect(ipcSenderAllowed({ sender: main, senderFrame: frame('https://evil.example/') }, main, ORIGIN)).toBe(false);
    expect(ipcSenderAllowed({ sender: main, senderFrame: frame('http://127.0.0.1:9999/') }, main, ORIGIN)).toBe(false);
    expect(ipcSenderAllowed({ sender: main, senderFrame: null }, main, ORIGIN)).toBe(false);
    expect(ipcSenderAllowed({ sender: main, senderFrame: frame('not a url') }, main, ORIGIN)).toBe(false);
    expect(ipcSenderAllowed({ sender: main, senderFrame: frame(`${ORIGIN}/`) }, null, ORIGIN)).toBe(false);
  });
});
