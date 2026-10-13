import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchLicenseLabel, fetchStepExport, uploadDwg } from '@ui/services/serverFiles';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('serverFiles', () => {
  it('fetchStepExport returns the STEP blob on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ISO-10303-21;')));
    const result = await fetchStepExport('my part');
    expect(result.ok).toBe(true);
    if (result.ok) expect(await result.blob.text()).toBe('ISO-10303-21;');
    const fetchMock = vi.mocked(fetch);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/export\/step\?name=my%20part$/);
  });
  it('fetchStepExport reports the server error, the HTTP status, or the offline hint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'No Python.' }, 503)));
    expect(await fetchStepExport('m')).toEqual({ ok: false, message: 'No Python.' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oops', { status: 500 })));
    expect(await fetchStepExport('m')).toEqual({ ok: false, message: 'STEP export failed (HTTP 500).' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('refused')));
    const offline = await fetchStepExport('m');
    expect(offline.ok).toBe(false);
    expect(offline.message).toMatch(/needs the llull server/);
  });
  it('uploadDwg posts the bytes with target, unit and survey name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ summary: 'Imported 3 lines.' })));
    const file = new File(['AC1032'], 'site.dwg');
    expect(await uploadDwg(file, 'survey', 'm')).toBe('Imported 3 lines.');
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/import\/dwg\?target=survey&sourceUnit=m&name=site$/);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(file);
  });
  it('uploadDwg reports failures', async () => {
    const file = new File(['x'], 'a.dwg');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Bad magic.' }, 400)));
    expect(await uploadDwg(file, 'drawing', 'mm')).toBe('Bad magic.');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({})));
    expect(await uploadDwg(file, 'drawing', 'mm')).toBe('DWG imported.');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('refused')));
    expect(await uploadDwg(file, 'drawing', 'mm')).toMatch(/needs the llull server/);
  });
  it('fetchLicenseLabel returns the label, or null on any failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ label: 'Evaluation' })));
    expect(await fetchLicenseLabel()).toBe('Evaluation');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ label: 3 })));
    expect(await fetchLicenseLabel()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 500)));
    expect(await fetchLicenseLabel()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('refused')));
    expect(await fetchLicenseLabel()).toBeNull();
  });
});
