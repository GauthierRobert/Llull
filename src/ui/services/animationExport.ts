// Runs render_animation through the store (`dispatch`: the backend in the desktop app) and reads its files back from the command's `data`.
// Saving goes through `downloadBlob`: inside Electron that opens the native Save dialog (no path crosses into the page).

import { isRecord } from '@lib/isRecord';
import { useStore } from '@ui/store';
import { downloadBlob } from '@ui/download';

export interface AnimationFile {
  readonly fileName: string;
  readonly base64: string;
}

export interface AnimationWarning {
  readonly code: string;
  readonly message: string;
}

export type AnimationRender =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly files: readonly AnimationFile[];
      readonly warnings: readonly AnimationWarning[];
    }
  | { readonly ok: false; readonly summary: string };

const isFile = (value: unknown): value is AnimationFile =>
  isRecord(value) && typeof value['fileName'] === 'string' && typeof value['base64'] === 'string';

const isWarning = (value: unknown): value is AnimationWarning =>
  isRecord(value) && typeof value['code'] === 'string' && typeof value['message'] === 'string';

/** The `files` and `warnings` of a successful render_animation result; null for a refusal (no files). */
function parseRender(data: unknown): { files: AnimationFile[]; warnings: AnimationWarning[] } | null {
  if (!isRecord(data) || !Array.isArray(data['files'])) return null;
  const warnings = Array.isArray(data['warnings']) ? data['warnings'].filter(isWarning) : [];
  return { files: data['files'].filter(isFile), warnings };
}

/** One dispatch of render_animation; resolves with its files, or the command's own summary when it refused. */
export function renderAnimation(params: Record<string, unknown>): Promise<AnimationRender> {
  return new Promise((resolve) => {
    const { dispatch, clearLastMeasure } = useStore.getState();
    clearLastMeasure();
    dispatch('render_animation', params, {
      quiet: true,
      onResult: ({ summary }) => {
        const measured = useStore.getState().lastMeasure;
        const parsed = measured?.command === 'render_animation' ? parseRender(measured.data) : null;
        // the base64 result is large: it lives in the returned files only, not in the store
        if (measured?.command === 'render_animation') useStore.getState().clearLastMeasure();
        resolve(parsed === null ? { ok: false, summary } : { ok: true, summary, ...parsed });
      },
    });
  });
}

const MIME: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  gif: 'image/gif',
  apng: 'image/apng',
  png: 'image/png',
  json: 'application/json',
};

function bytesOfBase64(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

const mimeOfFile = (fileName: string): string => MIME[fileName.slice(fileName.lastIndexOf('.') + 1)] ?? 'application/octet-stream';

/** The one video file of a render (animation.mp4 / .gif / .apng), or undefined. */
export const videoFileOf = (files: readonly AnimationFile[]): AnimationFile | undefined =>
  files.find((file) => file.fileName.startsWith('animation.'));

/** Opens the Save dialog for a file the command returned. */
export function saveAnimationFile(file: AnimationFile): void {
  downloadBlob(new Blob([bytesOfBase64(file.base64)], { type: mimeOfFile(file.fileName) }), file.fileName);
}
