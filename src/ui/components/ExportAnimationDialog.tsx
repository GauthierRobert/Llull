// "Export animation…" (PHY-22 MOV-M4): gathers the parameters of render_animation, shows its contact sheet as a preview and saves the video through
// the native File dialog. It dispatches the command and nothing else: no frame is drawn, no file encoded and no document edited here.

import React, { useId, useRef, useState } from 'react';
import { useStore } from '@ui/store';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { useAnimationExportStore } from '@ui/store/animationExportStore';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { type AnimationForm, animationParams, defaultAnimationForm, videoLengthOf } from '@ui/services/animationExportModel';
import { type AnimationWarning, renderAnimation, saveAnimationFile, videoFileOf } from '@ui/services/animationExport';
import { Icon } from './Icon';
import { ModalDialog } from './ModalDialog';
import { CameraFields, OutputFields, SourceFields } from './ExportAnimationFields';

const formatSeconds = (seconds: number): string => `${Number(seconds.toFixed(2))} s`;

/** The playback transport as the dialog sees it: where the bar is and what it plays. */
function TransportSummary(): React.ReactElement {
  const result = useDynamicsPlaybackStore((s) => s.result);
  const cursorTime = useDynamicsPlaybackStore((s) => s.cursorTime);
  const playing = useDynamicsPlaybackStore((s) => s.playing);
  const speed = useDynamicsPlaybackStore((s) => s.speed);
  return (
    <p className="export-animation__transport" data-testid="export-animation-transport">
      {result === null
        ? 'Transport: no simulation played yet. Pick a source below.'
        : `Transport: ${playing ? 'playing' : 'paused'} at ${formatSeconds(cursorTime)} of ${formatSeconds(result.duration)}, ${speed}× speed. The run and speed are prefilled.`}
    </p>
  );
}

function ExportAnimationForm({ onClose }: { onClose: () => void }): React.ReactElement {
  const document = useDocumentWithoutSelection();
  const [form, setForm] = useState<AnimationForm>(() => {
    const { result, speed } = useDynamicsPlaybackStore.getState();
    return defaultAnimationForm(useStore.getState().document, result === null ? null : { duration: result.duration, speed });
  });
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [sheetSrc, setSheetSrc] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly AnimationWarning[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const length = videoLengthOf(form);

  const update = (patch: Partial<AnimationForm>): void => {
    setForm((previous) => ({ ...previous, ...patch }));
    setSheetSrc(null);
    setWarnings([]);
    setNotice('');
  };

  const run = async (purpose: 'preview' | 'save'): Promise<void> => {
    const gathered = animationParams(form, document, purpose);
    setError('');
    setNotice('');
    if (!gathered.ok) {
      setError(gathered.message);
      return;
    }
    setBusy(purpose);
    const outcome = await renderAnimation(gathered.params);
    setBusy(null);
    if (!outcome.ok) {
      setError(outcome.summary);
      return;
    }
    if (purpose === 'preview') {
      const sheet = outcome.files.find((file) => file.fileName === 'sheet.png');
      setSheetSrc(sheet === undefined ? null : `data:image/png;base64,${sheet.base64}`);
      setWarnings(outcome.warnings);
      return;
    }
    const video = videoFileOf(outcome.files);
    if (video === undefined) {
      setError('The render returned no video file.');
      return;
    }
    saveAnimationFile(video);
    setWarnings(outcome.warnings);
    setNotice(`${video.fileName} is ready: choose where to save it in the file dialog.`);
  };

  return (
    <ModalDialog
      backdropClassName="shortcuts-backdrop"
      className="shortcuts-dialog export-animation"
      onClose={onClose}
      labelledBy={titleId}
      initialFocus={closeRef}
    >
      <div className="shortcuts-dialog__header">
        <h2 id={titleId} className="shortcuts-dialog__title">
          Export animation
        </h2>
        <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close export animation" title="Close">
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="export-animation__body">
        <TransportSummary />
        <div className="export-animation__columns">
          <div className="export-animation__form">
            <SourceFields form={form} update={update} />
            <CameraFields form={form} update={update} />
            <OutputFields form={form} update={update} />
          </div>
          <div className="export-animation__preview" aria-label="Preview" data-testid="export-animation-preview">
            {sheetSrc === null ? (
              <p className="export-animation__hint">
                Preview draws a contact sheet of the film at low resolution, so you can check the camera and the motion before saving.
              </p>
            ) : (
              <img src={sheetSrc} alt="Contact sheet of the animation" data-testid="export-animation-sheet" />
            )}
            {warnings.map((warning) => (
              <p key={`${warning.code}:${warning.message}`} className="export-animation__warning" data-testid="export-animation-warning">
                {warning.code}: {warning.message}
              </p>
            ))}
          </div>
        </div>
        {error !== '' && (
          <p className="export-animation__error" role="alert" data-testid="export-animation-error">
            {error}
          </p>
        )}
        {notice !== '' && (
          <p className="export-animation__notice" role="status" data-testid="export-animation-notice">
            {notice}
          </p>
        )}
      </div>
      <div className="export-animation__actions">
        <span className="export-animation__length" data-testid="export-animation-length">
          {length === null ? 'Check the numbers' : `${length.frames} frames · ${formatSeconds(length.seconds)} of video`}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={busy !== null}
          onClick={() => void run('preview')}
          data-testid="export-animation-preview-button"
        >
          {busy === 'preview' ? 'Rendering preview…' : 'Preview'}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy !== null}
          onClick={() => void run('save')}
          data-testid="export-animation-save"
        >
          {busy === 'save' ? 'Rendering…' : 'Save…'}
        </button>
      </div>
    </ModalDialog>
  );
}

export function ExportAnimationDialog(): React.ReactElement | null {
  const open = useAnimationExportStore((s) => s.open);
  const setOpen = useAnimationExportStore((s) => s.setOpen);
  if (!open) return null;
  return <ExportAnimationForm onClose={() => setOpen(false)} />;
}
