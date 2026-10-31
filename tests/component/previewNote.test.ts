import { describe, expect, it } from 'vitest';
import { previewNote } from '@ui/preview/previewNote';

describe('previewNote', () => {
  it('a preview is a preview; a refusal of the parameters stays a refusal', () => {
    expect(previewNote({ ok: true, summary: 'add_box: 1 entity' })).toEqual({
      label: 'Preview',
      text: 'add_box: 1 entity',
      refused: false,
    });
    expect(previewNote({ ok: false, summary: 'fillet_edge: BLD_LAW_INVALID — size must be > 0' })).toMatchObject({
      label: 'Preview unavailable',
      refused: true,
    });
  });

  it('a refusal that is about where the preview runs (a stored mesh, a native mesh engine) is neutral, not a refusal of the parameters', () => {
    for (const code of ['MESH_ASSET_UNAVAILABLE', 'MESH_ENGINE_UNSUPPORTED', 'MESH_ENGINE_CAP_EXCEEDED']) {
      const note = previewNote({ ok: false, summary: `decimate_mesh: ${code} — entity 'mesh-1' is backed by mesh asset 62e7...; no-op.` });
      expect(note).toMatchObject({ label: 'No preview here', refused: false });
      expect(note.text).toContain('Run applies the command there');
    }
  });
});
