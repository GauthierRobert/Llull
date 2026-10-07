import { describe, it, expect, vi, afterEach } from 'vitest';

async function loadConfig(): Promise<typeof import('@ui/serverConfig')> {
  vi.resetModules();
  return import('@ui/serverConfig');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('serverConfig', () => {
  it('defaults to localhost:3001 with no auth header', async () => {
    vi.stubEnv('VITE_LLULL_SERVER_URL', '');
    vi.stubEnv('VITE_LLULL_API_TOKEN', '');
    const config = await loadConfig();
    expect(config.SERVER_BASE).toBe('http://localhost:3001');
    expect(config.serverAuthHeaders()).toEqual({});
  });

  it('reads the server URL from VITE_LLULL_SERVER_URL and strips trailing slashes', async () => {
    vi.stubEnv('VITE_LLULL_SERVER_URL', 'https://cad.example.com/api/');
    const config = await loadConfig();
    expect(config.SERVER_BASE).toBe('https://cad.example.com/api');
  });

  it('sends a bearer token when VITE_LLULL_API_TOKEN is set', async () => {
    vi.stubEnv('VITE_LLULL_API_TOKEN', 's3cret');
    const config = await loadConfig();
    expect(config.serverAuthHeaders()).toEqual({ Authorization: 'Bearer s3cret' });
  });

  it('builds the /live URL without a token by default', async () => {
    vi.stubEnv('VITE_LLULL_SERVER_URL', '');
    vi.stubEnv('VITE_LLULL_API_TOKEN', '');
    const config = await loadConfig();
    expect(config.liveStreamUrl()).toBe('http://localhost:3001/live');
  });

  it('appends an encoded access_token to the /live URL when a token is set', async () => {
    vi.stubEnv('VITE_LLULL_SERVER_URL', 'https://cad.example.com');
    vi.stubEnv('VITE_LLULL_API_TOKEN', 'a b&c');
    const config = await loadConfig();
    expect(config.liveStreamUrl()).toBe('https://cad.example.com/live?access_token=a%20b%26c');
  });
});
