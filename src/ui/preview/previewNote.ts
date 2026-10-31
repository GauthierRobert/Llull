// What the live-preview line of a command dialog says. The preview runs in the renderer on the renderer's own document: a stored (large) mesh and the
// native mesh engines exist only in the backend, so there the preview cannot run, which says nothing about the parameters; Run applies the command there.

/** Codes of a refusal that is about where the preview runs, not about the parameters. */
const HOST_ONLY = /MESH_ASSET_UNAVAILABLE|MESH_ENGINE_UNSUPPORTED|MESH_ENGINE_CAP_EXCEEDED/;

export interface PreviewNote {
  readonly label: 'Preview' | 'No preview here' | 'Preview unavailable';
  readonly text: string;
  /** A refusal of the parameters (shown as one); false for a preview and for the host-only case. */
  readonly refused: boolean;
}

/** @pure */
export function previewNote(outcome: { readonly ok: boolean; readonly summary: string }): PreviewNote {
  if (outcome.ok) return { label: 'Preview', text: outcome.summary, refused: false };
  if (HOST_ONLY.test(outcome.summary))
    return {
      label: 'No preview here',
      text: 'this mesh or operation lives in the backend (large mesh store, native mesh engine); Run applies the command there.',
      refused: false,
    };
  return { label: 'Preview unavailable', text: outcome.summary, refused: true };
}
